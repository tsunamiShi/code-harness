import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAICompatibleChatModel } from '../../src/models/openai-compatible-chat-model.ts'
import type { ModelAttemptEvent } from '../../src/runtime/types.ts'

test('reports every provider attempt and completion usage', async () => {
  let requests = 0
  const events: ModelAttemptEvent[] = []
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 1,
    fetch: async () => {
      requests += 1
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
    onAttempt: async event => {
      events.push(structuredClone(event))
    },
  })

  assert.equal(requests, 2)
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
