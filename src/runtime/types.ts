export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ToolDescription {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ToolEffect = 'observe' | 'mutate' | 'execute'

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

export interface ModelResponseMetadata {
  providerRequestId?: string
  providerResponseId?: string
  finishReason?: string
  usage?: ModelUsage
}

export type ModelOutput = (
  | { kind: 'final'; content: string; reasoningContent?: string }
  | {
      kind: 'tool-calls'
      calls: readonly ToolCall[]
      content?: string
      reasoningContent?: string
    }
  ) & { metadata?: ModelResponseMetadata }

export interface ModelDescriptor {
  provider: string
  model: string
  protocol: string
  requestTimeoutMs?: number
  maxRetries?: number
}

export type ModelAttemptPhase = 'requesting' | 'headers-received' | 'streaming'

/** Incremental provider content that is safe to expose while a Model Invocation is running. */
export type ModelStreamEvent =
  | { type: 'output-text'; delta: string }
  | { type: 'reasoning'; delta: string }

export type ModelAttemptEvent =
  | { type: 'started'; attempt: number }
  | {
      type: 'headers-received'
      attempt: number
      httpStatus: number
      durationMs: number
      providerRequestId?: string
    }
  | {
      type: 'first-event'
      attempt: number
      eventType: string
      durationMs: number
    }
  | {
      type: 'completed'
      attempt: number
      httpStatus: number
      durationMs: number
      eventCount: number
      providerRequestId?: string
    }
  | {
      type: 'failed'
      attempt: number
      phase: ModelAttemptPhase
      durationMs: number
      eventCount: number
      errorName: string
      errorMessage: string
      httpStatus?: number
      providerRequestId?: string
      causeName?: string
      causeCode?: string
      causeMessage?: string
    }

export interface Model {
  readonly descriptor?: ModelDescriptor
  generate(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
    maxTokens?: number
    previousResponseId?: string
    onAttempt?: (event: ModelAttemptEvent) => Promise<void>
    onStream?: (event: ModelStreamEvent) => Promise<void>
  }): Promise<ModelOutput>
}

export interface Tool {
  readonly description: ToolDescription
  readonly effect: ToolEffect
  readonly parallelSafe?: boolean
  execute(arguments_: unknown): Promise<string>
  close?(): Promise<void>
}
