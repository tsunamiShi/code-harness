import type { Message, ToolCall } from './types.ts'

export type SessionStatus = 'active'
export type TurnStatus = 'running' | 'completed' | 'failed'
export type StepStatus = 'running' | 'completed' | 'failed'
export type ToolExecutionStatus = 'running' | 'completed' | 'failed'

export interface AgentToolExecution {
  call: ToolCall
  status: ToolExecutionStatus
  result?: string
  error?: string
}

export interface AgentStep {
  stepNumber: number
  status: StepStatus
  output:
    | { kind: 'final'; content: string }
    | { kind: 'tool-calls'; executions: readonly AgentToolExecution[] }
}

export interface AgentTurn {
  id: string
  turnNumber: number
  status: TurnStatus
  prompt: string
  steps: readonly AgentStep[]
  error?: string
}

export interface AgentSessionSnapshot {
  id: string
  projectId: string | null
  status: SessionStatus
  turns: readonly AgentTurn[]
}

export type SessionRecord =
  | { type: 'turn.started'; turnId: string; prompt: string }
  | { type: 'step.tools-called'; turnId: string; step: number; calls: readonly ToolCall[] }
  | {
      type: 'step.tool-completed'
      turnId: string
      step: number
      toolCallId: string
      result: string
    }
  | {
      type: 'step.tool-failed'
      turnId: string
      step: number
      toolCallId: string
      error: string
    }
  | { type: 'step.finalized'; turnId: string; step: number; content: string }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.failed'; turnId: string; error: string }

/** Persists Agent sessions without exposing database details to the runtime. */
export interface SessionStore {
  createSession(projectId: string | null): Promise<string>
  loadSession(sessionId: string): Promise<AgentSessionSnapshot | undefined>
  record(sessionId: string, record: SessionRecord): Promise<void>
}

/** Builds model-visible history from completed turns only. */
export function projectMessages(snapshot: AgentSessionSnapshot): readonly Message[] {
  const messages: Message[] = []

  for (const turn of snapshot.turns) {
    if (turn.status !== 'completed') continue

    messages.push({ role: 'user', content: turn.prompt })
    for (const step of turn.steps) {
      if (step.output.kind === 'final') {
        if (step.status === 'completed') {
          messages.push({ role: 'assistant', content: step.output.content })
        }
        continue
      }
      if (step.status !== 'completed') continue
      messages.push({
        role: 'assistant',
        toolCalls: step.output.executions.map(execution => execution.call),
      })
      for (const execution of step.output.executions) {
        const toolResult = execution.result ?? execution.error
        if (toolResult === undefined) continue
        messages.push({
          role: 'tool',
          toolCallId: execution.call.id,
          content: toolResult,
        })
      }
    }
  }

  return messages
}
