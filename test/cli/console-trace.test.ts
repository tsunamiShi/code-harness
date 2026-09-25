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

  for (const event of events) trace.handle(event)
  const rendered = output.join('\n')

  assert.match(rendered, /Turn started 12345678/)
  assert.match(rendered, /Step 1 model request · 2 messages · 3 tools/)
  assert.match(rendered, /Provider reasoning\n│    Need source\./)
  assert.match(rendered, /Model content\n│    I will inspect the file\./)
  assert.match(rendered, /Read call-1/)
  assert.match(rendered, /path: src\/app\.ts/)
  assert.doesNotMatch(rendered, /[{}]/)
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

  trace.handle({ type: 'tool.batch-started', turnId: 'turn', step: 1, mode: 'parallel', count: 2 })
  trace.handle({
    type: 'tool.started',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-a', name: 'Read', arguments: { path: '/project/src/a.ts' } },
  })
  trace.handle(read('read-a', '/project/src/a.ts', 12))
  trace.handle(read('read-b', '/project/src/b.ts', 25))
  trace.handle({ type: 'step.started', turnId: 'turn', step: 2, messageCount: 5, toolCount: 7 })

  const rendered = output.join('\n')
  assert.match(rendered, /Inspected 2 · Read ×2/)
  assert.match(rendered, /\/project\/src\/a\.ts, \/project\/src\/b\.ts/)
  assert.match(rendered, /slowest 25ms/)
  assert.doesNotMatch(rendered, /Arguments/)
  assert.doesNotMatch(rendered, /full source/)
  assert.doesNotMatch(rendered, /tool batch/)
})

test('compact mode summarizes failed inspection Tools with one actionable error line', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'read-failed', name: 'Read', arguments: { path: '/missing.ts' } },
    durationMs: 3,
    failed: true,
    content: 'Error: file not found',
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Read failed 3ms · \/missing\.ts · Error: file not found/)
  assert.doesNotMatch(rendered, /Arguments|Result/)
})

test('compact mode shows a Bash command without its result', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({
    type: 'tool.started',
    turnId: 'turn',
    step: 1,
    call: {
      id: 'bash-1',
      name: 'Bash',
      arguments: { cwd: '/project', command: 'pnpm test' },
    },
  })
  trace.handle({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: {
      id: 'bash-1',
      name: 'Bash',
      arguments: { cwd: '/project', command: 'pnpm test' },
    },
    durationMs: 30,
    failed: false,
    content: '{"exitCode":0,"stdout":"91 tests passed"}',
  })

  const rendered = output.join('\n')
  assert.match(rendered, /▶ Bash pnpm test/)
  assert.doesNotMatch(rendered, /91 tests passed|Result|exitCode/)
})

test('compact mode omits terminal reasoning when no streamed deltas were emitted', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({
    type: 'model.completed',
    turnId: 'turn',
    step: 1,
    durationMs: 500,
    output: {
      kind: 'tool-calls',
      content: 'I will inspect the configuration.',
      reasoningContent: 'A long provider reasoning trace.',
      calls: [{ id: 'read-1', name: 'Read', arguments: { path: '/project/config.ts' } }],
    },
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Model responded 1 tool call · 500ms/)
  assert.match(rendered, /Plan I will inspect the configuration\./)
  assert.doesNotMatch(rendered, /provider reasoning|A long provider reasoning trace/i)
})

test('verbose mode renders JSON Tool Results as named fields', () => {
  const output: string[] = []
  const trace = createConsoleTrace({
    write: text => output.push(text),
    colors: false,
    mode: 'verbose',
  })

  trace.handle({
    type: 'tool.completed',
    turnId: 'turn',
    step: 1,
    call: { id: 'bash-1', name: 'Bash', arguments: { command: 'pnpm test' } },
    durationMs: 20,
    failed: false,
    content: JSON.stringify({
      cwd: '/project',
      command: 'pnpm test',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 18,
      stdout: '91 tests passed',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  })

  const rendered = output.join('\n')
  assert.match(rendered, /exitCode: 0/)
  assert.match(rendered, /timedOut: false/)
  assert.match(rendered, /stdout: 91 tests passed/)
  assert.doesNotMatch(rendered, /"exitCode"|[{}]/)
})

test('bounds expanded Tool Results with useful head and tail content', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })
  trace.toggleMode()

  trace.handle({
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
    mode: 'verbose',
  })

  trace.handle({
    type: 'model.completed',
    turnId: 'turn',
    step: 1,
    durationMs: 1,
    output: { kind: 'final', content: 'done' },
  })

  assert.match(output.join('\n'), /Provider reasoning: not returned/)
  assert.match(output.join('\n'), /Final content\n│    preview: done/)
})

test('renders streamed reasoning and output in compact mode without repeating completed content', () => {
  const lines: string[] = []
  const fragments: string[] = []
  const trace = createConsoleTrace({
    write: text => lines.push(text),
    writeFragment: text => fragments.push(text),
    colors: false,
  })

  trace.handle({
    type: 'model.delta',
    turnId: 'turn',
    step: 1,
    event: { type: 'reasoning', delta: 'think ' },
  })
  trace.handle({
    type: 'model.delta',
    turnId: 'turn',
    step: 1,
    event: { type: 'reasoning', delta: 'carefully' },
  })
  trace.handle({
    type: 'model.delta',
    turnId: 'turn',
    step: 1,
    event: { type: 'output-text', delta: 'final answer' },
  })
  trace.handle({
    type: 'model.completed',
    turnId: 'turn',
    step: 1,
    durationMs: 20,
    output: {
      kind: 'final',
      reasoningContent: 'think carefully',
      content: 'final answer',
    },
  })

  assert.equal(fragments.join(''), '│  Provider reasoning\n│    think carefully\n│  Final content\n│    final answer\n')
  assert.match(lines.join('\n'), /Model responded final answer · 20ms/)
  assert.doesNotMatch(lines.join('\n'), /think carefully|Final content\n│    final answer/)
})

test('verbose mode renders provider headers, first SSE event, completion, and transport causes', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false, mode: 'verbose' })

  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: { type: 'started', attempt: 1 },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: {
      type: 'headers-received',
      attempt: 1,
      httpStatus: 200,
      durationMs: 1_200,
    },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: {
      type: 'first-event',
      attempt: 1,
      eventType: 'response.created',
      durationMs: 1_350,
    },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: {
      type: 'completed',
      attempt: 1,
      httpStatus: 200,
      durationMs: 2_500,
      eventCount: 12,
    },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 2,
    event: {
      type: 'failed',
      attempt: 2,
      phase: 'requesting',
      durationMs: 300_000,
      eventCount: 0,
      errorName: 'TypeError',
      errorMessage: 'fetch failed',
      causeCode: 'UND_ERR_HEADERS_TIMEOUT',
    },
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Provider attempt 1 started/)
  assert.match(rendered, /Response headers HTTP 200 · 1\.20s/)
  assert.match(rendered, /First SSE event response\.created · 1\.35s/)
  assert.match(rendered, /SSE completed 12 events · 2\.50s/)
  assert.match(rendered, /Provider attempt 2 failed requesting · 300\.00s · UND_ERR_HEADERS_TIMEOUT/)
})

test('compact mode combines provider timing milestones and can toggle to semantic verbose fields', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: { type: 'started', attempt: 1 },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: { type: 'headers-received', attempt: 1, httpStatus: 200, durationMs: 400 },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: {
      type: 'first-event',
      attempt: 1,
      eventType: 'response.created',
      durationMs: 450,
    },
  })
  trace.handle({
    type: 'model.attempt',
    turnId: 'turn',
    step: 1,
    event: { type: 'completed', attempt: 1, httpStatus: 200, durationMs: 900, eventCount: 20 },
  })

  assert.deepEqual(output, ['│  ✓ SSE completed 20 events · headers 400ms · first 450ms · total 900ms'])
  assert.equal(trace.toggleMode(), 'verbose')
  assert.equal(trace.getMode(), 'verbose')
  trace.handle({
    type: 'tool.started',
    turnId: 'turn',
    step: 2,
    call: {
      id: 'bash-2',
      name: 'Bash',
      arguments: { cwd: '/project', command: 'pnpm typecheck', timeoutMs: 30_000 },
    },
  })
  const rendered = output.join('\n')
  assert.match(rendered, /command: pnpm typecheck/)
  assert.match(rendered, /cwd: \/project/)
  assert.match(rendered, /timeoutMs: 30000/)
  assert.doesNotMatch(rendered, /"command"|[{}]/)
  assert.equal(trace.toggleMode(), 'compact')
})

test('renders Loop Guard reminders as execution-chain checkpoints', () => {
  const output: string[] = []
  const trace = createConsoleTrace({ write: text => output.push(text), colors: false })

  trace.handle({
    type: 'loop-guard.reminded',
    turnId: 'turn',
    afterStep: 3,
    kind: 'exact-repeat',
    metric: 3,
    summary: 'Read × 3',
    content: 'Inspect the existing result before repeating the call.',
  })

  const rendered = output.join('\n')
  assert.match(rendered, /Loop Guard reminder/)
  assert.match(rendered, /Read × 3 · after step 3/)
  assert.match(rendered, /Inspect the existing result/)
})
