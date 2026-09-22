import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSession, runAgent, type AgentEvent } from '../../src/runtime/agent-session.ts'
import { NoProgressLoopGuard, type LoopGuard } from '../../src/runtime/loop-guard.ts'
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
