import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSession, runAgent, type AgentEvent } from '../../src/runtime/agent-session.ts'
import { NoProgressLoopGuard, type LoopGuard } from '../../src/runtime/loop-guard.ts'
import { ModelContinuationUnavailableError } from '../../src/runtime/model-errors.ts'
import type { SessionRecord, SessionStore } from '../../src/runtime/session-store.ts'
import { MemorySessionStore } from '../../src/storage/memory-session-store.ts'
import type { Message, Model, ModelOutput, Tool } from '../../src/runtime/types.ts'

test('feeds a tool result back to the model before returning the final answer', async () => {
  const recordedRequests: Message[][] = []
  let call = 0
  const model: Model = {
    async generate(input): Promise<ModelOutput> {
      recordedRequests.push([...input.messages])
      call += 1
      return call === 1
        ? {
            kind: 'tool-calls',
            calls: [{ id: 'call-1', name: 'search', arguments: { query: 'Nvidia' } }],
          }
        : { kind: 'final', content: 'done' }
    },
  }
  const search: Tool = {
    effect: 'observe',
    description: {
      name: 'search',
      description: 'Search the web.',
      parameters: { type: 'object' },
    },
    async execute(arguments_) {
      assert.deepEqual(arguments_, { query: 'Nvidia' })
      return 'result'
    },
  }

  const answer = await runAgent({ model, tools: [search], prompt: 'research' })

  assert.equal(answer, 'done')
  assert.deepEqual(recordedRequests[1], [
    { role: 'user', content: 'research' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: 'search', arguments: { query: 'Nvidia' } }],
    },
    { role: 'tool', toolCallId: 'call-1', content: 'result' },
  ])
})

test('keeps model-visible tools stable and executes discovered tools through ExecuteTool', async () => {
  const visibleTools: string[][] = []
  let invocation = 0
  let emailCalls = 0
  const sendEmail: Tool = {
    effect: 'execute',
    description: {
      name: 'mcp__mail__send_email',
      description: 'Send an email message to a recipient.',
      parameters: { type: 'object' },
    },
    async execute() {
      emailCalls += 1
      return 'sent'
    },
  }
  const model: Model = {
    async generate(input) {
      visibleTools.push(input.tools.map(tool => tool.name))
      invocation += 1
      if (invocation === 1) {
        return {
          kind: 'tool-calls',
          calls: [{ id: 'search-mail', name: 'ToolSearch', arguments: { query: 'send email' } }],
        }
      }
      if (invocation === 2) {
        return {
          kind: 'tool-calls',
          calls: [{
            id: 'send-mail',
            name: 'ExecuteTool',
            arguments: { tool_name: sendEmail.description.name, params: {} },
          }],
        }
      }
      return { kind: 'final', content: 'email sent' }
    },
  }

  const answer = await runAgent({
    model,
    tools: [],
    searchableTools: [sendEmail],
    prompt: 'Send an email.',
  })

  assert.equal(answer, 'email sent')
  assert.equal(emailCalls, 1)
  assert.deepEqual(visibleTools, [
    ['ToolSearch', 'ExecuteTool'],
    ['ToolSearch', 'ExecuteTool'],
    ['ToolSearch', 'ExecuteTool'],
  ])
})

test('returns ExecuteTool contract errors to the model so it can correct params and continue', async () => {
  let invocation = 0
  let executions = 0
  const sendEmail: Tool = {
    effect: 'execute',
    description: {
      name: 'mcp__mail__send_email',
      description: 'Send an email message to a recipient.',
      parameters: {
        type: 'object',
        properties: { recipient: { type: 'string' } },
        required: ['recipient'],
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      executions += 1
      assert.deepEqual(arguments_, { recipient: 'person@example.com' })
      return 'sent'
    },
  }

  const answer = await runAgent({
    model: {
      async generate(input) {
        invocation += 1
        if (invocation === 1) {
          return {
            kind: 'tool-calls',
            calls: [{ id: 'search-mail', name: 'ToolSearch', arguments: { query: 'send email' } }],
          }
        }
        if (invocation === 2) {
          return {
            kind: 'tool-calls',
            calls: [{
              id: 'invalid-send',
              name: 'ExecuteTool',
              arguments: { tool_name: sendEmail.description.name, params: {} },
            }],
          }
        }
        if (invocation === 3) {
          const failedResult = input.messages.at(-1)
          assert.equal(failedResult?.role, 'tool')
          assert.match(
            failedResult?.role === 'tool' ? failedResult.content : '',
            /invalid parameters.*required property 'recipient'/i,
          )
          return {
            kind: 'tool-calls',
            calls: [{
              id: 'corrected-send',
              name: 'ExecuteTool',
              arguments: {
                tool_name: sendEmail.description.name,
                params: { recipient: 'person@example.com' },
              },
            }],
          }
        }
        assert.deepEqual(input.messages.at(-1), {
          role: 'tool',
          toolCallId: 'corrected-send',
          content: 'sent',
        })
        return { kind: 'final', content: 'email sent after correction' }
      },
    },
    tools: [],
    searchableTools: [sendEmail],
    prompt: 'Send an email.',
  })

  assert.equal(answer, 'email sent after correction')
  assert.equal(invocation, 4)
  assert.equal(executions, 1)
})

test('does not execute a searchable tool that the model guesses before discovery', async () => {
  let invocation = 0
  let executions = 0
  const deferred: Tool = {
    effect: 'execute',
    description: {
      name: 'mcp__mail__send_email',
      description: 'Send an email message.',
      parameters: { type: 'object' },
    },
    async execute() {
      executions += 1
      return 'sent'
    },
  }
  const answer = await runAgent({
    model: {
      async generate(input) {
        invocation += 1
        if (invocation === 1) {
          return {
            kind: 'tool-calls',
            calls: [{ id: 'guessed', name: deferred.description.name, arguments: {} }],
          }
        }
        const result = input.messages.at(-1)
        assert.match(result?.role === 'tool' ? result.content : '', /use ToolSearch, then ExecuteTool/)
        return { kind: 'final', content: 'search required' }
      },
    },
    tools: [],
    searchableTools: [deferred],
    prompt: 'Send an email.',
  })

  assert.equal(answer, 'search required')
  assert.equal(executions, 0)
})

test('does not execute a guessed deferred tool through ExecuteTool in a Tool Search batch', async () => {
  let invocation = 0
  let executions = 0
  const deferred: Tool = {
    effect: 'execute',
    description: {
      name: 'mcp__mail__send_email',
      description: 'Send an email message.',
      parameters: { type: 'object' },
    },
    async execute() {
      executions += 1
      return 'sent'
    },
  }
  const answer = await runAgent({
    model: {
      async generate(input) {
        invocation += 1
        if (invocation === 1) {
          return {
            kind: 'tool-calls',
            calls: [
              { id: 'search', name: 'ToolSearch', arguments: { query: 'send email' } },
              {
                id: 'guessed',
                name: 'ExecuteTool',
                arguments: { tool_name: deferred.description.name, params: {} },
              },
            ],
          }
        }
        const results = input.messages.filter(message => message.role === 'tool')
        assert.equal(results.length, 2)
        assert.match(results[1]?.content ?? '', /earlier model step/)
        assert.deepEqual(input.tools.map(tool => tool.name), [
          'ToolSearch',
          'ExecuteTool',
        ])
        return { kind: 'final', content: 'retry on a later step' }
      },
    },
    tools: [],
    searchableTools: [deferred],
    prompt: 'Send an email.',
  })

  assert.equal(answer, 'retry on a later step')
  assert.equal(executions, 0)
})

test('emits an observable execution chain with provider reasoning and tool content', async () => {
  const events: AgentEvent[] = []
  let request = 0
  const model: Model = {
    async generate() {
      request += 1
      return request === 1
        ? {
            kind: 'tool-calls',
            reasoningContent: 'I need to inspect the file.',
            calls: [{ id: 'call-read', name: 'Read', arguments: { path: 'src/app.ts' } }],
          }
        : {
            kind: 'final',
            reasoningContent: 'The tool result is sufficient.',
            content: 'The file exports app.',
          }
    },
  }
  const read: Tool = {
    effect: 'observe',
    parallelSafe: true,
    description: { name: 'Read', description: 'Read.', parameters: {} },
    async execute() {
      return 'export const app = true'
    },
  }

  await runAgent({
    model,
    tools: [read],
    prompt: 'inspect',
    onEvent: event => events.push(structuredClone(event)),
  })

  assert.deepEqual(events.map(event => event.type), [
    'turn.started',
    'step.started',
    'model.completed',
    'tool.batch-started',
    'tool.started',
    'tool.completed',
    'step.started',
    'model.completed',
    'turn.completed',
  ])
  const firstModel = events.find(event =>
    event.type === 'model.completed' && event.step === 1
  )
  assert.equal(
    firstModel?.type === 'model.completed'
      ? firstModel.output.reasoningContent
      : undefined,
    'I need to inspect the file.',
  )
  const toolResult = events.find(event => event.type === 'tool.completed')
  assert.equal(
    toolResult?.type === 'tool.completed' ? toolResult.content : undefined,
    'export const app = true',
  )
  const completed = events.find(event => event.type === 'turn.completed')
  assert.ok(
    completed?.type === 'turn.completed'
    && completed.contextUsage.estimatedTokens > 0,
  )
})

test('reports Turn-end Context usage with Provider input as a conservative floor', async () => {
  const events: AgentEvent[] = []

  await runAgent({
    model: {
      async generate() {
        return {
          kind: 'final',
          content: 'done',
          metadata: {
            usage: { inputTokens: 750, outputTokens: 20, totalTokens: 770 },
          },
        }
      },
    },
    tools: [],
    prompt: 'measure context',
    contextLimits: { contextWindowTokens: 1_000, autoCompactTokenLimit: 900 },
    tokenEstimator: {
      estimate: () => 100,
      estimateText: () => 10,
    },
    onEvent: event => events.push(structuredClone(event)),
  })

  const completed = events.find(event => event.type === 'turn.completed')
  assert.deepEqual(
    completed?.type === 'turn.completed' ? completed.contextUsage : undefined,
    {
      estimatedTokens: 750,
      contextWindowTokens: 1_000,
      autoCompactTokenLimit: 900,
    },
  )
})

test('forwards model stream deltas before model completion', async () => {
  const events: AgentEvent[] = []
  const model: Model = {
    async generate(input) {
      await input.onStream?.({ type: 'reasoning', delta: 'thinking' })
      await input.onStream?.({ type: 'output-text', delta: 'done' })
      return { kind: 'final', content: 'done' }
    },
  }

  await runAgent({
    model,
    tools: [],
    prompt: 'stream',
    onEvent: event => events.push(structuredClone(event)),
  })

  const turnId = events[0]?.type === 'turn.started' ? events[0].turnId : ''
  assert.deepEqual(events.map(event => event.type), [
    'turn.started',
    'step.started',
    'model.delta',
    'model.delta',
    'model.completed',
    'turn.completed',
  ])
  assert.deepEqual(events.slice(2, 4), [
    {
      type: 'model.delta',
      turnId,
      step: 1,
      event: { type: 'reasoning', delta: 'thinking' },
    },
    {
      type: 'model.delta',
      turnId,
      step: 1,
      event: { type: 'output-text', delta: 'done' },
    },
  ])
})

test('does not impose a Step limit and applies maxTokens to every model invocation', async () => {
  let request = 0
  const observedMaxTokens: Array<number | undefined> = []
  const model: Model = {
    async generate(input) {
      observedMaxTokens.push(input.maxTokens)
      request += 1
      if (request <= 51) {
        return {
          kind: 'tool-calls' as const,
          calls: [{ id: `call-${request}`, name: 'search', arguments: {} }],
        }
      }
      return { kind: 'final', content: 'finished without a Step budget' }
    },
  }
  const search: Tool = {
    effect: 'observe',
    description: {
      name: 'search',
      description: 'Search the web.',
      parameters: { type: 'object' },
    },
    async execute() {
      return 'same result'
    },
  }

  assert.equal(
    await runAgent({ model, tools: [search], prompt: 'long task', maxTokens: 4096 }),
    'finished without a Step budget',
  )
  assert.equal(request, 52)
  assert.deepEqual(new Set(observedMaxTokens), new Set([4096]))
})

test('does not impose a model output token limit by default', async () => {
  let observedMaxTokens: number | undefined = 0
  const model: Model = {
    async generate(input) {
      observedMaxTokens = input.maxTokens
      return { kind: 'final', content: 'done' }
    },
  }

  assert.equal(await runAgent({ model, tools: [], prompt: 'hello' }), 'done')
  assert.equal(observedMaxTokens, undefined)
})

test('injects advisory Loop Guard content after repeated identical Tool Calls', async () => {
  let request = 0
  let toolExecutions = 0
  const observedTools: number[] = []
  const observedMessages: Array<readonly Message[]> = []
  const records: SessionRecord[] = []
  const inner = new MemorySessionStore()
  const store: SessionStore = {
    createSession: async projectId => await inner.createSession(projectId),
    loadSession: async sessionId => await inner.loadSession(sessionId),
    recoverTurn: async (sessionId, turnId, error) => {
      await inner.recoverTurn(sessionId, turnId, error)
    },
    record: async (sessionId, record) => {
      records.push(structuredClone(record))
      await inner.record(sessionId, record)
    },
  }
  const model: Model = {
    async generate(input) {
      request += 1
      observedTools.push(input.tools.length)
      observedMessages.push(structuredClone(input.messages))
      if (request <= 3) {
        return {
          kind: 'tool-calls',
          calls: [{ id: `bash-${request}`, name: 'Bash', arguments: { command: 'same-probe' } }],
        }
      }
      return { kind: 'final', content: 'Finished after the reminder.' }
    },
  }
  const loopGuard: LoopGuard = {
    async review(input) {
      if (input.steps.length !== 3) return undefined
      return {
        kind: 'exact-repeat',
        metric: 3,
        summary: 'Bash × 3',
        content: 'Loop Guard reminder: inspect the previous result and change approach.',
      }
    },
  }
  const bash: Tool = {
    effect: 'execute',
    description: { name: 'Bash', description: 'Run.', parameters: {} },
    async execute() {
      toolExecutions += 1
      return 'probe result'
    },
  }

  const session = await AgentSession.create({ model, tools: [bash], store, loopGuards: [loopGuard] })
  assert.equal(await session.send('Inspect rendered HTML.'), 'Finished after the reminder.')

  assert.equal(toolExecutions, 3)
  assert.deepEqual(observedTools, [1, 1, 1, 1])
  const reminderMessage = observedMessages[3]?.find(message =>
    message.role === 'user' && message.content.startsWith('Loop Guard reminder')
  )
  assert.equal(reminderMessage?.role, 'user')
  assert.match(reminderMessage.role === 'user' ? reminderMessage.content : '', /change approach/)
  assert.equal(
    records.filter(record => record.type === 'loop-guard.reminded').length,
    1,
  )
})

test('reviews a persisted exact-repeat chain before resuming an interrupted Turn', async () => {
  const store = new MemorySessionStore()
  let request = 0
  const tool: Tool = {
    effect: 'execute',
    description: { name: 'Bash', description: 'Run.', parameters: {} },
    async execute() {
      return 'probe result'
    },
  }
  const interrupted = await AgentSession.create({
    model: {
      async generate() {
        request += 1
        if (request <= 3) {
          return {
            kind: 'tool-calls',
            calls: [{ id: `probe-${request}`, name: 'Bash', arguments: { command: 'same' } }],
          }
        }
        throw new Error('process interrupted')
      },
    },
    tools: [tool],
    store,
  })
  await assert.rejects(interrupted.send('Explain whether browser inspection is available.'), /interrupted/)

  let reviews = 0
  let resumedTools = -1
  const resumed = await AgentSession.resume(interrupted.id, {
    model: {
      async generate(input) {
        resumedTools = input.tools.length
        return { kind: 'final', content: 'Browser inspection is not currently available.' }
      },
    },
    tools: [tool],
    store,
    loopGuards: [{
      async review(input) {
        if (input.steps.length !== 3) return undefined
        reviews += 1
        return {
          kind: 'exact-repeat',
          metric: 3,
          summary: 'Bash × 3',
          content: 'Loop Guard reminder: use the existing evidence.',
        }
      },
    }],
  })

  assert.equal(await resumed.continueTurn(), 'Browser inspection is not currently available.')
  assert.equal(reviews, 1)
  assert.equal(resumedTools, 1)
})

test('injects deterministic advice after consecutive Steps make no file change', async () => {
  let request = 0
  const requests: Array<readonly Message[]> = []
  const model: Model = {
    async generate(input) {
      request += 1
      requests.push(structuredClone(input.messages))
      if (request <= 2) {
        return {
          kind: 'tool-calls',
          calls: [{ id: `read-${request}`, name: 'Read', arguments: { path: `/p/${request}.ts` } }],
        }
      }
      return { kind: 'final', content: 'I will start implementation now.' }
    },
  }
  const read: Tool = {
    effect: 'observe',
    description: { name: 'Read', description: 'Read.', parameters: {} },
    async execute() {
      return 'source'
    },
  }

  const answer = await runAgent({
    model,
    tools: [read],
    prompt: 'Implement the feature.',
    loopGuards: [new NoProgressLoopGuard({ thresholds: [2] })],
  })

  assert.equal(answer, 'I will start implementation now.')
  const reminder = requests[2]?.find(message =>
    message.role === 'user' && message.content.includes('2 steps without a file change')
  )
  assert.equal(reminder?.role, 'user')
})

test('allows ten tool steps followed by a final answer', async () => {
  let request = 0
  const model: Model = {
    async generate() {
      request += 1
      if (request <= 10) {
        return {
          kind: 'tool-calls',
          calls: [{ id: `call-${request}`, name: 'search', arguments: {} }],
        }
      }
      return { kind: 'final', content: 'done after exploration' }
    },
  }
  const search: Tool = {
    effect: 'observe',
    description: { name: 'search', description: 'Search.', parameters: {} },
    async execute() {
      return 'result'
    },
  }

  assert.equal(
    await runAgent({ model, tools: [search], prompt: 'explore' }),
    'done after exploration',
  )
  assert.equal(request, 11)
})

test('executes a parallel-safe tool batch concurrently within one step', async () => {
  let request = 0
  let active = 0
  let maximumActive = 0
  const model: Model = {
    async generate(input) {
      request += 1
      if (request === 1) {
        return {
          kind: 'tool-calls',
          calls: [
            { id: 'call-a', name: 'Read', arguments: { path: 'a.ts' } },
            { id: 'call-b', name: 'Read', arguments: { path: 'b.ts' } },
          ],
        }
      }
      assert.deepEqual(input.messages.slice(-3), [
        {
          role: 'assistant',
          toolCalls: [
            { id: 'call-a', name: 'Read', arguments: { path: 'a.ts' } },
            { id: 'call-b', name: 'Read', arguments: { path: 'b.ts' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-a', content: 'a.ts' },
        { role: 'tool', toolCallId: 'call-b', content: 'b.ts' },
      ])
      return { kind: 'final', content: 'done' }
    },
  }
  const read: Tool = {
    effect: 'observe',
    parallelSafe: true,
    description: { name: 'Read', description: 'Read.', parameters: {} },
    async execute(arguments_) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      assert.ok(typeof arguments_ === 'object' && arguments_ !== null)
      const path = Reflect.get(arguments_, 'path')
      assert.equal(typeof path, 'string')
      return path
    },
  }
  const store = new MemorySessionStore()
  const session = await AgentSession.create({ model, tools: [read], store })

  assert.equal(await session.send('read both'), 'done')
  assert.equal(maximumActive, 2)
  const snapshot = await store.loadSession(session.id)
  const firstStep = snapshot?.turns[0]?.steps[0]
  assert.equal(firstStep?.output.kind, 'tool-calls')
  if (firstStep?.output.kind === 'tool-calls') {
    assert.equal(firstStep.output.executions.length, 2)
  }
})

test('persists each parallel Tool result as soon as that call completes', async () => {
  const inner = new MemorySessionStore()
  const firstPersisted = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const store: SessionStore = {
    createSession: async projectId => await inner.createSession(projectId),
    loadSession: async sessionId => await inner.loadSession(sessionId),
    recoverTurn: async (sessionId, turnId, error) => {
      await inner.recoverTurn(sessionId, turnId, error)
    },
    record: async (sessionId, record) => {
      await inner.record(sessionId, record)
      if (record.type === 'step.tool-completed' && record.toolCallId === 'call-fast') {
        firstPersisted.resolve()
      }
    },
  }
  let request = 0
  const session = await AgentSession.create({
    model: {
      async generate() {
        request += 1
        return request === 1
          ? {
              kind: 'tool-calls',
              calls: [
                { id: 'call-fast', name: 'Read', arguments: { path: 'fast' } },
                { id: 'call-slow', name: 'Read', arguments: { path: 'slow' } },
              ],
            }
          : { kind: 'final', content: 'done' }
      },
    },
    tools: [{
      effect: 'observe',
      parallelSafe: true,
      description: { name: 'Read', description: 'Read.', parameters: {} },
      async execute(arguments_) {
        if (Reflect.get(arguments_ as object, 'path') === 'slow') await releaseSecond.promise
        return String(Reflect.get(arguments_ as object, 'path'))
      },
    }],
    store,
  })

  const turn = session.send('read both')
  await firstPersisted.promise
  const duringBatch = await store.loadSession(session.id)
  const step = duringBatch?.turns[0]?.steps[0]
  assert.equal(step?.output.kind, 'tool-calls')
  if (step?.output.kind === 'tool-calls') {
    assert.deepEqual(step.output.executions.map(execution => execution.status), [
      'completed',
      'running',
    ])
  }

  releaseSecond.resolve()
  assert.equal(await turn, 'done')
})

test('keeps completed turns in the next model request', async () => {
  const recordedRequests: Array<readonly Message[]> = []
  const answers = ['第一轮回答', '第二轮回答']
  const model: Model = {
    async generate(input) {
      recordedRequests.push(structuredClone(input.messages))
      const content = answers.shift()
      assert.ok(content)
      return { kind: 'final', content }
    },
  }
  const session = await AgentSession.create({
    model,
    tools: [],
    store: new MemorySessionStore(),
  })

  assert.equal(await session.send('第一轮问题'), '第一轮回答')
  assert.equal(await session.send('第二轮问题'), '第二轮回答')

  assert.deepEqual(recordedRequests[1], [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮问题' },
  ])
  assert.deepEqual(session.history(), [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮问题' },
    { role: 'assistant', content: '第二轮回答' },
  ])
})

test('keeps a failed Turn context and continues the same Turn', async () => {
  let request = 0
  const model: Model = {
    async generate(input) {
      request += 1
      if (request === 1) throw new Error('provider unavailable')
      assert.deepEqual(input.messages, [{ role: 'user', content: 'failed turn' }])
      return { kind: 'final', content: 'recovered' }
    },
  }
  const store = new MemorySessionStore()
  const session = await AgentSession.create({ model, tools: [], store })

  await assert.rejects(session.send('failed turn'), /provider unavailable/)
  assert.deepEqual(session.history(), [{ role: 'user', content: 'failed turn' }])
  assert.equal(session.hasRecoverableTurn(), true)
  const failedSnapshot = await store.loadSession(session.id)
  assert.equal(failedSnapshot?.turns[0]?.status, 'failed')
  assert.equal(failedSnapshot?.turns[0]?.error, 'provider unavailable')
  await assert.rejects(session.send('new turn'), /continue it first/)
  assert.equal(await session.continueTurn(), 'recovered')
  assert.equal(session.hasRecoverableTurn(), false)
  assert.deepEqual(session.history(), [
    { role: 'user', content: 'failed turn' },
    { role: 'assistant', content: 'recovered' },
  ])
})

test('records a failed model invocation before failing the turn', async () => {
  const inner = new MemorySessionStore()
  const records: SessionRecord[] = []
  const store: SessionStore = {
    createSession: async projectId => await inner.createSession(projectId),
    loadSession: async sessionId => await inner.loadSession(sessionId),
    recoverTurn: async (sessionId, turnId, error) => {
      await inner.recoverTurn(sessionId, turnId, error)
    },
    record: async (sessionId, record) => {
      records.push(structuredClone(record))
      await inner.record(sessionId, record)
    },
  }
  const session = await AgentSession.create({
    model: {
      descriptor: {
        provider: 'test-provider',
        model: 'test-model',
        protocol: 'test',
        requestTimeoutMs: 30_000,
        maxRetries: 1,
      },
      async generate(input) {
        await input.onAttempt?.({ type: 'started', attempt: 1 })
        await input.onAttempt?.({
          type: 'failed',
          attempt: 1,
          phase: 'requesting',
          durationMs: 30_000,
          eventCount: 0,
          errorName: 'TimeoutError',
          errorMessage: 'Request timed out.',
        })
        throw new Error('Request timed out.')
      },
    },
    tools: [],
    store,
  })

  await assert.rejects(session.send('inspect'), /Request timed out/)

  assert.deepEqual(records.map(record => record.type), [
    'turn.started',
    'model.invocation-started',
    'model.attempt',
    'model.attempt',
    'model.invocation-failed',
    'turn.failed',
  ])
  const invocation = records.find(record => record.type === 'model.invocation-started')
  assert.equal(
    invocation?.type === 'model.invocation-started' ? invocation.descriptor?.model : undefined,
    'test-model',
  )
})

test('rejects concurrent turns on the same session', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const model: Model = {
    async generate() {
      started.resolve()
      await release.promise
      return { kind: 'final', content: 'done' }
    },
  }
  const session = await AgentSession.create({
    model,
    tools: [],
    store: new MemorySessionStore(),
  })
  const first = session.send('first')
  await started.promise

  await assert.rejects(session.send('second'), /already has a running turn/)
  release.resolve()
  assert.equal(await first, 'done')
})

test('restores completed turns from durable session state', async () => {
  const store = new MemorySessionStore()
  const firstModel: Model = {
    async generate() {
      return { kind: 'final', content: '记住了' }
    },
  }
  const first = await AgentSession.create({ model: firstModel, tools: [], store })
  await first.send('暗号是蓝鲸')

  let restoredMessages: readonly Message[] = []
  const resumedModel: Model = {
    async generate(input) {
      restoredMessages = structuredClone(input.messages)
      return { kind: 'final', content: '蓝鲸' }
    },
  }
  const resumed = await AgentSession.resume(first.id, {
    model: resumedModel,
    tools: [],
    store,
  })

  assert.equal(await resumed.send('暗号是什么？'), '蓝鲸')
  assert.deepEqual(restoredMessages, [
    { role: 'user', content: '暗号是蓝鲸' },
    { role: 'assistant', content: '记住了' },
    { role: 'user', content: '暗号是什么？' },
  ])
})

test('restores Tool Search discoveries for ExecuteTool when reopening a session', async () => {
  const store = new MemorySessionStore()
  const deferred: Tool = {
    effect: 'observe',
    description: {
      name: 'mcp__calendar__list_events',
      description: 'List calendar events.',
      parameters: { type: 'object' },
    },
    async execute() {
      return 'events'
    },
  }
  let invocation = 0
  const first = await AgentSession.create({
    model: {
      async generate() {
        invocation += 1
        return invocation === 1
          ? {
              kind: 'tool-calls',
              calls: [{ id: 'find-calendar', name: 'ToolSearch', arguments: { query: 'calendar' } }],
            }
          : { kind: 'final', content: 'calendar ready' }
      },
    },
    tools: [],
    searchableTools: [deferred],
    store,
  })
  await first.send('Find a calendar tool.')

  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        assert.deepEqual(input.tools.map(tool => tool.name), [
          'ToolSearch',
          'ExecuteTool',
        ])
        const priorExecute = input.messages.some(message =>
          message.role === 'assistant'
          && 'toolCalls' in message
          && message.toolCalls.some(call => call.name === 'ExecuteTool')
        )
        return priorExecute
          ? { kind: 'final', content: 'still available' }
          : {
              kind: 'tool-calls',
              calls: [{
                id: 'list-calendar',
                name: 'ExecuteTool',
                arguments: { tool_name: deferred.description.name, params: {} },
              }],
            }
      },
    },
    tools: [],
    searchableTools: [deferred],
    store,
  })

  assert.equal(await resumed.send('Use it again.'), 'still available')
})

test('restores completed Steps from a failed Turn and continues after reconnecting', async () => {
  const store = new MemorySessionStore()
  let request = 0
  const read: Tool = {
    effect: 'observe',
    description: { name: 'Read', description: 'Read.', parameters: {} },
    async execute() {
      return 'persisted source'
    },
  }
  const first = await AgentSession.create({
    model: {
      async generate() {
        request += 1
        if (request === 1) {
          return {
            kind: 'tool-calls',
            calls: [{ id: 'call-read', name: 'Read', arguments: { path: '/project/app.ts' } }],
          }
        }
        throw new Error('provider disconnected')
      },
    },
    tools: [read],
    store,
  })

  await assert.rejects(first.send('inspect the project'), /provider disconnected/)
  const failed = await store.loadSession(first.id)
  assert.equal(failed?.turns[0]?.status, 'failed')
  assert.equal(failed?.turns[0]?.steps[0]?.status, 'completed')

  let restoredMessages: readonly Message[] = []
  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        restoredMessages = structuredClone(input.messages)
        return { kind: 'final', content: 'continued result' }
      },
    },
    tools: [read],
    store,
  })

  assert.equal(resumed.hasRecoverableTurn(), true)
  assert.equal(await resumed.continueTurn(), 'continued result')
  assert.deepEqual(restoredMessages, [
    { role: 'user', content: 'inspect the project' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-read', name: 'Read', arguments: { path: '/project/app.ts' } }],
    },
    { role: 'tool', toolCallId: 'call-read', content: 'persisted source' },
  ])
  const completed = await store.loadSession(first.id)
  assert.equal(completed?.turns[0]?.status, 'completed')
  assert.equal(completed?.turns[0]?.steps.length, 2)
})

test('does not replay an interrupted Tool call with unknown side effects', async () => {
  const store = new MemorySessionStore()
  const sessionId = await store.createSession(null)
  const turnId = 'interrupted-turn'
  await store.record(sessionId, { type: 'turn.started', turnId, prompt: 'modify files' })
  await store.record(sessionId, {
    type: 'step.tools-called',
    turnId,
    step: 1,
    calls: [
      { id: 'call-read', name: 'Read', arguments: { path: '/project/a.ts' } },
      { id: 'call-edit', name: 'Edit', arguments: { path: '/project/b.ts' } },
    ],
  })
  await store.record(sessionId, {
    type: 'step.tool-completed',
    turnId,
    step: 1,
    toolCallId: 'call-read',
    result: 'source',
  })

  let editExecutions = 0
  const resumed = await AgentSession.resume(sessionId, {
    model: {
      async generate(input) {
        const messages = input.messages.slice(-3)
        assert.deepEqual(messages[0], {
          role: 'assistant',
          toolCalls: [
            { id: 'call-read', name: 'Read', arguments: { path: '/project/a.ts' } },
            { id: 'call-edit', name: 'Edit', arguments: { path: '/project/b.ts' } },
          ],
        })
        assert.deepEqual(messages[1], {
          role: 'tool',
          toolCallId: 'call-read',
          content: 'source',
        })
        assert.match(String(Reflect.get(messages[2] ?? {}, 'content')), /was not run again/)
        return { kind: 'final', content: 'verified current file state' }
      },
    },
    tools: [{
      effect: 'mutate',
      description: { name: 'Edit', description: 'Edit.', parameters: {} },
      async execute() {
        editExecutions += 1
        return 'edited'
      },
    }],
    store,
  })

  assert.equal(await resumed.continueTurn(), 'verified current file state')
  assert.equal(editExecutions, 0)
})

test('returns a tool error to the model and restores it with the completed turn', async () => {
  const store = new MemorySessionStore()
  let request = 0
  const model: Model = {
    async generate(input) {
      request += 1
      if (request === 1) {
        return {
          kind: 'tool-calls',
          calls: [{ id: 'call-read', name: 'Read', arguments: { path: '../secret' } }],
        }
      }
      assert.deepEqual(input.messages.at(-1), {
        role: 'tool',
        toolCallId: 'call-read',
        content: 'Error: path denied',
      })
      return { kind: 'final', content: '无法读取该路径' }
    },
  }
  const read: Tool = {
    effect: 'observe',
    description: { name: 'Read', description: 'Read a file.', parameters: {} },
    async execute() {
      throw new Error('path denied')
    },
  }
  const first = await AgentSession.create({ model, tools: [read], store })

  assert.equal(await first.send('读取文件'), '无法读取该路径')
  const resumed = await AgentSession.resume(first.id, {
    model: { async generate() { return { kind: 'final', content: 'done' } } },
    tools: [read],
    store,
  })
  assert.deepEqual(resumed.history(), [
    { role: 'user', content: '读取文件' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-read', name: 'Read', arguments: { path: '../secret' } }],
    },
    { role: 'tool', toolCallId: 'call-read', content: 'Error: path denied' },
    { role: 'assistant', content: '无法读取该路径' },
  ])
})

test('sends Project instructions once before continuing Responses with only incremental input', async () => {
  const requests: Array<{
    messages: readonly Message[]
    previousResponseId?: string
  }> = []
  let invocation = 0
  const model: Model = {
    async generate(input) {
      requests.push({
        messages: structuredClone(input.messages),
        ...(input.previousResponseId === undefined
          ? {}
          : { previousResponseId: input.previousResponseId }),
      })
      invocation += 1
      if (invocation === 1) {
        return {
          kind: 'tool-calls',
          calls: [{ id: 'call-1', name: 'Read', arguments: { path: '/project/a.ts' } }],
          metadata: { providerResponseId: 'response-1' },
        }
      }
      return {
        kind: 'final',
        content: invocation === 2 ? 'first done' : 'second done',
        metadata: { providerResponseId: `response-${invocation}` },
      }
    },
  }
  const read: Tool = {
    effect: 'observe',
    description: { name: 'Read', description: 'Read a file.', parameters: {} },
    async execute() {
      return 'source'
    },
  }
  const session = await AgentSession.create({
    model,
    tools: [read],
    store: new MemorySessionStore(),
    project: {
      id: 'project-1',
      name: 'demo',
      roots: [{ path: '/project', role: 'primary' }],
    },
  })

  assert.equal(await session.send('first'), 'first done')
  assert.equal(await session.send('second'), 'second done')
  const firstMessage = requests[0]?.messages[0]
  assert.equal(firstMessage?.role, 'system')
  assert.match(firstMessage.content, /^Project: demo$/m)
  assert.deepEqual(requests.map(request => ({
    roles: request.messages.map(message => message.role),
    ...(request.previousResponseId === undefined
      ? {}
      : { previousResponseId: request.previousResponseId }),
  })), [
    {
      roles: ['system', 'user'],
    },
    {
      roles: ['tool'],
      previousResponseId: 'response-1',
    },
    {
      roles: ['user'],
      previousResponseId: 'response-2',
    },
  ])
})

test('restores the last Responses continuation after reopening a session', async () => {
  const store = new MemorySessionStore()
  const project = {
    id: 'project-1',
    name: 'demo',
    roots: [{ path: '/project', role: 'primary' as const }],
  }
  const first = await AgentSession.create({
    model: {
      async generate() {
        return {
          kind: 'final',
          content: 'first done',
          metadata: { providerResponseId: 'response-persisted' },
        }
      },
    },
    tools: [],
    store,
    project,
  })
  await first.send('first')

  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        assert.equal(input.previousResponseId, 'response-persisted')
        assert.deepEqual(input.messages, [{ role: 'user', content: 'second' }])
        return {
          kind: 'final',
          content: 'second done',
          metadata: { providerResponseId: 'response-next' },
        }
      },
    },
    tools: [],
    store,
    project,
  })

  assert.equal(await resumed.send('second'), 'second done')
})

test('installs a manual Context Checkpoint without deleting durable history', async () => {
  const inner = new MemorySessionStore()
  const records: SessionRecord[] = []
  const events: AgentEvent[] = []
  const requests: Array<{
    messages: readonly Message[]
    tools: readonly string[]
    previousResponseId?: string
  }> = []
  const store: SessionStore = {
    createSession: async projectId => await inner.createSession(projectId),
    loadSession: async sessionId => await inner.loadSession(sessionId),
    recoverTurn: async (sessionId, turnId, error) => {
      await inner.recoverTurn(sessionId, turnId, error)
    },
    record: async (sessionId, record) => {
      records.push(structuredClone(record))
      await inner.record(sessionId, record)
    },
  }
  let invocation = 0
  const session = await AgentSession.create({
    model: {
      async generate(input) {
        invocation += 1
        requests.push({
          messages: structuredClone(input.messages),
          tools: input.tools.map(tool => tool.name),
          ...(input.previousResponseId === undefined
            ? {}
            : { previousResponseId: input.previousResponseId }),
        })
        if (invocation === 1) {
          return {
            kind: 'final',
            content: `旧回答：${'x'.repeat(2_000)}`,
            metadata: {
              providerResponseId: 'response-before-compact',
              usage: { inputTokens: 700, outputTokens: 500, totalTokens: 1_200 },
            },
          }
        }
        if (invocation === 2) {
          assert.equal(input.previousResponseId, undefined)
          assert.deepEqual(input.tools, [])
          const instruction = input.messages.at(-1)
          assert.match(
            instruction?.role === 'user' ? instruction.content : '',
            /Create a concise context handoff/,
          )
          return {
            kind: 'final',
            content: '用户给出的暗号是蓝鲸；旧回答已完成。',
            metadata: { providerResponseId: 'response-summary' },
          }
        }
        assert.equal(input.previousResponseId, undefined)
        assert.equal(input.messages.some(message =>
          message.role === 'assistant' && 'content' in message && message.content.includes('旧回答')
        ), false)
        assert.equal(input.messages.some(message =>
          message.role === 'user' && message.content.startsWith('[Context checkpoint]')
        ), true)
        return { kind: 'final', content: '暗号仍然是蓝鲸。' }
      },
    },
    tools: [],
    store,
    onEvent: event => events.push(structuredClone(event)),
  })

  await session.send('记住暗号是蓝鲸。')
  const compacted = await session.compact()
  assert.equal(compacted.checkpointNumber, 1)
  assert.ok(compacted.estimatedTokensAfter < compacted.estimatedTokensBefore)
  await assert.rejects(session.compact(), /no completed Step after the latest Context Checkpoint/)
  assert.equal(await session.send('暗号是什么？'), '暗号仍然是蓝鲸。')

  assert.equal(requests[2]?.previousResponseId, undefined)
  assert.deepEqual(
    records.filter(record => record.type === 'model.invocation-started').map(record =>
      record.type === 'model.invocation-started' ? record.purpose : undefined
    ),
    ['agent', 'compaction', 'agent'],
  )
  assert.deepEqual(events.filter(event => event.type.startsWith('context.')).map(event => event.type), [
    'context.compaction-started',
    'context.compaction-completed',
  ])
  const snapshot = await store.loadSession(session.id)
  assert.equal(snapshot?.turns.length, 2)
  assert.match(snapshot?.turns[0]?.steps[0]?.output.kind === 'final'
    ? snapshot.turns[0].steps[0].output.content
    : '', /旧回答/)
  assert.equal(snapshot?.contextCheckpoint?.coveredThroughTurnNumber, 1)
})

test('automatically compacts at a safe completed Step and bounds Tool Result source content', async () => {
  const store = new MemorySessionStore()
  const events: AgentEvent[] = []
  const hugeResult = `HEAD-${'x'.repeat(100_000)}-TAIL`
  let invocation = 0
  let compactionSource: readonly Message[] = []
  const session = await AgentSession.create({
    model: {
      async generate(input) {
        invocation += 1
        if (invocation === 1) {
          return {
            kind: 'tool-calls',
            calls: [{ id: 'large-read', name: 'Read', arguments: { path: '/project/large.txt' } }],
            metadata: { providerResponseId: 'response-tool-step' },
          }
        }
        if (invocation === 2) {
          compactionSource = structuredClone(input.messages)
          assert.equal(input.previousResponseId, undefined)
          assert.deepEqual(input.tools, [])
          return { kind: 'final', content: '已读取大文件，保留了开头和结尾证据。' }
        }
        assert.equal(input.previousResponseId, undefined)
        assert.equal(input.messages.some(message => message.role === 'tool'), false)
        return { kind: 'final', content: 'done after automatic compaction' }
      },
    },
    tools: [{
      effect: 'observe',
      description: { name: 'Read', description: 'Read.', parameters: {} },
      async execute() {
        return hugeResult
      },
    }],
    store,
    contextLimits: { contextWindowTokens: 50_000, autoCompactTokenLimit: 15_000 },
    onEvent: event => events.push(structuredClone(event)),
  })

  assert.equal(await session.send('读取大文件并完成任务。'), 'done after automatic compaction')
  const summarizedTool = compactionSource.find(message => message.role === 'tool')
  assert.equal(summarizedTool?.role, 'tool')
  if (summarizedTool?.role === 'tool') {
    assert.ok(summarizedTool.content.length < hugeResult.length)
    assert.match(summarizedTool.content, /^HEAD-/)
    assert.match(summarizedTool.content, /context omitted/)
    assert.match(summarizedTool.content, /-TAIL$/)
  }
  assert.deepEqual(events.filter(event => event.type.startsWith('context.')).map(event => event.type), [
    'context.compaction-started',
    'context.compaction-completed',
  ])
  const snapshot = await store.loadSession(session.id)
  const firstStep = snapshot?.turns[0]?.steps[0]
  assert.equal(firstStep?.output.kind, 'tool-calls')
  if (firstStep?.output.kind === 'tool-calls') {
    assert.equal(firstStep.output.executions[0]?.result, hugeResult)
  }
  assert.deepEqual(session.history(), [
    { role: 'user', content: '读取大文件并完成任务。' },
    { role: 'user', content: '[Context checkpoint]\n已读取大文件，保留了开头和结尾证据。' },
    { role: 'assistant', content: 'done after automatic compaction' },
  ])
})

test('replays only checkpoint replacement and tail when Provider continuation is unavailable', async () => {
  const store = new MemorySessionStore()
  let invocation = 0
  const requests: Array<{
    messages: readonly Message[]
    previousResponseId?: string
  }> = []
  const session = await AgentSession.create({
    model: {
      async generate(input) {
        invocation += 1
        requests.push({
          messages: structuredClone(input.messages),
          ...(input.previousResponseId === undefined
            ? {}
            : { previousResponseId: input.previousResponseId }),
        })
        if (invocation === 1) {
          return {
            kind: 'final',
            content: `raw old answer ${'x'.repeat(2_000)}`,
            metadata: {
              providerResponseId: 'pre-checkpoint-response',
              usage: { inputTokens: 700, outputTokens: 500, totalTokens: 1_200 },
            },
          }
        }
        if (invocation === 2) return { kind: 'final', content: 'bounded checkpoint summary' }
        if (invocation === 3) {
          return {
            kind: 'final',
            content: 'tail answer',
            metadata: { providerResponseId: 'post-checkpoint-response' },
          }
        }
        if (invocation === 4) {
          assert.equal(input.previousResponseId, 'post-checkpoint-response')
          throw new ModelContinuationUnavailableError('continuation expired')
        }
        assert.equal(input.previousResponseId, undefined)
        assert.equal(input.messages.some(message =>
          message.role === 'assistant'
          && 'content' in message
          && message.content.includes('raw old answer')
        ), false)
        assert.equal(input.messages.some(message =>
          message.role === 'user' && message.content.startsWith('[Context checkpoint]')
        ), true)
        assert.deepEqual(input.messages.slice(-3), [
          { role: 'user', content: 'second turn' },
          { role: 'assistant', content: 'tail answer' },
          { role: 'user', content: 'third turn' },
        ])
        return { kind: 'final', content: 'bounded replay succeeded' }
      },
    },
    tools: [],
    store,
  })

  await session.send('first turn')
  await session.compact()
  await session.send('second turn')
  assert.equal(await session.send('third turn'), 'bounded replay succeeded')
  assert.equal(requests[3]?.messages.length, 1)
})

test('keeps the prior projection when a compaction model returns Tool Calls', async () => {
  const store = new MemorySessionStore()
  const events: AgentEvent[] = []
  let invocation = 0
  const session = await AgentSession.create({
    model: {
      async generate() {
        invocation += 1
        return invocation === 1
          ? {
              kind: 'final',
              content: `durable answer ${'x'.repeat(2_000)}`,
              metadata: { usage: { inputTokens: 700, outputTokens: 500, totalTokens: 1_200 } },
            }
          : {
              kind: 'tool-calls',
              calls: [{ id: 'not-allowed', name: 'Read', arguments: {} }],
            }
      },
    },
    tools: [],
    store,
    onEvent: event => events.push(structuredClone(event)),
  })

  await session.send('keep this history')
  const before = session.history()
  await assert.rejects(session.compact(), /Tool Calls instead of a summary/)
  assert.deepEqual(session.history(), before)
  const snapshot = await store.loadSession(session.id)
  assert.equal(snapshot?.contextCheckpoint, undefined)
  assert.equal(snapshot?.turns[0]?.status, 'completed')
  assert.equal(events.at(-1)?.type, 'context.compaction-failed')
})

test('recovers an interrupted compaction invocation before retrying after resume', async () => {
  const store = new MemorySessionStore()
  const first = await AgentSession.create({
    model: {
      async generate() {
        return {
          kind: 'final',
          content: `durable answer ${'x'.repeat(2_000)}`,
          metadata: { usage: { inputTokens: 700, outputTokens: 500, totalTokens: 1_200 } },
        }
      },
    },
    tools: [],
    store,
  })
  await first.send('preserve this prompt')
  const snapshot = await store.loadSession(first.id)
  const turn = snapshot?.turns[0]
  assert.ok(turn)
  await store.record(first.id, {
    type: 'model.invocation-started',
    turnId: turn.id,
    step: 1,
    purpose: 'compaction',
    messageCount: 2,
    toolCount: 0,
    inputChars: 100,
  })

  const resumed = await AgentSession.resume(first.id, {
    model: { async generate() { return { kind: 'final', content: 'recovered summary' } } },
    tools: [],
    store,
  })
  const compacted = await resumed.compact()
  assert.equal(compacted.checkpointNumber, 1)
  assert.equal((await store.loadSession(first.id))?.contextCheckpoint?.payload.messages.at(-1)?.role, 'user')
})

test('restores Tool Search discovery from full history after checkpoint replacement', async () => {
  const store = new MemorySessionStore()
  const deferred: Tool = {
    effect: 'observe',
    description: {
      name: 'mcp__calendar__list_events',
      description: 'List calendar events.',
      parameters: { type: 'object' },
    },
    async execute() {
      return 'events after checkpoint'
    },
  }
  let firstInvocation = 0
  const first = await AgentSession.create({
    model: {
      async generate(input) {
        firstInvocation += 1
        if (firstInvocation === 1) {
          return {
            kind: 'tool-calls',
            calls: [{ id: 'find-calendar', name: 'ToolSearch', arguments: { query: 'calendar' } }],
          }
        }
        if (firstInvocation === 2) {
          return {
            kind: 'final',
            content: `calendar ready ${'x'.repeat(2_000)}`,
            metadata: { usage: { inputTokens: 800, outputTokens: 500, totalTokens: 1_300 } },
          }
        }
        assert.deepEqual(input.tools, [])
        return { kind: 'final', content: '已发现日历工具。' }
      },
    },
    tools: [],
    searchableTools: [deferred],
    store,
  })
  await first.send('Find a calendar tool.')
  await first.compact()

  let resumedInvocation = 0
  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        resumedInvocation += 1
        assert.equal(input.messages.some(message =>
          message.role === 'assistant'
          && 'toolCalls' in message
          && message.toolCalls.some(call => call.name === 'ToolSearch')
        ), false)
        return resumedInvocation === 1
          ? {
              kind: 'tool-calls',
              calls: [{
                id: 'list-calendar',
                name: 'ExecuteTool',
                arguments: { tool_name: deferred.description.name, params: {} },
              }],
            }
          : { kind: 'final', content: 'still available after checkpoint' }
      },
    },
    tools: [],
    searchableTools: [deferred],
    store,
  })

  assert.equal(await resumed.send('Use the calendar tool.'), 'still available after checkpoint')
})

test('fails automatic compaction before calling the model when no safe cursor exists', async () => {
  let modelCalls = 0
  const session = await AgentSession.create({
    model: {
      async generate() {
        modelCalls += 1
        return { kind: 'final', content: 'should not run' }
      },
    },
    tools: [],
    store: new MemorySessionStore(),
    contextLimits: { autoCompactTokenLimit: 1 },
  })

  await assert.rejects(session.send('too large for an empty history'), /completed Step/)
  assert.equal(modelCalls, 0)
})

test('reports nothing to compact when manual compaction has no completed Step', async () => {
  const session = await AgentSession.create({
    model: { async generate() { return { kind: 'final', content: 'unused' } } },
    tools: [],
    store: new MemorySessionStore(),
  })

  await assert.rejects(session.compact(), /no completed Step to compact/)
})

test('replays durable history when a restored Responses continuation is unavailable', async () => {
  const store = new MemorySessionStore()
  const project = {
    id: 'project-1',
    name: 'demo',
    roots: [{ path: '/project', role: 'primary' as const }],
  }
  const first = await AgentSession.create({
    model: {
      async generate() {
        return {
          kind: 'final',
          content: 'first done',
          metadata: { providerResponseId: 'response-expired' },
        }
      },
    },
    tools: [],
    store,
    project,
  })
  await first.send('first')

  const requests: Array<{
    messages: readonly Message[]
    previousResponseId?: string
  }> = []
  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        requests.push({
          messages: structuredClone(input.messages),
          ...(input.previousResponseId === undefined
            ? {}
            : { previousResponseId: input.previousResponseId }),
        })
        if (requests.length === 1) {
          throw new ModelContinuationUnavailableError('Previous response expired')
        }
        return {
          kind: 'final',
          content: 'second done',
          metadata: { providerResponseId: 'response-rebuilt' },
        }
      },
    },
    tools: [],
    store,
    project,
  })

  assert.equal(await resumed.send('second'), 'second done')
  assert.deepEqual(requests.map(request => ({
    roles: request.messages.map(message => message.role),
    ...(request.previousResponseId === undefined
      ? {}
      : { previousResponseId: request.previousResponseId }),
  })), [
    {
      roles: ['user'],
      previousResponseId: 'response-expired',
    },
    {
      roles: ['system', 'user', 'assistant', 'user'],
    },
  ])

  const resumedAgain = await AgentSession.resume(first.id, {
    model: {
      async generate(input) {
        assert.equal(input.previousResponseId, 'response-rebuilt')
        assert.deepEqual(input.messages, [{ role: 'user', content: 'third' }])
        return {
          kind: 'final',
          content: 'third done',
          metadata: { providerResponseId: 'response-next' },
        }
      },
    },
    tools: [],
    store,
    project,
  })
  assert.equal(await resumedAgain.send('third'), 'third done')
})

test('does not replay durable history for an ordinary model failure', async () => {
  const store = new MemorySessionStore()
  const first = await AgentSession.create({
    model: {
      async generate() {
        return {
          kind: 'final',
          content: 'first done',
          metadata: { providerResponseId: 'response-active' },
        }
      },
    },
    tools: [],
    store,
  })
  await first.send('first')

  let requests = 0
  const resumed = await AgentSession.resume(first.id, {
    model: {
      async generate() {
        requests += 1
        throw new Error('provider unavailable')
      },
    },
    tools: [],
    store,
  })

  await assert.rejects(resumed.send('second'), /provider unavailable/)
  assert.equal(requests, 1)
})
