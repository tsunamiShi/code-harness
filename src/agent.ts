import { randomUUID } from 'node:crypto'

import { MemorySessionStore } from './memory-session-store.ts'
import { projectInstructions, type AgentProject } from './project.ts'
import { projectMessages, type SessionStore } from './session-store.ts'
import type { Message, Model, Tool } from './types.ts'

export interface AgentSessionOptions {
  model: Model
  tools: readonly Tool[]
  store: SessionStore
  project?: AgentProject
  maxSteps?: number
}

export interface RunAgentOptions extends Omit<AgentSessionOptions, 'store'> {
  prompt: string
}

/** Owns one durable conversation and executes one turn at a time. */
export class AgentSession {
  private readonly messages: Message[]
  private readonly toolsByName = new Map<string, Tool>()
  private readonly toolDescriptions: Tool['description'][]
  private readonly maxSteps: number
  private running = false

  private constructor(
    readonly id: string,
    private readonly options: AgentSessionOptions,
    messages: readonly Message[],
  ) {
    this.messages = [...structuredClone(messages)]
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

  /** Creates and persists a new conversation. */
  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const sessionId = await options.store.createSession(options.project?.id ?? null)
    return new AgentSession(sessionId, options, [])
  }

  /** Restores the model context for an existing conversation. */
  static async resume(sessionId: string, options: AgentSessionOptions): Promise<AgentSession> {
    const snapshot = await options.store.loadSession(sessionId)
    if (!snapshot) throw new Error(`Unknown session: ${sessionId}`)
    if (snapshot.projectId !== (options.project?.id ?? null)) {
      throw new Error(`Session ${sessionId} does not belong to the supplied project`)
    }
    const runningTurn = snapshot.turns.find(turn => turn.status === 'running')
    if (runningTurn) {
      throw new Error(
        `Session ${sessionId} has unfinished turn ${runningTurn.id}; recovery is not implemented yet`,
      )
    }
    return new AgentSession(sessionId, options, projectMessages(snapshot))
  }

  /**
   * Executes one conversational turn. Calls on the same session must be sequential.
   * Failed turns stay in storage for diagnosis but are removed from model-visible history.
   */
  async send(prompt: string): Promise<string> {
    if (this.running) throw new Error('AgentSession already has a running turn')
    if (prompt.trim().length === 0) throw new Error('prompt must not be empty')

    this.running = true
    const turnId = randomUUID()
    const turnStart = this.messages.length
    let turnStarted = false

    try {
      await this.options.store.record(this.id, { type: 'turn.started', turnId, prompt })
      turnStarted = true
      this.messages.push({ role: 'user', content: prompt })

      for (let step = 1; step <= this.maxSteps; step += 1) {
        const output = await this.options.model.generate({
          messages: this.modelMessages(),
          tools: this.toolDescriptions,
        })
        console.log(JSON.stringify(output, null, 2))

        if (output.kind === 'final') {
          await this.options.store.record(this.id, {
            type: 'step.finalized',
            turnId,
            step,
            content: output.content,
          })
          this.messages.push({ role: 'assistant', content: output.content })
          await this.options.store.record(this.id, { type: 'turn.completed', turnId })
          return output.content
        }

        await this.options.store.record(this.id, {
          type: 'step.tool-called',
          turnId,
          step,
          call: output.call,
        })
        this.messages.push({ role: 'assistant', toolCall: output.call })
        const tool = this.toolsByName.get(output.call.name)

        try {
          const result = tool
            ? await tool.execute(output.call.arguments)
            : `Error: unknown tool "${output.call.name}"`
          await this.options.store.record(this.id, {
            type: 'step.tool-completed',
            turnId,
            step,
            toolCallId: output.call.id,
            result,
          })
          this.messages.push({ role: 'tool', toolCallId: output.call.id, content: result })
        } catch (error: unknown) {
          await this.options.store.record(this.id, {
            type: 'step.tool-failed',
            turnId,
            step,
            toolCallId: output.call.id,
            error: errorMessage(error),
          })
          throw error
        }
      }

      throw new Error(`Agent exceeded the ${this.maxSteps}-step limit`)
    } catch (error: unknown) {
      this.messages.length = turnStart
      if (turnStarted) {
        await this.options.store.record(this.id, {
          type: 'turn.failed',
          turnId,
          error: errorMessage(error),
        })
      }
      throw error
    } finally {
      this.running = false
    }
  }

  /** Returns a detached model-context snapshot. Failed turns are intentionally absent. */
  history(): readonly Message[] {
    return structuredClone(this.messages)
  }

  private modelMessages(): readonly Message[] {
    if (!this.options.project) return this.messages
    return [
      { role: 'system', content: projectInstructions(this.options.project) },
      ...this.messages,
    ]
  }
}

/** Runs a disposable one-turn session backed by an isolated in-memory store. */
export async function runAgent({
  model,
  tools,
  prompt,
  maxSteps,
}: RunAgentOptions): Promise<string> {
  const session = await AgentSession.create({
    model,
    tools,
    store: new MemorySessionStore(),
    ...(maxSteps === undefined ? {} : { maxSteps }),
  })
  return await session.send(prompt)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
