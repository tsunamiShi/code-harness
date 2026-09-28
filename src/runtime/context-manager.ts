import type {
  AgentSessionSnapshot,
  CompletedStepCursor,
  ContextCompactionReason,
  ContextCompactionTrigger,
  ProjectedModelState,
  SessionStore,
  SummaryCheckpointPayloadV1,
} from './session-store.ts'
import {
  latestCompletedStepCursor,
  projectModelState,
  projectModelStateThrough,
} from './session-store.ts'
import type { Message, ModelOutput, ToolDescription } from './types.ts'

const MAX_RETAINED_USER_TOKENS = 20_000
const MANUAL_RETAINED_USER_TOKENS = 8_000
const MAX_COMPACTION_TOOL_RESULT_TOKENS = 10_000
const DEFAULT_MANUAL_SOURCE_LIMIT_TOKENS = 100_000
const CHECKPOINT_PREFIX = '[Context checkpoint]'

export interface TokenEstimator {
  estimate(value: unknown): number
  estimateText(value: string): number
}

export class FallbackTokenEstimator implements TokenEstimator {
  estimate(value: unknown): number {
    return this.estimateText(JSON.stringify(value) ?? String(value))
  }

  estimateText(value: string): number {
    return Math.max(1, Math.ceil(textUnits(value) / 4))
  }
}

export interface ContextLimits {
  contextWindowTokens?: number
  autoCompactTokenLimit?: number
}

export interface ContextCompactionResult {
  checkpointNumber: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  state: ProjectedModelState
}

export interface ContextUsage {
  estimatedTokens: number
  contextWindowTokens?: number
  autoCompactTokenLimit?: number
}

export type ContextManagerEvent =
  | {
      type: 'context.compaction-started'
      trigger: ContextCompactionTrigger
      estimatedTokensBefore: number
    }
  | {
      type: 'context.compaction-completed'
      trigger: ContextCompactionTrigger
      checkpointNumber: number
      estimatedTokensBefore: number
      estimatedTokensAfter: number
    }
  | {
      type: 'context.compaction-failed'
      trigger: ContextCompactionTrigger
      error: string
    }

export interface ContextManagerOptions {
  store: SessionStore
  limits?: ContextLimits
  tokenEstimator?: TokenEstimator
  projectSystemMessage?: Message
  summarize: (input: {
    turnId: string
    step: number
    messages: readonly Message[]
  }) => Promise<ModelOutput>
  onEvent?: (event: ContextManagerEvent) => void
}

/** Owns token-budget checks and durable Context Checkpoint installation. */
export class ContextManager {
  private readonly estimator: TokenEstimator
  private readonly automaticLimit: number | undefined

  constructor(private readonly options: ContextManagerOptions) {
    this.estimator = options.tokenEstimator ?? new FallbackTokenEstimator()
    this.automaticLimit = resolveAutomaticLimit(options.limits)
  }

  async prepareForInvocation(input: {
    sessionId: string
    turnId: string
    step: number
    state: ProjectedModelState
    tools: readonly ToolDescription[]
  }): Promise<ProjectedModelState> {
    if (this.automaticLimit === undefined) return input.state
    const snapshot = await this.requireSnapshot(input.sessionId)
    const localEstimate = this.estimateInput(input.state.messages, input.tools)
    const estimatedTokensBefore = Math.max(localEstimate, snapshot.latestInputTokens ?? 0)
    if (estimatedTokensBefore < this.automaticLimit) return input.state
    return (await this.compact({
      sessionId: input.sessionId,
      snapshot,
      turnId: input.turnId,
      step: input.step,
      tools: input.tools,
      trigger: 'automatic',
      reason: 'token-limit',
      estimatedTokensBefore,
    })).state
  }

  async compactManually(input: {
    sessionId: string
    tools: readonly ToolDescription[]
  }): Promise<ContextCompactionResult> {
    const snapshot = await this.requireSnapshot(input.sessionId)
    const cursor = requireNewCursor(snapshot, 'manual')
    return await this.compact({
      sessionId: input.sessionId,
      snapshot,
      turnId: cursor.turnId,
      step: cursor.stepNumber,
      tools: input.tools,
      trigger: 'manual',
      reason: 'user-requested',
      estimatedTokensBefore: Math.max(
        this.estimateInput(projectModelState(snapshot).messages, input.tools),
        snapshot.latestInputTokens ?? 0,
      ),
    })
  }

  /** Estimates the complete logical context that the next Model Invocation would continue from. */
  estimateUsage(input: {
    messages: readonly Message[]
    tools: readonly ToolDescription[]
    providerInputTokens?: number
  }): ContextUsage {
    const estimatedTokens = Math.max(
      this.estimateInput(input.messages, input.tools),
      input.providerInputTokens ?? 0,
    )
    return {
      estimatedTokens,
      ...(this.options.limits?.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: this.options.limits.contextWindowTokens }),
      ...(this.automaticLimit === undefined
        ? {}
        : { autoCompactTokenLimit: this.automaticLimit }),
    }
  }

  private async compact(input: {
    sessionId: string
    snapshot: AgentSessionSnapshot
    turnId: string
    step: number
    tools: readonly ToolDescription[]
    trigger: ContextCompactionTrigger
    reason: ContextCompactionReason
    estimatedTokensBefore: number
  }): Promise<ContextCompactionResult> {
    this.options.onEvent?.({
      type: 'context.compaction-started',
      trigger: input.trigger,
      estimatedTokensBefore: input.estimatedTokensBefore,
    })
    try {
      const cursor = requireNewCursor(input.snapshot, input.trigger)
      const sourceState = projectModelStateThrough(input.snapshot, cursor)
      const source = fitCompactionSource({
        messages: sourceState.messages,
        ...(this.options.projectSystemMessage === undefined
          ? {}
          : { systemMessage: this.options.projectSystemMessage }),
        estimator: this.estimator,
        tokenLimit: this.automaticLimit
          ?? this.options.limits?.contextWindowTokens
          ?? DEFAULT_MANUAL_SOURCE_LIMIT_TOKENS,
      })
      const output = await this.options.summarize({
        turnId: input.turnId,
        step: input.step,
        messages: source.messages,
      })
      if (output.kind !== 'final') {
        throw new ContextCompactionError('Compaction model returned Tool Calls instead of a summary')
      }
      const summary = output.content.trim()
      if (summary.length === 0) throw new ContextCompactionError('Compaction model returned an empty summary')

      const checkpointNumber = (input.snapshot.contextCheckpoint?.checkpointNumber ?? 0) + 1
      const payload = createReplacementPayload({
        snapshot: input.snapshot,
        cursor,
        summary,
        estimator: this.estimator,
        retentionTokenLimit: this.automaticLimit === undefined
          ? MANUAL_RETAINED_USER_TOKENS
          : Math.min(MAX_RETAINED_USER_TOKENS, Math.floor(this.automaticLimit * 0.25)),
      })
      const candidateSnapshot: AgentSessionSnapshot = {
        ...input.snapshot,
        contextCheckpoint: {
          checkpointNumber,
          coveredThroughStepId: cursor.stepId,
          coveredThroughTurnId: cursor.turnId,
          coveredThroughTurnNumber: cursor.turnNumber,
          coveredThroughStepNumber: cursor.stepNumber,
          trigger: input.trigger,
          reason: input.reason,
          payload,
          estimatedTokensBefore: input.estimatedTokensBefore,
        },
      }
      const candidateState = projectModelState(candidateSnapshot)
      const estimatedTokensAfter = this.estimateInput(candidateState.messages, input.tools)
      if (
        estimatedTokensAfter >= input.estimatedTokensBefore
        || (input.trigger === 'automatic'
          && this.automaticLimit !== undefined
          && estimatedTokensAfter >= this.automaticLimit)
      ) {
        throw new ContextCompactionIneffectiveError(
          `Context compaction did not reduce the estimate below the required budget (${estimatedTokensAfter} tokens)`,
        )
      }

      await this.options.store.record(input.sessionId, {
        type: 'context.compacted',
        turnId: input.turnId,
        step: input.step,
        expectedCheckpointNumber: checkpointNumber - 1,
        coveredThroughStepId: cursor.stepId,
        trigger: input.trigger,
        reason: input.reason,
        payload,
        estimatedTokensBefore: input.estimatedTokensBefore,
        estimatedTokensAfter,
      })
      const installed = await this.requireSnapshot(input.sessionId)
      const state = projectModelState(installed)
      this.options.onEvent?.({
        type: 'context.compaction-completed',
        trigger: input.trigger,
        checkpointNumber,
        estimatedTokensBefore: input.estimatedTokensBefore,
        estimatedTokensAfter,
      })
      return {
        checkpointNumber,
        estimatedTokensBefore: input.estimatedTokensBefore,
        estimatedTokensAfter,
        state,
      }
    } catch (error: unknown) {
      this.options.onEvent?.({
        type: 'context.compaction-failed',
        trigger: input.trigger,
        error: errorMessage(error),
      })
      throw error
    }
  }

  private estimateInput(messages: readonly Message[], tools: readonly ToolDescription[]): number {
    return this.estimator.estimate({
      messages: this.options.projectSystemMessage === undefined
        ? messages
        : [this.options.projectSystemMessage, ...messages],
      tools,
    })
  }

  private async requireSnapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    const snapshot = await this.options.store.loadSession(sessionId)
    if (!snapshot) throw new Error(`Unknown session: ${sessionId}`)
    return snapshot
  }
}

export class ContextCompactionError extends Error {}
export class NothingToCompactError extends ContextCompactionError {}
export class ContextCompactionIneffectiveError extends ContextCompactionError {}
export class ContextWindowBudgetExceededError extends ContextCompactionError {}

function resolveAutomaticLimit(limits: ContextLimits | undefined): number | undefined {
  const contextWindow = limits?.contextWindowTokens
  const configuredLimit = limits?.autoCompactTokenLimit
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) {
    throw new Error('contextWindowTokens must be a positive safe integer')
  }
  if (configuredLimit !== undefined && (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1)) {
    throw new Error('autoCompactTokenLimit must be a positive safe integer')
  }
  const maximum = contextWindow === undefined ? undefined : Math.floor(contextWindow * 0.9)
  if (maximum !== undefined && maximum < 1) {
    throw new Error('contextWindowTokens is too small to derive an automatic compaction limit')
  }
  if (configuredLimit !== undefined && maximum !== undefined && configuredLimit > maximum) {
    throw new Error('autoCompactTokenLimit may not exceed 90% of contextWindowTokens')
  }
  return configuredLimit ?? maximum
}

function requireNewCursor(
  snapshot: AgentSessionSnapshot,
  trigger: ContextCompactionTrigger,
): CompletedStepCursor {
  const cursor = latestCompletedStepCursor(snapshot)
  if (cursor === undefined) {
    if (trigger === 'manual') {
      throw new NothingToCompactError('There is no completed Step to compact')
    }
    throw new ContextWindowBudgetExceededError(
      'Context cannot be compacted before a completed Step exists',
    )
  }
  if (snapshot.contextCheckpoint?.coveredThroughStepId === cursor.stepId) {
    if (trigger === 'manual') {
      throw new NothingToCompactError(
        'There is no completed Step after the latest Context Checkpoint',
      )
    }
    throw new ContextWindowBudgetExceededError(
      'The context limit was reached before another completed Step became available',
    )
  }
  return cursor
}

function fitCompactionSource(input: {
  messages: readonly Message[]
  systemMessage?: Message
  estimator: TokenEstimator
  tokenLimit: number
}): { messages: readonly Message[]; incomplete: boolean } {
  const prepared = input.messages.map(message => message.role === 'tool'
    ? { ...message, content: truncateTextMiddle(message.content, MAX_COMPACTION_TOOL_RESULT_TOKENS) }
    : structuredClone(message))
  const groups = groupMessages(prepared)
  let incomplete = false
  const instruction = (): Message => ({
    role: 'user',
    content: summaryInstruction(incomplete),
  })
  const request = (): Message[] => [
    ...(input.systemMessage === undefined ? [] : [input.systemMessage]),
    ...groups.flat(),
    instruction(),
  ]
  while (groups.length > 0 && input.estimator.estimate(request()) > input.tokenLimit) {
    groups.shift()
    incomplete = true
  }
  if (groups.length === 0 || input.estimator.estimate(request()) > input.tokenLimit) {
    throw new ContextCompactionError('No viable durable context fits the compaction request budget')
  }
  return { messages: request(), incomplete }
}

function groupMessages(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role === 'assistant' && 'toolCalls' in message) {
      const group: Message[] = [message]
      while (messages[index + 1]?.role === 'tool') group.push(messages[++index]!)
      groups.push(group)
    } else {
      groups.push([message])
    }
  }
  return groups
}

function createReplacementPayload(input: {
  snapshot: AgentSessionSnapshot
  cursor: CompletedStepCursor
  summary: string
  estimator: TokenEstimator
  retentionTokenLimit: number
}): SummaryCheckpointPayloadV1 {
  const prompts = input.snapshot.turns
    .filter(turn => turn.turnNumber <= input.cursor.turnNumber)
    .map(turn => turn.prompt)
  const retained: string[] = []
  let remaining = Math.max(1, input.retentionTokenLimit)
  for (const prompt of prompts.toReversed()) {
    const tokens = input.estimator.estimateText(prompt)
    if (tokens <= remaining) {
      retained.push(prompt)
      remaining -= tokens
      continue
    }
    if (retained.length === 0) {
      retained.push(truncateTextMiddleWithEstimator(prompt, remaining, input.estimator))
    }
    break
  }
  retained.reverse()
  return {
    version: 1,
    kind: 'summary',
    messages: [
      ...retained.map(content => ({ role: 'user' as const, content })),
      { role: 'user', content: `${CHECKPOINT_PREFIX}\n${input.summary}` },
    ],
  }
}

function summaryInstruction(incomplete: boolean): string {
  return [
    'Create a concise context handoff for the next model invocation.',
    'Preserve the active user goal and authorization constraints; decisions and confirmed facts;',
    'completed mutations and validation evidence; unresolved work and the next concrete action;',
    'exact paths, identifiers, errors, and commands still needed; and Tool side effects whose outcome is unknown.',
    'Do not invent facts. Return only the handoff text and do not call tools.',
    ...(incomplete ? ['The oldest durable source groups were omitted to fit the compaction request.'] : []),
  ].join(' ')
}

function truncateTextMiddle(value: string, maxTokens: number): string {
  if (maxTokens < 1) return '…'
  if (Math.ceil(textUnits(value) / 4) <= maxTokens) return value
  const marker = '\n… context omitted …\n'
  const budget = Math.max(0, maxTokens * 4 - textUnits(marker))
  const points = [...value]
  let head = ''
  let tail = ''
  let headUnits = 0
  let tailUnits = 0
  const half = Math.floor(budget / 2)
  for (const point of points) {
    const units = codePointUnits(point)
    if (headUnits + units > half) break
    head += point
    headUnits += units
  }
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!
    const units = codePointUnits(point)
    if (tailUnits + units > budget - headUnits) break
    tail = point + tail
    tailUnits += units
  }
  return head + marker + tail
}

function truncateTextMiddleWithEstimator(
  value: string,
  maxTokens: number,
  estimator: TokenEstimator,
): string {
  if (maxTokens < 1) return '…'
  if (estimator.estimateText(value) <= maxTokens) return value
  const points = [...value]
  const marker = '\n… context omitted …\n'
  if (estimator.estimateText(marker) > maxTokens) return '…'
  let lower = 0
  let upper = points.length
  let result = marker
  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2)
    const headLength = Math.ceil(retained / 2)
    const tailLength = Math.floor(retained / 2)
    const candidate = points.slice(0, headLength).join('')
      + marker
      + (tailLength === 0 ? '' : points.slice(-tailLength).join(''))
    if (estimator.estimateText(candidate) <= maxTokens) {
      result = candidate
      lower = retained + 1
    } else {
      upper = retained - 1
    }
  }
  return result
}

function textUnits(value: string): number {
  let units = 0
  for (const point of value) units += codePointUnits(point)
  return units
}

function codePointUnits(value: string): number {
  return value.codePointAt(0)! <= 0x7f ? 1 : 4
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
