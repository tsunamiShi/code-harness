import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAICompatibleChatTextModel } from '../../src/models/openai-compatible-chat-text-model.ts'

test('uses Chat Completions for an independent tool-free text request', async () => {
  let requestURL = ''
  let requestBody: unknown
  const model = new OpenAICompatibleChatTextModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'ZHIPU/GLM-5.3-Flash',
    maxRetries: 0,
    fetch: async (input, init) => {
      requestURL = String(input)
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'ZHIPU/GLM-5.3-Flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Change the arguments.' },
          finish_reason: 'stop',
          logprobs: null,
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const output = await model.generate({
    messages: [{ role: 'user', content: 'Review this repeat.' }],
    tools: [],
    maxTokens: 2048,
  })

  assert.equal(requestURL, 'https://provider.example/compatible-mode/v1/chat/completions')
  assert.deepEqual(requestBody, {
    model: 'ZHIPU/GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'Review this repeat.' }],
    max_tokens: 2048,
  })
  assert.deepEqual(output, {
    kind: 'final',
    content: 'Change the arguments.',
    metadata: {
      providerResponseId: 'chat-1',
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    },
  })
})

test('rejects Tools because the adapter is reserved for text review', async () => {
  const model = new OpenAICompatibleChatTextModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'guard-model',
  })

  await assert.rejects(model.generate({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', description: 'Read.', parameters: {} }],
  }), /does not accept Tools/)
})
