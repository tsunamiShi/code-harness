import assert from 'node:assert/strict'
import test from 'node:test'

import OpenAI from 'openai'

import { OpenAICompatibleChatModel } from '../../src/models/openai-compatible-chat-model.ts'
import type { ModelAttemptEvent } from '../../src/runtime/types.ts'

test('does not impose an application-level model request timeout by default', () => {
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
  })

  assert.equal(Reflect.has(model.descriptor, 'requestTimeoutMs'), false)
  const client = Reflect.get(model, 'client')
  assert.equal(Reflect.get(client as object, 'timeout'), OpenAI.DEFAULT_TIMEOUT)
})

test('reports every provider attempt and completion usage', async () => {
  let requests = 0
  const requestBodies: unknown[] = []
  const events: ModelAttemptEvent[] = []
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 1,
    fetch: async (_input, init) => {
      requests += 1
      requestBodies.push(JSON.parse(String(init?.body)))
      if (requests === 1) {
        return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: {
            'content-type': 'application/json',
            'retry-after-ms': '0',
            'x-request-id': 'request-failed',
          },
        })
      }
      return new Response(JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'done' },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'request-completed',
        },
      })
    },
  })

  const output = await model.generate({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 4096,
    onAttempt: async event => {
      events.push(structuredClone(event))
    },
  })

  assert.equal(requests, 2)
  assert.equal(Reflect.get(requestBodies[0] as object, 'max_tokens'), 4096)
  assert.equal(Reflect.get(requestBodies[1] as object, 'max_tokens'), 4096)
  assert.deepEqual(events, [
    { type: 'started', attempt: 1 },
    {
      type: 'failed',
      attempt: 1,
      errorName: 'HTTPError',
      errorMessage: 'HTTP 500 Internal Server Error',
      httpStatus: 500,
      providerRequestId: 'request-failed',
    },
    { type: 'started', attempt: 2 },
    {
      type: 'completed',
      attempt: 2,
      httpStatus: 200,
      providerRequestId: 'request-completed',
    },
  ])
  assert.deepEqual(output, {
    kind: 'final',
    content: 'done',
    metadata: {
      providerRequestId: 'request-completed',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      },
    },
  })
})

test('omits max_tokens when no output token limit is configured', async () => {
  let requestBody: unknown
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: 'completion-with-provider-default',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'done' },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await model.generate({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  })

  assert.equal(Reflect.has(requestBody as object, 'max_tokens'), false)
})

test('rejects a response truncated by the per-invocation token limit', async () => {
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({
      id: 'completion-truncated',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{
        index: 0,
        finish_reason: 'length',
        logprobs: null,
        message: { role: 'assistant', content: 'partial answer' },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  await assert.rejects(
    model.generate({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 128,
    }),
    /128-token output limit/,
  )
})
