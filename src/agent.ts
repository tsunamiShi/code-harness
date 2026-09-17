import type { Message, Model, Tool } from './types.ts'

export interface AgentSessionOptions {
  model: Model
  tools: readonly Tool[]
  maxSteps?: number
}

export interface RunAgentOptions extends AgentSessionOptions {
  prompt: string
}

/**
 * Owns one conversation's in-memory model history and executes one turn at a time.
 */
export class AgentSession {
  private readonly messages: Message[] = []
  private readonly toolsByName = new Map<string, Tool>()
  private readonly toolDescriptions: Tool['description'][]
  private readonly maxSteps: number
  private running = false

  constructor(private readonly options: AgentSessionOptions) {
    this.maxSteps = options.maxSteps ?? 10
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error('maxSteps must be a positive integer')
    }

    for (const tool of options.tools) {
      const { name } = tool.description
      if (this.toolsByName.has(name)) throw new Error(`Duplicate tool name: ${name}`)
      this.toolsByName.set(name, tool)
    }
    this.toolDescriptions = options.tools.map(tool => tool.description)
  }

  /**
   * Executes one conversational turn. Calls on the same session must be sequential.
   * A failed turn is rolled back because the current Message model has no failure event.
   */
  async send(prompt: string): Promise<string> {
    if (this.running) throw new Error('AgentSession already has a running turn')
    if (prompt.trim().length === 0) throw new Error('prompt must not be empty')

    this.running = true
    const turnStart = this.messages.length
    this.messages.push({ role: 'user', content: prompt })

    try {
      for (let step = 1; step <= this.maxSteps; step += 1) {
        const output = await this.options.model.generate({
          messages: this.messages,
          tools: this.toolDescriptions,
        })

        if (output.kind === 'final') {
          this.messages.push({ role: 'assistant', content: output.content })
          return output.content
        }

        this.messages.push({ role: 'assistant', toolCall: output.call })
        const tool = this.toolsByName.get(output.call.name)
        const result = tool
          ? await tool.execute(output.call.arguments)
          : `Error: unknown tool "${output.call.name}"`
        this.messages.push({
          role: 'tool',
          toolCallId: output.call.id,
          content: result,
        })
      }

      throw new Error(`Agent exceeded the ${this.maxSteps}-step limit`)
    } catch (error: unknown) {
      this.messages.length = turnStart
      throw error
    } finally {
      this.running = false
    }
  }

  /** Returns a detached snapshot so callers cannot mutate session-owned history. */
  history(): readonly Message[] {
    return structuredClone(this.messages)
  }
}

/** Runs a disposable one-turn session for callers that do not need conversation state. */
export async function runAgent({
  model,
  tools,
  prompt,
  maxSteps,
}: RunAgentOptions): Promise<string> {
  const session = new AgentSession({
    model,
    tools,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  })
  return await session.send(prompt)
}
