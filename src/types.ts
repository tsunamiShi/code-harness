export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; toolCall: ToolCall }
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
  | { kind: 'final'; content: string }
  | { kind: 'tool-call'; call: ToolCall }

export interface Model {
  generate(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
  }): Promise<ModelOutput>
}

export interface Tool {
  readonly description: ToolDescription
  execute(arguments_: unknown): Promise<string>
}
