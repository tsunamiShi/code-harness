import { randomUUID } from 'node:crypto'

import { projectInstructions, type AgentProject, type FilesystemAccessMode } from '../projects/project.ts'
import { MemorySessionStore } from '../storage/memory-session-store.ts'
import {
  projectMessages,
  recoverableTurn,
  type AgentTurn,
  type SessionStore,
} from './session-store.ts'
import type { Message, Model, ModelOutput, Tool, ToolCall } from './types.ts'

const DEFAULT_MAX_TOKENS = 4_096
const INTERRUPTED_TOOL_ERROR = 'Error: execution stopped before this Tool result was persisted; the Tool was not run again because its side effects are unknown'

export interface AgentSessionOptions {
  model: Model
  tools: readonly Tool[]
  store: SessionStore
  project?: AgentProject
  accessMode?: FilesystemAccessMode
  maxTokens?: number
  onEvent?: (event: AgentEvent) => void
}

export interface RunAgentOptions extends Omit<AgentSessionOptions, 'store'> {
  prompt: string
}

/** Runtime observations emitted in execution order for logs and user interfaces. */
export type AgentEvent =
  | { type: 'turn.started'; turnId: string; prompt: string }
  | { type: 'turn.resumed'; turnId: string; step: number }
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
  private readonly maxTokens: number
  private recoverableTurnId: string | undefined
  private running = false

  private constructor(
    readonly id: string,
    private readonly options: AgentSessionOptions,
    messages: readonly Message[],
    recoverableTurnId?: string,
  ) {
    this.messages = [...structuredClone(messages)]
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.recoverableTurnId = recoverableTurnId
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1) {
      throw new Error('maxTokens must be a positive safe integer')
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
    const unfinished = recoverableTurn(snapshot)
    return new AgentSession(
      sessionId,
      options,
      projectMessages(snapshot),
      unfinished?.id,
    )
  }

  /**
   * Executes one conversational turn. Calls on the same session must be sequential, and an
   * unfinished Turn must be continued before accepting another user prompt.
   */
  async send(prompt: string): Promise<string> {
    if (this.running) throw new Error('AgentSession already has a running turn')
    if (this.recoverableTurnId !== undefined) {
      throw new Error(`Session has unfinished turn ${this.recoverableTurnId}; continue it first`)
    }
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
      return await this.runTurn(turnId, 1, turnStartedAt)
    } catch (error: unknown) {
      if (turnStarted) {
        this.recoverableTurnId = turnId
        await this.failTurn(turnId, turnStartedAt, error)
      } else {
        this.messages.length = turnStart
      }
      throw error
    } finally {
      this.running = false
    }
  }

  /** Reports whether the final Turn must be continued before another prompt can start. */
  hasRecoverableTurn(): boolean {
    return this.recoverableTurnId !== undefined
  }

  /** Continues the final failed or process-interrupted Turn from its durable Steps. */
  async continueTurn(): Promise<string> {
    if (this.running) throw new Error('AgentSession already has a running turn')
    const turnId = this.recoverableTurnId
    if (turnId === undefined) throw new Error('Session has no unfinished turn to continue')

    this.running = true
    const turnStartedAt = performance.now()
    let recovered = false
    try {
      await this.options.store.recoverTurn(this.id, turnId, INTERRUPTED_TOOL_ERROR)
      recovered = true
      const snapshot = await this.requireSnapshot()
      const turn = snapshot.turns.find(candidate => candidate.id === turnId)
      if (!turn || turn.status !== 'running') throw new Error(`Turn ${turnId} was not recovered`)
      this.replaceMessages(projectMessages(snapshot))

      const final = completedFinal(turn)
      if (final !== undefined) {
        await this.options.store.record(this.id, { type: 'turn.completed', turnId })
        this.recoverableTurnId = undefined
        this.emit({
          type: 'turn.completed',
          turnId,
          steps: final.stepNumber,
          durationMs: performance.now() - turnStartedAt,
        })
        return final.output.content
      }

      const step = nextStepNumber(turn)
      this.emit({ type: 'turn.resumed', turnId, step })
      return await this.runTurn(turnId, step, turnStartedAt)
    } catch (error: unknown) {
      this.recoverableTurnId = turnId
      if (recovered) await this.failTurn(turnId, turnStartedAt, error)
      throw error
    } finally {
      this.running = false
    }
  }

  /** Returns a detached snapshot of completed and recoverable model context. */
  history(): readonly Message[] {
    return structuredClone(this.messages)
  }

  private async runTurn(
    turnId: string,
    firstStep: number,
    turnStartedAt: number,
  ): Promise<string> {
    for (let step = firstStep; ; step += 1) {
      const messages = this.modelMessages()
      const tools = this.toolDescriptions
      this.emit({
        type: 'step.started',
        turnId,
        step,
        messageCount: messages.length,
        toolCount: tools.length,
      })
      await this.options.store.record(this.id, {
        type: 'model.invocation-started',
        turnId,
        step,
        ...(this.options.model.descriptor === undefined
          ? {}
          : { descriptor: this.options.model.descriptor }),
        messageCount: messages.length,
        toolCount: tools.length,
        inputChars: JSON.stringify({ messages, tools }).length,
        maxTokens: this.maxTokens,
      })
      const modelStartedAt = performance.now()
      let output: ModelOutput
      try {
        output = await this.options.model.generate({
          messages,
          tools,
          maxTokens: this.maxTokens,
          onAttempt: async event => {
            await this.options.store.record(this.id, {
              type: 'model.attempt',
              turnId,
              step,
              event,
            })
          },
        })
      } catch (error: unknown) {
        await this.options.store.record(this.id, {
          type: 'model.invocation-failed',
          turnId,
          step,
          errorName: errorName(error),
          error: errorMessage(error),
        })
        throw error
      }
      await this.options.store.record(this.id, {
        type: 'model.invocation-completed',
        turnId,
        step,
        outputKind: output.kind,
        outputChars: modelOutputChars(output),
        reasoningChars: output.reasoningContent?.length ?? 0,
        toolCallCount: output.kind === 'tool-calls' ? output.calls.length : 0,
        ...(output.metadata === undefined ? {} : { metadata: output.metadata }),
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
        this.recoverableTurnId = undefined
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
        this.messages.push({
          role: 'tool',
          toolCallId: execution.call.id,
          content: execution.content,
        })
      }
    }
  }

  private async failTurn(turnId: string, turnStartedAt: number, error: unknown): Promise<void> {
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

  private async requireSnapshot() {
    const snapshot = await this.options.store.loadSession(this.id)
    if (!snapshot) throw new Error(`Unknown session: ${this.id}`)
    return snapshot
  }

  private replaceMessages(messages: readonly Message[]): void {
    this.messages.splice(0, this.messages.length, ...structuredClone(messages))
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
      const settled = await Promise.allSettled(
        calls.map(call => this.executeToolCall(turnId, step, call)),
      )
      const results: ToolExecutionResult[] = []
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        results.push(result.value)
      }
      return results
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
      return await this.persistToolExecution(
        turnId,
        step,
        startedAt,
        { call, failed: true, content: `Error: unknown tool "${call.name}"` },
      )
    }
    let execution: ToolExecutionResult
    try {
      execution = {
        call,
        failed: false,
        content: await tool.execute(call.arguments),
      }
    } catch (error: unknown) {
      execution = {
        call,
        failed: true,
        content: `Error: ${errorMessage(error)}`,
      }
    }
    return await this.persistToolExecution(turnId, step, startedAt, execution)
  }

  private async persistToolExecution(
    turnId: string,
    step: number,
    startedAt: number,
    execution: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    this.completeToolExecution(turnId, step, startedAt, execution)
    await this.options.store.record(this.id, execution.failed
      ? {
          type: 'step.tool-failed',
          turnId,
          step,
          toolCallId: execution.call.id,
          error: execution.content,
        }
      : {
          type: 'step.tool-completed',
          turnId,
          step,
          toolCallId: execution.call.id,
          result: execution.content,
        })
    return execution
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
  maxTokens,
  onEvent,
}: RunAgentOptions): Promise<string> {
  const session = await AgentSession.create({
    model,
    tools,
    store: new MemorySessionStore(),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(onEvent === undefined ? {} : { onEvent }),
  })
  return await session.send(prompt)
}

function completedFinal(turn: AgentTurn): CompletedFinalStep | undefined {
  for (const step of turn.steps) {
    if (step.status === 'completed' && step.output.kind === 'final') {
      return { stepNumber: step.stepNumber, output: step.output }
    }
  }
  return undefined
}

function nextStepNumber(turn: AgentTurn): number {
  return Math.max(0, ...turn.steps.map(step => step.stepNumber)) + 1
}

interface CompletedFinalStep {
  stepNumber: number
  output: { kind: 'final'; content: string }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function modelOutputChars(output: ModelOutput): number {
  if (output.kind === 'final') return output.content.length
  return (output.content?.length ?? 0) + JSON.stringify(output.calls).length
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
