import assert from 'node:assert/strict'
import test from 'node:test'

import OpenAI from 'openai'

import { OpenAICompatibleResponsesModel } from '../../src/models/openai-compatible-responses-model.ts'
import type { ModelAttemptEvent, ToolDescription } from '../../src/runtime/types.ts'

const readTool: ToolDescription = {
  name: 'Read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

test('does not impose an application-level model request timeout by default', () => {
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
  })

  assert.equal(model.descriptor.protocol, 'openai-responses')
  assert.equal(Reflect.has(model.descriptor, 'requestTimeoutMs'), false)
  const client = Reflect.get(model, 'client')
  assert.equal(Reflect.get(client as object, 'timeout'), OpenAI.DEFAULT_TIMEOUT)
})

test('uses the Responses endpoint and maps incremental function inputs and outputs', async () => {
  let requestURL = ''
  let requestBody: unknown
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async (input, init) => {
      requestURL = String(input)
      requestBody = JSON.parse(String(init?.body))
      return sseResponse({
        id: 'response-2',
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'function-call-2',
          call_id: 'call-2',
          name: 'Read',
          arguments: '{"path":"/project/next.ts"}',
          status: 'completed',
        }],
        output_text: '',
      })
    },
  })

  const output = await model.generate({
    messages: [{ role: 'tool', toolCallId: 'call-1', content: 'first file' }],
    tools: [readTool],
    maxTokens: 4096,
    previousResponseId: 'response-1',
  })

  assert.equal(requestURL, 'https://provider.example/compatible-mode/v1/responses')
  assert.deepEqual(requestBody, {
    model: 'test-model',
    input: [{
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'first file',
    }],
    previous_response_id: 'response-1',
    max_output_tokens: 4096,
    tools: [{
      type: 'function',
      name: 'Read',
      description: 'Read a file',
      parameters: readTool.parameters,
      strict: false,
    }],
    parallel_tool_calls: true,
    stream: true,
  })
  assert.deepEqual(output, {
    kind: 'tool-calls',
    calls: [{ id: 'call-2', name: 'Read', arguments: { path: '/project/next.ts' } }],
    metadata: {
      providerResponseId: 'response-2',
      finishReason: 'completed',
    },
  })
})

test('reports every provider attempt and completed response metadata', async () => {
  let requests = 0
  const events: ModelAttemptEvent[] = []
  const model = new OpenAICompatibleResponsesModel({
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
      return sseResponse({
        id: 'response-1',
        status: 'completed',
        output: [
          {
            id: 'reasoning-1',
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Checked the request.' }],
            status: 'completed',
          },
          {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        ],
        output_text: 'done',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }, { 'x-request-id': 'request-completed' })
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
  assert.deepEqual(events.map(event => event.type), [
    'started',
    'headers-received',
    'failed',
    'started',
    'headers-received',
    'first-event',
    'completed',
  ])
  assert.deepEqual(events[1], {
    type: 'headers-received',
    attempt: 1,
    httpStatus: 500,
    durationMs: events[1]?.type === 'headers-received' ? events[1].durationMs : -1,
    providerRequestId: 'request-failed',
  })
  assert.deepEqual(events[2], {
    type: 'failed',
    attempt: 1,
    phase: 'headers-received',
    durationMs: events[2]?.type === 'failed' ? events[2].durationMs : -1,
    eventCount: 0,
    errorName: 'HTTPError',
    errorMessage: 'HTTP 500 Internal Server Error',
    httpStatus: 500,
    providerRequestId: 'request-failed',
  })
  assert.deepEqual(events[5], {
    type: 'first-event',
    attempt: 2,
    eventType: 'response.created',
    durationMs: events[5]?.type === 'first-event' ? events[5].durationMs : -1,
  })
  assert.equal(events[6]?.type === 'completed' ? events[6].eventCount : undefined, 2)
  assert.deepEqual(output, {
    kind: 'final',
    content: 'done',
    reasoningContent: 'Checked the request.',
    metadata: {
      providerResponseId: 'response-1',
      providerRequestId: 'request-completed',
      finishReason: 'completed',
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

test('omits max_output_tokens when no output token limit is configured', async () => {
  let requestBody: unknown
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return sseResponse({
        id: 'response-with-provider-default',
        status: 'completed',
        output: [{
          id: 'message-default',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done', annotations: [] }],
        }],
      })
    },
  })

  await model.generate({ messages: [{ role: 'user', content: 'hello' }], tools: [] })

  assert.equal(Reflect.has(requestBody as object, 'max_output_tokens'), false)
})

test('rejects a response truncated by the per-invocation output token limit', async () => {
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async () => sseResponse({
      id: 'response-truncated',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      output_text: 'partial answer',
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

test('accepts DashScope reasoning deltas without a preceding content part event', async () => {
  const created = responseBody({
    id: 'response-dashscope-reasoning',
    status: 'in_progress',
    output: [],
  })
  const completed = responseBody({
    id: 'response-dashscope-reasoning',
    status: 'completed',
    output: [{
      type: 'function_call',
      id: 'function-call-1',
      call_id: 'call-1',
      name: 'Read',
      arguments: '{"path":"/project/file.ts"}',
      status: 'completed',
    }],
  })
  const reasoningItem = {
    id: 'reasoning-1',
    type: 'reasoning',
    summary: [],
    status: 'in_progress',
  }
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async () => sseEvents([
      { type: 'response.created', sequence_number: 0, response: created },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: reasoningItem,
      },
      {
        type: 'response.reasoning_text.delta',
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        item_id: 'reasoning-1',
        delta: 'inspect',
      },
      { type: 'response.completed', sequence_number: 3, response: completed },
    ]),
  })

  const output = await model.generate({
    messages: [{ role: 'user', content: 'inspect the file' }],
    tools: [readTool],
  })

  assert.deepEqual(output, {
    kind: 'tool-calls',
    calls: [{ id: 'call-1', name: 'Read', arguments: { path: '/project/file.ts' } }],
    metadata: {
      providerResponseId: 'response-dashscope-reasoning',
      finishReason: 'completed',
    },
  })
})

test('reports the underlying transport cause when an SSE request fails before headers', async () => {
  const events: ModelAttemptEvent[] = []
  const transportCause = Object.assign(new Error('Headers Timeout Error'), {
    name: 'HeadersTimeoutError',
    code: 'UND_ERR_HEADERS_TIMEOUT',
  })
  const model = new OpenAICompatibleResponsesModel({
    apiKey: 'test-key',
    baseURL: 'https://provider.example/compatible-mode/v1',
    model: 'test-model',
    maxRetries: 0,
    fetch: async () => {
      throw new TypeError('fetch failed', { cause: transportCause })
    },
  })

  await assert.rejects(
    model.generate({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onAttempt: async event => {
        events.push(structuredClone(event))
      },
    }),
    /Request timed out/,
  )

  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { type: 'started', attempt: 1 })
  assert.deepEqual(events[1], {
    type: 'failed',
    attempt: 1,
    phase: 'requesting',
    durationMs: events[1]?.type === 'failed' ? events[1].durationMs : -1,
    eventCount: 0,
    errorName: 'TypeError',
    errorMessage: 'fetch failed',
    causeName: 'HeadersTimeoutError',
    causeCode: 'UND_ERR_HEADERS_TIMEOUT',
    causeMessage: 'Headers Timeout Error',
  })
})

function sseResponse(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  const completed = responseBody(body)
  const created = responseBody({
    ...body,
    status: 'in_progress',
    output: [],
    output_text: '',
    usage: null,
  })
  return sseEvents([
    { type: 'response.created', sequence_number: 0, response: created },
    { type: 'response.completed', sequence_number: 1, response: completed },
  ], headers)
}

function sseEvents(
  events: readonly Record<string, unknown>[],
  headers: Record<string, string> = {},
): Response {
  return new Response([
    ...events.flatMap(event => [
      `event: ${String(event.type)}`,
      `data: ${JSON.stringify(event)}`,
      '',
    ]),
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function responseBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'response-default',
    object: 'response',
    created_at: 1,
    model: 'test-model',
    error: null,
    incomplete_details: null,
    usage: null,
    output: [],
    ...body,
  }
}
