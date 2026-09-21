import type { Model } from './types.ts'

const REVIEW_MAX_TOKENS = 2_048

export interface LoopGuardCall {
  name: string
  arguments: unknown
  result: string
  failed: boolean
}

export interface LoopGuardReviewInput {
  originalPrompt: string
  repeatCount: number
  call: LoopGuardCall
}

export interface LoopGuardReminder {
  toolName: string
  repeatCount: number
  content: string
}

/** Reviews exact repeat-call chains without blocking or terminating the Agent Loop. */
export interface LoopGuard {
  readonly thresholds: readonly number[]
  review(input: LoopGuardReviewInput): Promise<LoopGuardReminder | undefined>
}

/** Uses a small independent model only after deterministic repeat detection reaches a threshold. */
export class ModelLoopGuard implements LoopGuard {
  readonly thresholds: readonly number[]

  constructor(
    private readonly model: Model,
    options: { thresholds: readonly number[] },
  ) {
    this.thresholds = validateThresholds(options.thresholds)
  }

  async review(input: LoopGuardReviewInput): Promise<LoopGuardReminder | undefined> {
    try {
      const output = await this.model.generate({
        messages: [{
          role: 'user',
          content: [
            'You are a lightweight loop reviewer for a code agent.',
            'The runtime detected consecutive calls to the exact same tool with canonically equal arguments.',
            'Decide whether the latest result shows legitimate progress.',
            'If no reminder is useful, reply with exactly NO_REMINDER.',
            'Otherwise reply with one concise advisory message telling the agent what evidence to inspect, what to change, or that it can finish.',
            'Do not claim authority to stop execution and do not output JSON.',
            '',
            `Original user request: ${input.originalPrompt}`,
            `Tool: ${input.call.name}`,
            `Consecutive identical calls: ${input.repeatCount}`,
            `Arguments: ${truncate(canonicalJson(input.call.arguments), 500)}`,
            `Latest result (${input.call.failed ? 'failed' : 'completed'}): ${truncate(input.call.result, 1_500)}`,
          ].join('\n'),
        }],
        tools: [],
        maxTokens: REVIEW_MAX_TOKENS,
      })
      if (output.kind !== 'final') return undefined
      const content = output.content.trim()
      if (content.length === 0 || content === 'NO_REMINDER') return undefined
      return {
        toolName: input.call.name,
        repeatCount: input.repeatCount,
        content: `Loop Guard reminder (${input.call.name} × ${input.repeatCount}):\n${content}`,
      }
    } catch {
      return undefined
    }
  }
}

/** Returns the exact-repeat length of the final call chain. */
export function trailingRepeatCount(calls: readonly LoopGuardCall[]): number {
  const last = calls.at(-1)
  if (last === undefined) return 0
  const key = callKey(last)
  let count = 0
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call === undefined || callKey(call) !== key) break
    count += 1
  }
  return count
}

function callKey(call: LoopGuardCall): string {
  return `${call.name}\n${canonicalJson(call.arguments)}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
  )
}

function validateThresholds(values: readonly number[]): readonly number[] {
  if (values.length === 0) throw new Error('Loop Guard thresholds must not be empty')
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 2) {
      throw new Error('Loop Guard thresholds must contain safe integers greater than one')
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('Loop Guard thresholds must not contain duplicates')
  }
  return [...values].sort((left, right) => left - right)
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
