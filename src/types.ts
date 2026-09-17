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

export type ModelOutput =
  | { kind: 'final'; content: string; reasoningContent?: string }
  | {
      kind: 'tool-calls'
      calls: readonly ToolCall[]
      content?: string
      reasoningContent?: string
    }

export interface Model {
  generate(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
  }): Promise<ModelOutput>
}

export interface Tool {
  readonly description: ToolDescription
  readonly parallelSafe?: boolean
  execute(arguments_: unknown): Promise<string>
}
