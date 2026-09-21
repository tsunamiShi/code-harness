import assert from 'node:assert/strict'
import test from 'node:test'

import { createConsoleTrace } from '../../src/cli/console-trace.ts'
import type { AgentEvent } from '../../src/runtime/agent-session.ts'

test('verbose mode renders model reasoning, tool arguments, result content, and turn summary', () => {
  const output: string[] = []
  const trace = createConsoleTrace({
    write: text => output.push(text),
    colors: false,
    mode: 'verbose',
    maxToolResultChars: 8,
  })
  const events: AgentEvent[] = [
    { type: 'turn.started', turnId: '12345678-rest', prompt: 'inspect' },
    { type: 'step.started', turnId: '12345678-rest', step: 1, messageCount: 2, toolCount: 3 },
    {
      type: 'model.completed',
      turnId: '12345678-rest',
      step: 1,
      durationMs: 1_250,
      output: {
        kind: 'tool-calls',
        content: 'I will inspect the file.',
        reasoningContent: 'Need source.',
        calls: [{ id: 'call-1', name: 'Read', arguments: { path: 'src/app.ts' } }],
      },
    },
    { type: 'tool.batch-started', turnId: '12345678-rest', step: 1, mode: 'parallel', count: 1 },
    {
      type: 'tool.started',
      turnId: '12345678-rest',
      step: 1,
      call: { id: 'call-1', name: 'Read', arguments: { path: 'src/app.ts' } },
    },
    {
      type: 'tool.completed',
      turnId: '12345678-rest',
      step: 1,
      call: { id: 'call-1', name: 'Read', arguments: { path: 'src/app.ts' } },
      durationMs: 12,
      failed: false,
      content: '1234567890',
    },
    { type: 'turn.completed', turnId: '12345678-rest', steps: 1, durationMs: 1_300 },
  ]

  for (const event of events) trace(event)
  const rendered = output.join('\n')

  assert.match(rendered, /Turn started 12345678/)
  assert.match(rendered, /Step 1 model request · 2 messages · 3 tools/)
  assert.match(rendered, /Provider reasoning\n│    Need source\./)
  assert.match(rendered, /Model content\n│    I will inspect the file\./)
  assert.match(rendered, /Read call-1/)
  assert.match(rendered, /"path": "src\/app\.ts"/)
  assert.match(rendered, /12345\n│    … 2 characters omitted …\n│    890/)
  assert.match(rendered, /Turn completed 1 steps · 1\.30s/)
})

test('compact mode folds successful inspection Tools into one summary', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })
  const read = (id: string, path: string, durationMs: number): AgentEvent => ({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id, name: 'Read', arguments: { path } },
    durationMs,
    failed: false,
    content: `full source for ${path}`,
  })

  trace({ type: 'tool.batch-started', turnId: 'turn', step: 1, mode: 'parallel', count: 2 })
  trace({
    type: 'tool.started',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-a', name: 'Read', arguments: { path: '/project/src/a.ts' } },
  })
  trace(read('read-a', '/project/src/a.ts', 12))
  trace(read('read-b', '/project/src/b.ts', 25))
  trace({ type: 'step.started', turnId: 'turn', step: 2, messageCount: 5, toolCount: 7 })

  const rendered = output.join('\n')
  assert.match(rendered, /Inspected 2 · Read ×2/)
  assert.match(rendered, /\/project\/src\/a\.ts, \/project\/src\/b\.ts/)
  assert.match(rendered, /slowest 25ms/)
  assert.doesNotMatch(rendered, /Arguments/)
  assert.doesNotMatch(rendered, /full source/)
  assert.doesNotMatch(rendered, /tool batch/)
})

test('compact mode expands failed inspection Tools', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-failed', name: 'Read', arguments: { path: '/missing.ts' } },
    durationMs: 3,
    failed: true,
    content: 'Error: file not found',
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Read read-failed/)
  assert.match(rendered, /"path": "\/missing\.ts"/)
  assert.match(rendered, /Error: file not found/)
})

test('bounds expanded Tool Results with useful head and tail content', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'bash-long', name: 'Bash', arguments: { command: 'pnpm test' } },
    durationMs: 3,
    failed: false,
    content: `${'H'.repeat(700)}${'T'.repeat(200)}`,
  })

  const rendered = output.join('\n')
  assert.match(rendered, /H{500}/)
  assert.match(rendered, /… 100 characters omitted …/)
  assert.match(rendered, /T{200}/)
  assert.doesNotMatch(rendered, /H{501}/)
})

test('states when the provider returns no reasoning content', () => {
  const output: string[] = []
  const trace = createConsoleTrace({
    write: text => output.push(text),
    renderMarkdown: source => `preview: ${source}`,
  })

  trace({
    type: 'model.completed',
    turnId: 'turn',
    step: 1,
    durationMs: 1,
    output: { kind: 'final', content: 'done' },
  })

  assert.match(output.join('\n'), /Provider reasoning: not returned/)
  assert.match(output.join('\n'), /Final content\n│    preview: done/)
})

test('renders Loop Guard reminders as execution-chain checkpoints', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace({
    type: 'loop-guard.reminded',
    turnId: 'turn',
    afterStep: 3,
    toolName: 'Read',
    repeatCount: 3,
    content: 'Inspect the existing result before repeating the call.',
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Loop Guard reminder/)
  assert.match(rendered, /Read × 3 · after step 3/)
  assert.match(rendered, /Inspect the existing result/)
})
