import assert from 'node:assert/strict'
import test from 'node:test'

import { ModelLoopGuard, trailingRepeatCount } from '../../src/runtime/loop-guard.ts'
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
  const guard = new ModelLoopGuard(model, { thresholds: [8, 3, 5] })

  const reminder = await guard.review({
    originalPrompt: 'Diagnose the failure.',
    repeatCount: 3,
    call: {
      name: 'Read',
      arguments: { endLine: 10, path: '/project/a.ts' },
      result: 'source',
      failed: false,
    },
  })

  assert.deepEqual(guard.thresholds, [3, 5, 8])
  assert.equal(observedToolCount, 0)
  assert.equal(observedMaxTokens, 2048)
  assert.equal(observedMessages.length, 1)
  assert.equal(observedMessages[0]?.role, 'user')
  assert.match(observedMessages[0]?.role === 'user' ? observedMessages[0].content : '', /Consecutive identical calls: 3/)
  assert.deepEqual(reminder, {
    toolName: 'Read',
    repeatCount: 3,
    content: 'Loop Guard reminder (Read × 3):\nRead the existing result before trying a different path.',
  })
})

test('fails open when the guard model declines or fails', async () => {
  const noReminder = new ModelLoopGuard({
    async generate() {
      return { kind: 'final', content: 'NO_REMINDER' }
    },
  }, { thresholds: [3] })
  const failed = new ModelLoopGuard({
    async generate() {
      throw new Error('provider unavailable')
    },
  }, { thresholds: [3] })
  const input = {
    originalPrompt: 'Wait for a status change.',
    repeatCount: 3,
    call: { name: 'Poll', arguments: {}, result: 'pending', failed: false },
  }

  assert.equal(await noReminder.review(input), undefined)
  assert.equal(await failed.review(input), undefined)
})

test('counts only the trailing canonically equal Tool Calls', () => {
  assert.equal(trailingRepeatCount([
    { name: 'Read', arguments: { path: '/a', start: 1 }, result: 'a', failed: false },
    { name: 'Read', arguments: { start: 1, path: '/a' }, result: 'b', failed: false },
    { name: 'Read', arguments: { path: '/a', start: 1 }, result: 'c', failed: false },
  ]), 3)
  assert.equal(trailingRepeatCount([
    { name: 'Read', arguments: { path: '/a' }, result: 'a', failed: false },
    { name: 'Read', arguments: { path: '/b' }, result: 'b', failed: false },
  ]), 1)
})

test('rejects unusable threshold configurations', () => {
  const model: Model = { async generate() { return { kind: 'final', content: 'unused' } } }
  assert.throws(() => new ModelLoopGuard(model, { thresholds: [] }), /must not be empty/)
  assert.throws(() => new ModelLoopGuard(model, { thresholds: [1] }), /greater than one/)
  assert.throws(() => new ModelLoopGuard(model, { thresholds: [3, 3] }), /duplicates/)
})
