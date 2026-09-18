import assert from 'node:assert/strict'
import test from 'node:test'

import { createConsoleTrace } from '../../src/cli/console-trace.ts'
import type { AgentEvent } from '../../src/runtime/agent-session.ts'

test('renders model reasoning, tool arguments, result content, and turn summary', () => {
  const output: string[] = []
  const trace = createConsoleTrace({
    write: text => output.push(text),
    colors: false,
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
  assert.match(rendered, /12345678\n│    … 2 more characters omitted/)
  assert.match(rendered, /Turn completed 1 steps · 1\.30s/)
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
