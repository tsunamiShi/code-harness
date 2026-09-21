import { randomUUID } from 'node:crypto'

import type {
  AgentSessionSnapshot,
  AgentStep,
  AgentToolExecution,
  AgentTurn,
  SessionRecord,
  SessionStore,
} from '../runtime/session-store.ts'

/** In-memory SessionStore adapter for isolated tests and disposable runs. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, MutableSession>()

  async createSession(projectId: string | null): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, { id, projectId, status: 'active', turns: [] })
    return id
  }

  async loadSession(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const session = this.sessions.get(sessionId)
    return session === undefined ? undefined : structuredClone(session)
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
      })
      return
    }

    const turn = requireTurn(session, record.turnId)
    if (
      record.type === 'model.invocation-started'
      || record.type === 'model.attempt'
      || record.type === 'model.invocation-completed'
      || record.type === 'model.invocation-failed'
    ) {
      requireRunningTurn(turn)
      return
    }
    if (record.type === 'step.tools-called') {
      requireRunningTurn(turn)
      if (record.calls.length === 0) throw new Error('A tool Step must contain at least one call')
      turn.steps.push({
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
}

interface MutableSession {
  id: string
  projectId: string | null
  status: 'active'
  turns: MutableTurn[]
}

interface MutableTurn extends Omit<AgentTurn, 'steps'> {
  steps: MutableStep[]
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
