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

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

export interface ModelResponseMetadata {
  providerRequestId?: string
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

export type ModelAttemptEvent =
  | { type: 'started'; attempt: number }
  | {
      type: 'completed'
      attempt: number
      httpStatus: number
      providerRequestId?: string
    }
  | {
      type: 'failed'
      attempt: number
      errorName: string
      errorMessage: string
      httpStatus?: number
      providerRequestId?: string
    }

export interface Model {
  readonly descriptor?: ModelDescriptor
  generate(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
    maxTokens?: number
    onAttempt?: (event: ModelAttemptEvent) => Promise<void>
  }): Promise<ModelOutput>
}

export interface Tool {
  readonly description: ToolDescription
  readonly parallelSafe?: boolean
  execute(arguments_: unknown): Promise<string>
  close?(): Promise<void>
}
