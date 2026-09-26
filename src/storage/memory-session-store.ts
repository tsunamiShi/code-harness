import { randomUUID } from 'node:crypto'

import { latestCompletedStepCursor } from '../runtime/session-store.ts'
import type {
  AgentSessionSnapshot,
  AgentLoopGuardReminder,
  AgentStep,
  AgentToolExecution,
  AgentTurn,
  ContextCheckpoint,
  ModelInvocationPurpose,
  SessionRecord,
  SessionStore,
} from '../runtime/session-store.ts'

/** In-memory SessionStore adapter for isolated tests and disposable runs. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, MutableSession>()

  async createSession(projectId: string | null): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, {
      id,
      projectId,
      status: 'active',
      turns: [],
      nextStepId: 1,
      invocations: [],
    })
    return id
  }

  async loadSession(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return undefined
    return structuredClone({
      id: session.id,
      projectId: session.projectId,
      status: session.status,
      turns: session.turns,
      ...(session.contextCheckpoint === undefined
        ? {}
        : { contextCheckpoint: session.contextCheckpoint }),
      ...(session.latestInputTokens === undefined
        ? {}
        : { latestInputTokens: session.latestInputTokens }),
    })
  }

  async record(sessionId: string, record: SessionRecord): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    if (record.type === 'turn.started') {
      if (session.turns.some(turn => turn.status === 'running')) {
        throw new Error(`Session ${sessionId} already has a running turn`)
      }
      session.turns.push({
        id: record.turnId,
        turnNumber: session.turns.length + 1,
        status: 'running',
        prompt: record.prompt,
        steps: [],
        loopGuardReminders: [],
      })
      return
    }

    const turn = requireTurn(session, record.turnId)
    if (record.type === 'model.invocation-started') {
      const purpose = record.purpose ?? 'agent'
      if (purpose === 'agent') requireRunningTurn(turn)
      if (session.invocations.some(invocation => invocation.status === 'running')) {
        throw new Error(`Session ${sessionId} already has a running Model Invocation`)
      }
      session.invocations.push({
        turnId: record.turnId,
        step: record.step,
        purpose,
        status: 'running',
      })
      return
    }
    if (record.type === 'model.attempt') {
      requireRunningInvocation(session, record.turnId, record.step)
      return
    }
    if (record.type === 'model.invocation-completed') {
      const invocation = requireRunningInvocation(session, record.turnId, record.step)
      invocation.status = 'completed'
      if (invocation.purpose === 'agent') {
        const inputTokens = record.metadata?.usage?.inputTokens
        if (inputTokens !== undefined) session.latestInputTokens = inputTokens
      }
      return
    }
    if (record.type === 'model.invocation-failed') {
      requireRunningInvocation(session, record.turnId, record.step).status = 'failed'
      return
    }
    if (record.type === 'context.compacted') {
      const cursor = latestCompletedStepCursor(await this.loadSession(sessionId) as AgentSessionSnapshot)
      if (cursor?.stepId !== record.coveredThroughStepId) {
        throw new Error('Context Checkpoint cursor is stale')
      }
      if (
        record.trigger === 'manual'
        && (record.turnId !== cursor.turnId || record.step !== cursor.stepNumber)
      ) {
        throw new Error('Context Checkpoint invocation does not match its cursor')
      }
      if ((session.contextCheckpoint?.checkpointNumber ?? 0) !== record.expectedCheckpointNumber) {
        throw new Error('A newer Context Checkpoint already exists')
      }
      if (session.contextCheckpoint?.coveredThroughStepId === cursor.stepId) {
        throw new Error('There is no completed Step after the latest Context Checkpoint')
      }
      const invocation = session.invocations.findLast(candidate =>
        candidate.turnId === record.turnId
        && candidate.step === record.step
        && candidate.purpose === 'compaction'
        && candidate.status === 'completed'
      )
      if (invocation === undefined) throw new Error('Completed compaction invocation not found')
      session.contextCheckpoint = {
        checkpointNumber: record.expectedCheckpointNumber + 1,
        coveredThroughStepId: cursor.stepId,
        coveredThroughTurnId: cursor.turnId,
        coveredThroughTurnNumber: cursor.turnNumber,
        coveredThroughStepNumber: cursor.stepNumber,
        trigger: record.trigger,
        reason: record.reason,
        payload: structuredClone(record.payload),
        ...(record.estimatedTokensBefore === undefined
          ? {}
          : { estimatedTokensBefore: record.estimatedTokensBefore }),
        ...(record.estimatedTokensAfter === undefined
          ? {}
          : { estimatedTokensAfter: record.estimatedTokensAfter }),
      }
      delete session.latestInputTokens
      return
    }
    if (record.type === 'loop-guard.reminded') {
      requireRunningTurn(turn)
      turn.loopGuardReminders.push({
        reminderNumber: record.reminderNumber,
        afterStep: record.afterStep,
        kind: record.kind,
        metric: record.metric,
        summary: record.summary,
        content: record.content,
      })
      return
    }
    if (record.type === 'step.tools-called') {
      requireRunningTurn(turn)
      if (record.calls.length === 0) throw new Error('A tool Step must contain at least one call')
      turn.steps.push({
        id: String(session.nextStepId++),
        stepNumber: record.step,
        status: 'running',
        ...(record.providerResponseId === undefined
          ? {}
          : { providerResponseId: record.providerResponseId }),
        output: {
          kind: 'tool-calls',
          executions: record.calls.map(call => ({
            call: structuredClone(call),
            status: 'running',
          })),
        },
      })
      return
    }

    if (record.type === 'step.finalized') {
      requireRunningTurn(turn)
      turn.steps.push({
        id: String(session.nextStepId++),
        stepNumber: record.step,
        status: 'completed',
        ...(record.providerResponseId === undefined
          ? {}
          : { providerResponseId: record.providerResponseId }),
        output: { kind: 'final', content: record.content },
      })
      return
    }

    if (record.type === 'turn.completed') {
      requireRunningTurn(turn)
      turn.status = 'completed'
      return
    }

    if (record.type === 'turn.failed') {
      requireRunningTurn(turn)
      turn.status = 'failed'
      turn.error = record.error
      return
    }

    const step = requireStep(turn, record.step)
    if (step.output.kind !== 'tool-calls') {
      throw new Error(`Tool call ${record.toolCallId} does not match step ${record.step}`)
    }
    const execution = step.output.executions.find(
      candidate => candidate.call.id === record.toolCallId,
    )
    if (!execution || execution.status !== 'running') {
      throw new Error(`Tool call ${record.toolCallId} does not match step ${record.step}`)
    }
    if (record.type === 'step.tool-completed') {
      execution.status = 'completed'
      execution.result = record.result
    } else {
      execution.status = 'failed'
      execution.error = record.error
    }
    if (step.output.executions.every(candidate => candidate.status !== 'running')) {
      step.status = 'completed'
    }
  }

  async recoverTurn(
    sessionId: string,
    turnId: string,
    interruptedToolError: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const turn = requireTurn(session, turnId)
    if (turn.status === 'completed') throw new Error(`Turn ${turn.id} is completed`)

    turn.status = 'running'
    delete turn.error
    for (const step of turn.steps) {
      if (step.output.kind !== 'tool-calls') continue
      for (const execution of step.output.executions) {
        if (execution.status !== 'running') continue
        execution.status = 'failed'
        execution.error = interruptedToolError
      }
      if (step.output.executions.every(execution => execution.status !== 'running')) {
        step.status = 'completed'
      }
    }
  }

  async recoverInterruptedCompactions(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    for (const invocation of session.invocations) {
      if (invocation.purpose === 'compaction' && invocation.status === 'running') {
        invocation.status = 'failed'
      }
    }
  }
}

interface MutableSession {
  id: string
  projectId: string | null
  status: 'active'
  turns: MutableTurn[]
  nextStepId: number
  invocations: MutableInvocation[]
  contextCheckpoint?: ContextCheckpoint
  latestInputTokens?: number
}

interface MutableInvocation {
  turnId: string
  step: number
  purpose: ModelInvocationPurpose
  status: 'running' | 'completed' | 'failed'
}

interface MutableTurn extends Omit<AgentTurn, 'steps' | 'loopGuardReminders'> {
  steps: MutableStep[]
  loopGuardReminders: AgentLoopGuardReminder[]
  error?: string
}

interface MutableToolStep extends Omit<AgentStep, 'output'> {
  output: { kind: 'tool-calls'; executions: MutableToolExecution[] }
}

type MutableToolExecution = AgentToolExecution
type MutableStep = AgentStep | MutableToolStep

function requireTurn(session: MutableSession, turnId: string): MutableTurn {
  const turn = session.turns.find(candidate => candidate.id === turnId)
  if (!turn) throw new Error(`Unknown turn: ${turnId}`)
  return turn
}

function requireStep(turn: MutableTurn, stepNumber: number): MutableStep {
  const step = turn.steps.find(candidate => candidate.stepNumber === stepNumber)
  if (!step) throw new Error(`Unknown step: ${stepNumber}`)
  return step
}

function requireRunningTurn(turn: MutableTurn): void {
  if (turn.status !== 'running') throw new Error(`Turn ${turn.id} is ${turn.status}`)
}

function requireRunningInvocation(
  session: MutableSession,
  turnId: string,
  step: number,
): MutableInvocation {
  const invocation = session.invocations.findLast(candidate =>
    candidate.turnId === turnId
    && candidate.step === step
    && candidate.status === 'running'
  )
  if (invocation === undefined) {
    throw new Error(`Model Invocation for step ${step} is not running`)
  }
  return invocation
}
