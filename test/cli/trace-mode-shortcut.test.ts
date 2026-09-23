import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createTraceModeShortcut } from '../../src/cli/trace-mode-shortcut.ts'

test('toggles on Ctrl+O and detaches cleanly', () => {
  const input = new EventEmitter()
  let toggles = 0
  const shortcut = createTraceModeShortcut({
    enabled: true,
    input,
    onToggle: () => { toggles += 1 },
  })

  input.emit('keypress', 'o', { ctrl: false, name: 'o' })
  input.emit('keypress', '\u000F', { ctrl: true, name: 'o' })
  assert.equal(toggles, 1)

  shortcut.close()
  input.emit('keypress', '\u000F', { ctrl: true, name: 'o' })
  assert.equal(toggles, 1)
})

test('does not bind the shortcut outside an interactive terminal', () => {
  const input = new EventEmitter()
  let toggles = 0
  createTraceModeShortcut({
    enabled: false,
    input,
    onToggle: () => { toggles += 1 },
  })

  input.emit('keypress', '\u000F', { ctrl: true, name: 'o' })
  assert.equal(toggles, 0)
})
