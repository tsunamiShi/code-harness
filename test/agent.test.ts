import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSession, runAgent } from '../src/agent.ts'
import type { Message, Model, ModelOutput, Tool } from '../src/types.ts'

test('feeds a tool result back to the model before returning the final answer', async () => {
  const recordedRequests: Message[][] = []
  let call = 0
  const model: Model = {
    async generate(input): Promise<ModelOutput> {
      recordedRequests.push([...input.messages])
      call += 1
      return call === 1
        ? {
            kind: 'tool-call',
            call: { id: 'call-1', name: 'search', arguments: { query: 'Nvidia' } },
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
      toolCall: { id: 'call-1', name: 'search', arguments: { query: 'Nvidia' } },
    },
    { role: 'tool', toolCallId: 'call-1', content: 'result' },
  ])
})

test('stops an agent that never produces a final answer', async () => {
  const model: Model = {
    async generate() {
      return {
        kind: 'tool-call' as const,
        call: { id: 'loop', name: 'search', arguments: {} },
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
  const session = new AgentSession({ model, tools: [] })

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
  const session = new AgentSession({ model, tools: [] })

  await assert.rejects(session.send('failed turn'), /provider unavailable/)
  assert.deepEqual(session.history(), [])
  assert.equal(await session.send('new turn'), 'recovered')
  assert.deepEqual(session.history(), [
    { role: 'user', content: 'new turn' },
    { role: 'assistant', content: 'recovered' },
  ])
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
  const session = new AgentSession({ model, tools: [] })
  const first = session.send('first')
  await started.promise

  await assert.rejects(session.send('second'), /already has a running turn/)
  release.resolve()
  assert.equal(await first, 'done')
})
