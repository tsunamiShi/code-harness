import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../../src/runtime/agent-session.ts'
import { createTurnElapsedDisplay, formatElapsed } from '../../src/cli/turn-elapsed.ts'

const started: AgentEvent = { type: 'turn.started', turnId: 'turn-1', prompt: 'inspect' }
const step: AgentEvent = {
  type: 'step.started',
  turnId: 'turn-1',
  step: 1,
  messageCount: 1,
  toolCount: 2,
}
const completed: AgentEvent = {
  type: 'turn.completed',
  turnId: 'turn-1',
  steps: 1,
  durationMs: 1_500,
}

test('refreshes elapsed time while a Turn is active and stops on completion', () => {
  const output: string[] = []
  let currentTime = 0
  let refresh: (() => void) | undefined
  let cancelled = false
  let unreferenced = false
  const display = createTurnElapsedDisplay({
    enabled: true,
    write: text => output.push(text),
    now: () => currentTime,
    schedule: (callback, intervalMs) => {
      assert.equal(intervalMs, 1_000)
      refresh = callback
      return {
        cancel: () => { cancelled = true },
        unref: () => { unreferenced = true },
      }
    },
  })

  display.handle(started, () => output.push('TRACE started'))
  assert.equal(unreferenced, true)
  assert.deepEqual(output, ['TRACE started', '\r\u001B[2K⏱ Elapsed 00:00'])

  currentTime = 1_250
  refresh?.()
  assert.equal(output.at(-1), '\r\u001B[2K⏱ Elapsed 00:01')

  display.handle(step, () => output.push('TRACE step'))
  assert.deepEqual(output.slice(-3), [
    '\r\u001B[2K',
    'TRACE step',
    '\r\u001B[2K⏱ Elapsed 00:01',
  ])

  display.handle(completed, () => output.push('TRACE completed'))
  assert.deepEqual(output.slice(-2), ['\r\u001B[2K', 'TRACE completed'])
  assert.equal(cancelled, true)
})

test('does not schedule or render elapsed time outside a TTY', () => {
  const output: string[] = []
  let scheduled = false
  const display = createTurnElapsedDisplay({
    enabled: false,
    write: text => output.push(text),
    schedule: () => {
      scheduled = true
      return { cancel: () => undefined }
    },
  })

  display.handle(started, () => output.push('TRACE started'))
  assert.deepEqual(output, ['TRACE started'])
  assert.equal(scheduled, false)
})

test('temporarily clears and restores elapsed time around shortcut output', () => {
  const output: string[] = []
  const display = createTurnElapsedDisplay({
    enabled: true,
    write: text => output.push(text),
    now: () => 2_000,
    schedule: () => ({ cancel: () => undefined }),
  })

  display.handle(started, () => undefined)
  display.interject(() => output.push('Trace mode: verbose'))

  assert.deepEqual(output.slice(-3), [
    '\r\u001B[2K',
    'Trace mode: verbose',
    '\r\u001B[2K⏱ Elapsed 00:00',
  ])
})

test('clears and cancels an active display when the CLI closes', () => {
  const output: string[] = []
  let cancelled = false
  const display = createTurnElapsedDisplay({
    enabled: true,
    write: text => output.push(text),
    now: () => 0,
    schedule: () => ({ cancel: () => { cancelled = true } }),
  })

  display.handle(started, () => undefined)
  display.close()

  assert.equal(output.at(-1), '\r\u001B[2K')
  assert.equal(cancelled, true)
})

test('formats minute and hour durations', () => {
  assert.equal(formatElapsed(0), '00:00')
  assert.equal(formatElapsed(61_999), '01:01')
  assert.equal(formatElapsed(3_661_000), '1:01:01')
})
