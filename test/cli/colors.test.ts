import assert from 'node:assert/strict'
import test from 'node:test'

import { createColor, supportsColor } from '../../src/cli/colors.ts'
import { createConsoleTrace } from '../../src/cli/console-trace.ts'
import { createMarkdownRenderer } from '../../src/cli/markdown.ts'
import { createTurnElapsedDisplay } from '../../src/cli/turn-elapsed.ts'
import type { AgentEvent } from '../../src/runtime/agent-session.ts'

test('createColor applies SGR sequences only when enabled', () => {
  const on = createColor(true)
  const off = createColor(false)

  assert.equal(on.bold('x'), '\u001B[1mx\u001B[0m')
  assert.equal(on.boldCyan('x'), '\u001B[1;36mx\u001B[0m')
  assert.equal(on.dimItalic('x'), '\u001B[2;3mx\u001B[0m')
  assert.equal(off.boldCyan('x'), 'x')
  assert.equal(off.dim('x'), 'x')
})

test('supportsColor requires a TTY and rejects NO_COLOR', () => {
  const original = process.env.NO_COLOR
  try {
    delete process.env.NO_COLOR
    assert.equal(supportsColor({ isTTY: true }), true)
    assert.equal(supportsColor({ isTTY: false }), false)
    assert.equal(supportsColor({}), false)
    process.env.NO_COLOR = '1'
    assert.equal(supportsColor({ isTTY: true }), false)
  } finally {
    if (original === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = original
  }
})

test('console trace dims structure glyphs and colors markers when colors are on', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: true })

  trace.handle({ type: 'turn.started', turnId: '12345678-rest', prompt: 'inspect' })
  trace.handle({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-failed', name: 'Read', arguments: { path: '/missing.ts' } },
    durationMs: 3,
    failed: true,
    content: 'Error: file not found',
  })
  trace.handle({
    type: 'turn.completed',
    turnId: 'turn',
    steps: 1,
    durationMs: 10,
    contextUsage: { estimatedTokens: 1_000, contextWindowTokens: 10_000 },
  })

  const rendered = output.join('\n')
  assert.match(rendered, /\u001B\[2m│\u001B\[0m {2}\u001B\[31m✗\u001B\[0m/)
  assert.match(rendered, /\u001B\[1;36mRead\u001B\[0m/)
  assert.match(rendered, /\u001B\[1;31mfailed\u001B\[0m/)
  assert.match(rendered, /\u001B\[1;32m└─ Turn completed\u001B\[0m/)
})

test('console trace emits no escape sequences when colors are off', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({ type: 'turn.started', turnId: '12345678-rest', prompt: 'inspect' })
  trace.handle({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-failed', name: 'Read', arguments: { path: '/missing.ts' } },
    durationMs: 3,
    failed: true,
    content: 'Error: file not found',
  })

  assert.doesNotMatch(output.join('\n'), /\u001B\[/)
})

test('markdown renderer applies the semantic palette only when colors are on', () => {
  const on = createMarkdownRenderer({ width: 40, colors: true })
  const off = createMarkdownRenderer({ width: 40, colors: false })

  const source = '# Title\n\n- item\n\n`code`'

  assert.match(on(source), /\u001B\[1;36mTitle\u001B\[0m/)
  assert.match(on(source), /\u001B\[33mcode\u001B\[0m/)
  assert.doesNotMatch(off(source), /\u001B\[/)
  assert.match(off(source), /Title/)
})

test('elapsed line colors degrade to plain text when disabled', () => {
  const output: string[] = []
  const display = createTurnElapsedDisplay({
    enabled: true,
    colors: false,
    write: text => output.push(text),
    now: () => 0,
    schedule: () => ({ cancel: () => undefined }),
  })

  display.handle(
    { type: 'turn.started', turnId: 'turn-1', prompt: 'inspect' },
    () => undefined,
  )

  assert.equal(output.at(-1), '\r\u001B[2K⏱ Elapsed 00:00')
})
