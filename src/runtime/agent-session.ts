import { randomUUID } from 'node:crypto'

import { projectInstructions, type AgentProject, type WorkspaceAccessMode } from '../projects/project.ts'
import { MemorySessionStore } from '../storage/memory-session-store.ts'
import {
  projectMessages,
  type SessionStore,
} from './session-store.ts'
import type { Message, Model, ModelOutput, Tool, ToolCall } from './types.ts'

const DEFAULT_MAX_STEPS = 50

export interface AgentSessionOptions {
  model: Model
  tools: readonly Tool[]
  store: SessionStore
  project?: AgentProject
  accessMode?: WorkspaceAccessMode
  maxSteps?: number
  onEvent?: (event: AgentEvent) => void
}

export interface RunAgentOptions extends Omit<AgentSessionOptions, 'store'> {
  prompt: string
}

/** Runtime observations emitted in execution order for logs and user interfaces. */
export type AgentEvent =
  | { type: 'turn.started'; turnId: string; prompt: string }
  | {
      type: 'step.started'
      turnId: string
      step: number
      messageCount: number
      toolCount: number
    }
  | {
      type: 'model.completed'
      turnId: string
      step: number
      durationMs: number
      output: ModelOutput
    }
  | {
      type: 'tool.batch-started'
      turnId: string
      step: number
      mode: 'parallel' | 'serial'
      count: number
    }
  | { type: 'tool.started'; turnId: string; step: number; call: ToolCall }
  | {
      type: 'tool.completed'
      turnId: string
      step: number
      call: ToolCall
      durationMs: number
      failed: boolean
      content: string
    }
  | { type: 'turn.completed'; turnId: string; steps: number; durationMs: number }
  | { type: 'turn.failed'; turnId: string; durationMs: number; error: string }

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
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
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
    const turnStartedAt = performance.now()
    const turnStart = this.messages.length
    let turnStarted = false

    try {
      await this.options.store.record(this.id, { type: 'turn.started', turnId, prompt })
      turnStarted = true
      this.messages.push({ role: 'user', content: prompt })
      this.emit({ type: 'turn.started', turnId, prompt })

      for (let step = 1; step <= this.maxSteps; step += 1) {
        const messages = this.modelMessages()
        const tools = step === this.maxSteps ? [] : this.toolDescriptions
        this.emit({
          type: 'step.started',
          turnId,
          step,
          messageCount: messages.length,
          toolCount: tools.length,
        })
        const modelStartedAt = performance.now()
        const output = await this.options.model.generate({
          messages,
          tools,
        })
        this.emit({
          type: 'model.completed',
          turnId,
          step,
          durationMs: performance.now() - modelStartedAt,
          output: structuredClone(output),
        })

        if (output.kind === 'final') {
          await this.options.store.record(this.id, {
            type: 'step.finalized',
            turnId,
            step,
            content: output.content,
          })
          this.messages.push({ role: 'assistant', content: output.content })
          await this.options.store.record(this.id, { type: 'turn.completed', turnId })
          this.emit({
            type: 'turn.completed',
            turnId,
            steps: step,
            durationMs: performance.now() - turnStartedAt,
          })
          return output.content
        }

        validateToolCalls(output.calls)
        await this.options.store.record(this.id, {
          type: 'step.tools-called',
          turnId,
          step,
          calls: output.calls,
        })
        this.messages.push({ role: 'assistant', toolCalls: structuredClone(output.calls) })

        const executions = await this.executeToolCalls(turnId, step, output.calls)
        for (const execution of executions) {
          if (execution.failed) {
            await this.options.store.record(this.id, {
              type: 'step.tool-failed',
              turnId,
              step,
              toolCallId: execution.call.id,
              error: execution.content,
            })
          } else {
            await this.options.store.record(this.id, {
              type: 'step.tool-completed',
              turnId,
              step,
              toolCallId: execution.call.id,
              result: execution.content,
            })
          }
          this.messages.push({
            role: 'tool',
            toolCallId: execution.call.id,
            content: execution.content,
          })
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
        this.emit({
          type: 'turn.failed',
          turnId,
          durationMs: performance.now() - turnStartedAt,
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
      {
        role: 'system',
        content: projectInstructions(this.options.project, this.options.accessMode),
      },
      ...this.messages,
    ]
  }

  private async executeToolCalls(
    turnId: string,
    step: number,
    calls: readonly ToolCall[],
  ): Promise<readonly ToolExecutionResult[]> {
    const parallel = calls.every(
      call => this.toolsByName.get(call.name)?.parallelSafe === true,
    )
    this.emit({
      type: 'tool.batch-started',
      turnId,
      step,
      mode: parallel ? 'parallel' : 'serial',
      count: calls.length,
    })
    if (parallel) {
      return await Promise.all(calls.map(call => this.executeToolCall(turnId, step, call)))
    }

    const results: ToolExecutionResult[] = []
    for (const call of calls) {
      results.push(await this.executeToolCall(turnId, step, call))
    }
    return results
  }

  private async executeToolCall(
    turnId: string,
    step: number,
    call: ToolCall,
  ): Promise<ToolExecutionResult> {
    const startedAt = performance.now()
    this.emit({ type: 'tool.started', turnId, step, call: structuredClone(call) })
    const tool = this.toolsByName.get(call.name)
    if (!tool) {
      return this.completeToolExecution(
        turnId,
        step,
        startedAt,
        { call, failed: true, content: `Error: unknown tool "${call.name}"` },
      )
    }
    try {
      return this.completeToolExecution(turnId, step, startedAt, {
        call,
        failed: false,
        content: await tool.execute(call.arguments),
      })
    } catch (error: unknown) {
      return this.completeToolExecution(turnId, step, startedAt, {
        call,
        failed: true,
        content: `Error: ${errorMessage(error)}`,
      })
    }
  }

  private completeToolExecution(
    turnId: string,
    step: number,
    startedAt: number,
    execution: ToolExecutionResult,
  ): ToolExecutionResult {
    this.emit({
      type: 'tool.completed',
      turnId,
      step,
      call: structuredClone(execution.call),
      durationMs: performance.now() - startedAt,
      failed: execution.failed,
      content: execution.content,
    })
    return execution
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event)
  }
}

/** Runs a disposable one-turn session backed by an isolated in-memory store. */
export async function runAgent({
  model,
  tools,
  prompt,
  maxSteps,
  onEvent,
}: RunAgentOptions): Promise<string> {
  const session = await AgentSession.create({
    model,
    tools,
    store: new MemorySessionStore(),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(onEvent === undefined ? {} : { onEvent }),
  })
  return await session.send(prompt)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ToolExecutionResult {
  call: ToolCall
  failed: boolean
  content: string
}

function validateToolCalls(calls: readonly ToolCall[]): void {
  if (calls.length === 0) throw new Error('Model returned an empty tool-call batch')
  if (new Set(calls.map(call => call.id)).size !== calls.length) {
    throw new Error('Model returned duplicate tool-call ids in one step')
  }
}
