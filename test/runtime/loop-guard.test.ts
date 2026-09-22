import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ModelRepeatLoopGuard,
  NoProgressLoopGuard,
  trailingRepeatCount,
  trailingStepsWithoutProgress,
  type LoopGuardCall,
  type LoopGuardStep,
} from '../../src/runtime/loop-guard.ts'
import type { Message, Model } from '../../src/runtime/types.ts'

test('uses an isolated tool-free model call to produce a weak repeat reminder', async () => {
  let observedMessages: readonly Message[] = []
  let observedToolCount = -1
  let observedMaxTokens: number | undefined
  const model: Model = {
    async generate(input) {
      observedMessages = structuredClone(input.messages)
      observedToolCount = input.tools.length
      observedMaxTokens = input.maxTokens
      return { kind: 'final', content: 'Read the existing result before trying a different path.' }
    },
  }
  const guard = new ModelRepeatLoopGuard(model, { thresholds: [8, 3, 5] })
  const steps = [1, 2, 3].map(stepNumber => ({
    stepNumber,
    calls: [call('Read', { endLine: 10, path: '/project/a.ts' })],
  }))

  const reminder = await guard.review({
    originalPrompt: 'Diagnose the failure.',
    steps,
    reminders: [],
  })

  assert.equal(observedToolCount, 0)
  assert.equal(observedMaxTokens, 2048)
  assert.equal(observedMessages.length, 1)
  assert.equal(observedMessages[0]?.role, 'user')
  assert.match(observedMessages[0]?.role === 'user' ? observedMessages[0].content : '', /Consecutive identical calls: 3/)
  assert.deepEqual(reminder, {
    kind: 'exact-repeat',
    metric: 3,
    summary: 'Read × 3',
    content: 'Loop Guard reminder (Read × 3):\nRead the existing result before trying a different path.',
  })
})

test('fails open when the repeat guard model declines or fails', async () => {
  const noReminder = new ModelRepeatLoopGuard({
    async generate() {
      return { kind: 'final', content: 'NO_REMINDER' }
    },
  }, { thresholds: [3] })
  const failed = new ModelRepeatLoopGuard({
    async generate() {
      throw new Error('provider unavailable')
    },
  }, { thresholds: [3] })
  const input = {
    originalPrompt: 'Wait for a status change.',
    steps: [1, 2, 3].map(stepNumber => ({ stepNumber, calls: [call('Poll', {})] })),
    reminders: [],
  }

  assert.equal(await noReminder.review(input), undefined)
  assert.equal(await failed.review(input), undefined)
})

test('counts only the trailing canonically equal Tool Calls', () => {
  assert.equal(trailingRepeatCount([
    call('Read', { path: '/a', start: 1 }),
    call('Read', { start: 1, path: '/a' }),
    call('Read', { path: '/a', start: 1 }),
  ]), 3)
  assert.equal(trailingRepeatCount([
    call('Read', { path: '/a' }),
    call('Read', { path: '/b' }),
  ]), 1)
})

test('emits deterministic advice at configured no-progress thresholds', async () => {
  const guard = new NoProgressLoopGuard({ thresholds: [4, 2] })
  const steps: LoopGuardStep[] = [
    { stepNumber: 1, calls: [call('Read', { path: '/a' })] },
    { stepNumber: 2, calls: [call('Bash', { command: 'test' }, 'execute')] },
  ]

  const reminder = await guard.review({ originalPrompt: 'Implement it.', steps, reminders: [] })

  assert.equal(trailingStepsWithoutProgress(steps), 2)
  assert.equal(reminder?.kind, 'no-progress')
  assert.equal(reminder?.metric, 2)
  assert.match(reminder?.content ?? '', /start modifying and validating the code/)
  assert.match(reminder?.content ?? '', /does not require a file change/)
})

test('a successful mutating Tool resets no-progress Step counting', () => {
  const steps: LoopGuardStep[] = [
    { stepNumber: 1, calls: [call('Read', {})] },
    { stepNumber: 2, calls: [call('Write', {}, 'mutate')] },
    { stepNumber: 3, calls: [call('Read', {})] },
    { stepNumber: 4, calls: [{ ...call('Edit', {}, 'mutate'), failed: true }] },
  ]

  assert.equal(trailingStepsWithoutProgress(steps), 2)
})

test('rejects unusable threshold configurations', () => {
  const model: Model = { async generate() { return { kind: 'final', content: 'unused' } } }
  assert.throws(() => new ModelRepeatLoopGuard(model, { thresholds: [] }), /must not be empty/)
  assert.throws(() => new NoProgressLoopGuard({ thresholds: [1] }), /greater than one/)
  assert.throws(() => new NoProgressLoopGuard({ thresholds: [3, 3] }), /duplicates/)
})

function call(
  name: string,
  arguments_: unknown,
  effect: LoopGuardCall['effect'] = 'observe',
): LoopGuardCall {
  return { name, arguments: arguments_, result: 'result', failed: false, effect }
}
