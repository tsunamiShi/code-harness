import type {
  Message,
  ModelAttemptEvent,
  ModelDescriptor,
  ModelResponseMetadata,
  ToolCall,
} from './types.ts'
import type { LoopGuardReminder } from './loop-guard.ts'

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
  providerResponseId?: string
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
  loopGuardReminders: readonly AgentLoopGuardReminder[]
  error?: string
}

export interface AgentLoopGuardReminder extends LoopGuardReminder {
  reminderNumber: number
  afterStep: number
}

export interface AgentSessionSnapshot {
  id: string
  projectId: string | null
  status: SessionStatus
  turns: readonly AgentTurn[]
}

export type SessionRecord =
  | { type: 'turn.started'; turnId: string; prompt: string }
  | {
      type: 'model.invocation-started'
      turnId: string
      step: number
      descriptor?: ModelDescriptor
      messageCount: number
      toolCount: number
      inputChars: number
      maxTokens?: number
    }
  | {
      type: 'model.attempt'
      turnId: string
      step: number
      event: ModelAttemptEvent
    }
  | {
      type: 'model.invocation-completed'
      turnId: string
      step: number
      outputKind: 'final' | 'tool-calls'
      outputChars: number
      reasoningChars: number
      toolCallCount: number
      metadata?: ModelResponseMetadata
    }
  | {
      type: 'model.invocation-failed'
      turnId: string
      step: number
      errorName: string
      error: string
    }
  | {
      type: 'loop-guard.reminded'
      turnId: string
      reminderNumber: number
      afterStep: number
      kind: LoopGuardReminder['kind']
      metric: number
      summary: string
      content: string
    }
  | {
      type: 'step.tools-called'
      turnId: string
      step: number
      calls: readonly ToolCall[]
      providerResponseId?: string
    }
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
  | {
      type: 'step.finalized'
      turnId: string
      step: number
      content: string
      providerResponseId?: string
    }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.failed'; turnId: string; error: string }

/** Persists Agent sessions without exposing database details to the runtime. */
export interface SessionStore {
  createSession(projectId: string | null): Promise<string>
  loadSession(sessionId: string): Promise<AgentSessionSnapshot | undefined>
  record(sessionId: string, record: SessionRecord): Promise<void>
  recoverTurn(sessionId: string, turnId: string, interruptedToolError: string): Promise<void>
}

export interface ProviderContinuation {
  responseId: string
  syncedMessageCount: number
}

export interface ProjectedModelState {
  messages: readonly Message[]
  continuation?: ProviderContinuation
}

/** Returns the final unfinished Turn, if recovery must precede a new Turn. */
export function recoverableTurn(snapshot: AgentSessionSnapshot): AgentTurn | undefined {
  const turn = snapshot.turns.at(-1)
  return turn?.status === 'completed' ? undefined : turn
}

/** Builds model-visible history from completed Turns and durable work in the final unfinished Turn. */
export function projectMessages(snapshot: AgentSessionSnapshot): readonly Message[] {
  return projectModelState(snapshot).messages
}

/** Projects durable Messages and the last Provider response that contains their prefix. */
export function projectModelState(snapshot: AgentSessionSnapshot): ProjectedModelState {
  const messages: Message[] = []
  let continuation: ProviderContinuation | undefined
  const unfinished = recoverableTurn(snapshot)

  for (const turn of snapshot.turns) {
    if (turn.status !== 'completed' && turn.id !== unfinished?.id) continue

    messages.push({ role: 'user', content: turn.prompt })
    for (const step of turn.steps) {
      if (step.output.kind === 'final') {
        if (step.status === 'completed') {
          messages.push({ role: 'assistant', content: step.output.content })
          continuation = step.providerResponseId === undefined
            ? undefined
            : { responseId: step.providerResponseId, syncedMessageCount: messages.length }
        }
        continue
      }
      if (step.status !== 'completed') continue
      messages.push({
        role: 'assistant',
        toolCalls: step.output.executions.map(execution => execution.call),
      })
      continuation = step.providerResponseId === undefined
        ? undefined
        : { responseId: step.providerResponseId, syncedMessageCount: messages.length }
      for (const execution of step.output.executions) {
        const toolResult = execution.result ?? execution.error
        if (toolResult === undefined) continue
        messages.push({
          role: 'tool',
          toolCallId: execution.call.id,
          content: toolResult,
        })
      }
      for (const reminder of turn.loopGuardReminders.filter(
        candidate => candidate.afterStep === step.stepNumber,
      )) {
        messages.push({ role: 'user', content: reminder.content })
      }
    }
  }

  return {
    messages,
    ...(continuation === undefined ? {} : { continuation }),
  }
}
