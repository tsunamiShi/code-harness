import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSession, runAgent, type AgentEvent } from '../../src/runtime/agent-session.ts'
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

test('stops an agent that never produces a final answer', async () => {
  const model: Model = {
    async generate() {
      return {
        kind: 'tool-calls' as const,
        calls: [{ id: 'loop', name: 'search', arguments: {} }],
      }
    },
  }
  const search: Tool = {
    description: {
      name: 'search',
      description: 'Search the web.',
      parameters: { type: 'object' },
    },
    async execute() {
      return 'same result'
    },
  }

  await assert.rejects(
    runAgent({ model, tools: [search], prompt: 'loop', maxSteps: 2 }),
    /2-step limit/,
  )
})

test('allows ten tool steps followed by a final answer with the default budget', async () => {
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

test('reserves the final available step for an answer without tools', async () => {
  let request = 0
  const model: Model = {
    async generate(input) {
      request += 1
      if (input.tools.length === 0) return { kind: 'final', content: 'budget summary' }
      return {
        kind: 'tool-calls',
        calls: [{ id: `call-${request}`, name: 'search', arguments: {} }],
      }
    },
  }
  const search: Tool = {
    description: { name: 'search', description: 'Search.', parameters: {} },
    async execute() {
      return 'result'
    },
  }

  assert.equal(
    await runAgent({ model, tools: [search], prompt: 'explore', maxSteps: 3 }),
    'budget summary',
  )
  assert.equal(request, 3)
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

test('rolls back a failed turn before accepting the next turn', async () => {
  let request = 0
  const model: Model = {
    async generate() {
      request += 1
      if (request === 1) throw new Error('provider unavailable')
      return { kind: 'final', content: 'recovered' }
    },
  }
  const store = new MemorySessionStore()
  const session = await AgentSession.create({ model, tools: [], store })

  await assert.rejects(session.send('failed turn'), /provider unavailable/)
  assert.deepEqual(session.history(), [])
  const failedSnapshot = await store.loadSession(session.id)
  assert.equal(failedSnapshot?.turns[0]?.status, 'failed')
  assert.equal(failedSnapshot?.turns[0]?.error, 'provider unavailable')
  assert.equal(await session.send('new turn'), 'recovered')
  assert.deepEqual(session.history(), [
    { role: 'user', content: 'new turn' },
    { role: 'assistant', content: 'recovered' },
  ])
})

test('records a failed model invocation before failing the turn', async () => {
  const inner = new MemorySessionStore()
  const records: SessionRecord[] = []
  const store: SessionStore = {
    createSession: async projectId => await inner.createSession(projectId),
    loadSession: async sessionId => await inner.loadSession(sessionId),
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
