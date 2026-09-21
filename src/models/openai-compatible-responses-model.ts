import { AsyncLocalStorage } from 'node:async_hooks'

import OpenAI from 'openai'
import type {
  FunctionTool,
  Response as ModelResponse,
  ResponseInputItem,
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
  nextAttempt: number
  onAttempt?: (event: ModelAttemptEvent) => Promise<void>
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
    const { data: response, request_id: requestId } = await this.attemptContext.run(
      { nextAttempt: 0, ...(input.onAttempt === undefined ? {} : { onAttempt: input.onAttempt }) },
      async () => await this.client.responses.create({
        model: this.options.model,
        input: input.messages.flatMap(toProviderInput),
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
      }).withResponse(),
    )

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
      ...(requestId === null ? {} : { providerRequestId: requestId }),
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
    const context = this.attemptContext.getStore()
    if (!context?.onAttempt) return await fetch_(input, init)

    const attempt = context.nextAttempt + 1
    context.nextAttempt = attempt
    await context.onAttempt({ type: 'started', attempt })

    let response: Response
    try {
      response = await fetch_(input, init)
    } catch (error: unknown) {
      await context.onAttempt({
        type: 'failed',
        attempt,
        errorName: errorName(error),
        errorMessage: errorMessage(error),
      })
      throw error
    }

    const requestId = response.headers.get('x-request-id') ?? undefined
    if (response.ok) {
      await context.onAttempt({
        type: 'completed',
        attempt,
        httpStatus: response.status,
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      })
    } else {
      await context.onAttempt({
        type: 'failed',
        attempt,
        errorName: 'HTTPError',
        errorMessage: `HTTP ${response.status}${response.statusText.length === 0 ? '' : ` ${response.statusText}`}`,
        httpStatus: response.status,
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      })
    }
    return response
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
