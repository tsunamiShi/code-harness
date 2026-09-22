import { AsyncLocalStorage } from 'node:async_hooks'

import OpenAI from 'openai'
import type {
  FunctionTool,
  Response as ModelResponse,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import type {
  Message,
  Model,
  ModelAttemptEvent,
  ModelOutput,
  ModelUsage,
  ToolDescription,
} from '../runtime/types.ts'

export interface OpenAICompatibleResponsesModelOptions {
  apiKey: string
  baseURL: string
  model: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

interface AttemptContext {
  attempts: ProviderAttemptStateMachine
}

/** OpenAI-compatible Responses API adapter for the Runtime's Model interface. */
export class OpenAICompatibleResponsesModel implements Model {
  private readonly client: OpenAI
  private readonly attemptContext = new AsyncLocalStorage<AttemptContext>()
  readonly descriptor

  constructor(private readonly options: OpenAICompatibleResponsesModelOptions) {
    const maxRetries = options.maxRetries ?? 1
    const provider = new URL(options.baseURL).hostname
    const baseFetch = options.fetch ?? globalThis.fetch
    this.descriptor = {
      provider,
      model: options.model,
      protocol: 'openai-responses',
      ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
      maxRetries,
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      maxRetries,
      fetch: async (input, init) => await this.observedFetch(baseFetch, input, init),
    })
  }

  async generate(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
    maxTokens?: number
    previousResponseId?: string
    onAttempt?: (event: ModelAttemptEvent) => Promise<void>
  }): Promise<ModelOutput> {
    const attempts = new ProviderAttemptStateMachine(input.onAttempt)
    let response: ModelResponse
    try {
      response = await this.attemptContext.run(
        { attempts },
        async () => {
          const stream = await this.client.responses.create({
            model: this.options.model,
            input: input.messages.flatMap(toProviderInput),
            stream: true,
            ...(input.previousResponseId === undefined
              ? {}
              : { previous_response_id: input.previousResponseId }),
            ...(input.maxTokens === undefined ? {} : { max_output_tokens: input.maxTokens }),
            ...(input.tools.length === 0
              ? {}
              : {
                  tools: input.tools.map(toProviderTool),
                  parallel_tool_calls: true,
                }),
          })
          let terminalResponse: ModelResponse | undefined
          for await (const event of stream) {
            await attempts.receiveEvent(event)
            if (
              event.type === 'response.completed'
              || event.type === 'response.incomplete'
              || event.type === 'response.failed'
            ) {
              terminalResponse = event.response
            }
          }
          if (terminalResponse === undefined) {
            throw new Error('Model provider ended the SSE stream without a terminal response event')
          }
          await attempts.complete()
          return terminalResponse
        },
      )
    } catch (error: unknown) {
      await attempts.failCurrent(error)
      throw error
    }

    const requestId = attempts.completedProviderRequestId
    if (response.error !== null && response.error !== undefined) {
      throw new Error(`Model provider failed the response: ${response.error.message}`)
    }
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason
      if (reason === 'max_output_tokens') {
        throw new Error(input.maxTokens === undefined
          ? 'Model response reached the provider output token limit before completing'
          : `Model response reached the ${input.maxTokens}-token output limit before completing`)
      }
      throw new Error(`Model provider returned an incomplete response${reason ? `: ${reason}` : ''}`)
    }
    if (response.status === 'failed' || response.status === 'cancelled') {
      throw new Error(`Model provider returned response status: ${response.status}`)
    }

    const usage = readUsage(response)
    const metadata = {
      providerResponseId: response.id,
      ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      ...(response.status === undefined ? {} : { finishReason: response.status }),
      ...(usage === undefined ? {} : { usage }),
    }
    const calls = response.output.filter(item => item.type === 'function_call')
    const reasoningContent = readReasoningContent(response)
    const content = readOutputText(response)

    if (calls.length > 0) {
      return {
        kind: 'tool-calls',
        calls: calls.map(call => ({
          id: call.call_id,
          name: call.name,
          arguments: parseArguments(call.arguments),
        })),
        ...(content === undefined ? {} : { content }),
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
        metadata,
      }
    }

    if (content === undefined) {
      throw new Error('Model provider returned neither a function call nor output text')
    }
    return {
      kind: 'final',
      content,
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
      metadata,
    }
  }

  private async observedFetch(
    fetch_: typeof globalThis.fetch,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const attempts = this.attemptContext.getStore()?.attempts
    if (!attempts) return await fetch_(input, init)

    await attempts.start()
    let response: Response
    try {
      response = await fetch_(input, init)
    } catch (error: unknown) {
      await attempts.failCurrent(error)
      throw error
    }

    const requestId = response.headers.get('x-request-id') ?? undefined
    await attempts.receiveHeaders(response.status, requestId)
    if (!response.ok) {
      await attempts.failCurrent(
        new Error(`HTTP ${response.status}${response.statusText.length === 0 ? '' : ` ${response.statusText}`}`),
        'HTTPError',
      )
    }
    return response
  }
}

interface ActiveAttempt {
  attempt: number
  phase: 'requesting' | 'headers-received' | 'streaming'
  startedAt: number
  httpStatus?: number
  providerRequestId?: string
  eventCount: number
}

/** Enforces one forward-only transport lifecycle for each SDK retry attempt. */
class ProviderAttemptStateMachine {
  private nextAttempt = 0
  private active: ActiveAttempt | undefined
  completedProviderRequestId: string | undefined

  constructor(
    private readonly onEvent?: (event: ModelAttemptEvent) => Promise<void>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async start(): Promise<void> {
    if (this.active !== undefined) {
      throw new Error(`Provider Attempt ${this.active.attempt} is still ${this.active.phase}`)
    }
    const attempt = this.nextAttempt + 1
    this.nextAttempt = attempt
    this.active = {
      attempt,
      phase: 'requesting',
      startedAt: this.now(),
      eventCount: 0,
    }
    await this.emit({ type: 'started', attempt })
  }

  async receiveHeaders(httpStatus: number, providerRequestId?: string): Promise<void> {
    const active = this.requireActive('requesting')
    active.phase = 'headers-received'
    active.httpStatus = httpStatus
    if (providerRequestId !== undefined) active.providerRequestId = providerRequestId
    await this.emit({
      type: 'headers-received',
      attempt: active.attempt,
      httpStatus,
      durationMs: this.duration(active),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
    })
  }

  async receiveEvent(event: ResponseStreamEvent): Promise<void> {
    const active = this.requireActive('headers-received', 'streaming')
    active.eventCount += 1
    if (active.phase === 'streaming') return
    active.phase = 'streaming'
    await this.emit({
      type: 'first-event',
      attempt: active.attempt,
      eventType: event.type,
      durationMs: this.duration(active),
    })
  }

  async complete(): Promise<void> {
    const active = this.requireActive('streaming')
    const event: ModelAttemptEvent = {
      type: 'completed',
      attempt: active.attempt,
      httpStatus: active.httpStatus ?? 200,
      durationMs: this.duration(active),
      eventCount: active.eventCount,
      ...(active.providerRequestId === undefined
        ? {}
        : { providerRequestId: active.providerRequestId }),
    }
    await this.emit(event)
    this.completedProviderRequestId = active.providerRequestId
    this.active = undefined
  }

  async failCurrent(error: unknown, explicitName?: string): Promise<void> {
    const active = this.active
    if (active === undefined) return
    const cause = errorCause(error)
    await this.emit({
      type: 'failed',
      attempt: active.attempt,
      phase: active.phase,
      durationMs: this.duration(active),
      eventCount: active.eventCount,
      errorName: explicitName ?? errorName(error),
      errorMessage: errorMessage(error),
      ...(active.httpStatus === undefined ? {} : { httpStatus: active.httpStatus }),
      ...(active.providerRequestId === undefined
        ? {}
        : { providerRequestId: active.providerRequestId }),
      ...(cause.name === undefined ? {} : { causeName: cause.name }),
      ...(cause.code === undefined ? {} : { causeCode: cause.code }),
      ...(cause.message === undefined ? {} : { causeMessage: cause.message }),
    })
    this.active = undefined
  }

  private requireActive(...phases: ActiveAttempt['phase'][]): ActiveAttempt {
    const active = this.active
    if (active === undefined || !phases.includes(active.phase)) {
      const actual = active?.phase ?? 'none'
      throw new Error(`Invalid Provider Attempt transition from ${actual} to ${phases.join(' or ')}`)
    }
    return active
  }

  private duration(active: ActiveAttempt): number {
    return Math.max(0, Math.round(this.now() - active.startedAt))
  }

  private async emit(event: ModelAttemptEvent): Promise<void> {
    await this.onEvent?.(event)
  }
}

function errorCause(error: unknown): { name?: string; code?: string; message?: string } {
  if (!(error instanceof Error) || !('cause' in error)) return {}
  const cause = error.cause
  if (typeof cause !== 'object' || cause === null) return {}
  const record = cause as Record<string, unknown>
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toProviderTool(tool: ToolDescription): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }
}

function toProviderInput(message: Message): ResponseInputItem[] {
  if (message.role === 'system' || message.role === 'user') return [message]
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }]
  }
  if ('toolCalls' in message) {
    return message.toolCalls.map(toolCall => ({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    }))
  }
  return [message]
}

function readOutputText(response: ModelResponse): string | undefined {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text
  }
  const text = response.output
    .filter(item => item.type === 'message')
    .flatMap(item => item.content)
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('')
  return text.length === 0 ? undefined : text
}

function readReasoningContent(response: ModelResponse): string | undefined {
  const text = response.output
    .filter(item => item.type === 'reasoning')
    .flatMap(item => [
      ...item.summary.map(part => part.text),
      ...(item.content ?? []).map(part => part.text),
    ])
    .join('\n')
  return text.length === 0 ? undefined : text
}

function readUsage(response: ModelResponse): ModelUsage | undefined {
  if (response.usage === undefined || response.usage === null) return undefined
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.total_tokens,
    ...(response.usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }),
    ...(response.usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens }),
  }
}

function parseArguments(arguments_: string): unknown {
  try {
    return JSON.parse(arguments_)
  } catch (error: unknown) {
    throw new Error(`Model provider returned invalid function arguments: ${arguments_}`, {
      cause: error,
    })
  }
}
