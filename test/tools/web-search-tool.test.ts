import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import test from 'node:test'

import type { Tool } from '../../src/runtime/types.ts'
import { createWebSearchTool } from '../../src/tools/web-search-tool.ts'

test('WebSearch forces the Responses web_search Tool and returns only provider sources', async t => {
  const fixture = await startServer(t, (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/compatible-mode/v1/responses')
    assert.match(request.headers.authorization ?? '', /^Bearer search-key$/)
    const body = readBody(request)
    body.then(payload => {
      const parsed = JSON.parse(payload)
      assert.equal(parsed.model, 'qwen3.7-flash')
      assert.match(parsed.input, /TypeScript/)
      assert.deepEqual(parsed.tools, [{ type: 'web_search' }])
      assert.equal(parsed.tool_choice, 'required')
      assert.equal(parsed.store, false)
      assert.equal(parsed.enable_search, undefined)
      assert.equal(parsed.response_format, undefined)
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      id: 'resp-search-1',
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            queries: ['TypeScript 5.9 release notes'],
            sources: [
              { type: 'url', url: 'https://example.com/ts-5-9' },
              { type: 'url', url: 'https://example.org/second' },
              { type: 'url', url: 'ftp://example.net/not-public-web' },
              { type: 'url', url: 'https://example.com/ts-5-9' },
            ],
          },
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The provider searched the web and found two sources.' }],
        },
      ],
      usage: { x_tools: { web_search: { count: 1 } } },
    }))
  })

  const result = await executeJson(createWebSearchTool({
    apiKey: 'search-key',
    endpoint: fixture.url,
    allowPrivateAddresses: true,
  }), { query: 'TypeScript 5.9' })

  assert.equal(result.count, 2)
  assert.equal(result.searchCallCount, 1)
  assert.deepEqual(result.searchQueries, ['TypeScript 5.9 release notes'])
  assert.deepEqual(result.results, [
    {
      index: 1,
      url: 'https://example.com/ts-5-9',
      siteName: 'example.com',
    },
    { index: 2, url: 'https://example.org/second', siteName: 'example.org' },
  ])
  assert.equal(result.summary, 'The provider searched the web and found two sources.')
  assert.equal(typeof result.durationMs, 'number')
})

test('WebSearch discards model text when the provider did not execute web_search', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      id: 'resp-no-search',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Try https://invented.example/result' }],
      }],
    }))
  })

  const result = await executeJson(createWebSearchTool({
    apiKey: 'search-key',
    endpoint: fixture.url,
    allowPrivateAddresses: true,
  }), { query: 'anything' })

  assert.equal(result.count, 0)
  assert.equal(result.searchCallCount, 0)
  assert.equal(result.summary, undefined)
  assert.match(result.message as string, /did not execute the required web_search Tool/)
})

test('WebSearch honors the count limit across multiple provider search calls', async t => {
  const many = Array.from({ length: 15 }, (_, position) => ({ type: 'url', url: `https://example.com/${position}` }))
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      id: 'resp-many',
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'first query', sources: many.slice(0, 8) } },
        { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['second query'], sources: many.slice(8) } },
      ],
    }))
  })

  const result = await executeJson(createWebSearchTool({
    apiKey: 'search-key',
    endpoint: fixture.url,
    allowPrivateAddresses: true,
  }), { query: 'anything', count: 3 })

  assert.equal(result.count, 3)
  assert.equal(result.searchCallCount, 2)
  assert.deepEqual(result.searchQueries, ['first query', 'second query'])
  const hits = result.results as { url: string }[]
  assert.deepEqual(hits.map(hit => hit.url), [
    'https://example.com/0',
    'https://example.com/1',
    'https://example.com/2',
  ])
})

test('WebSearch reports a completed search with no source URLs', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      id: 'resp-empty',
      status: 'completed',
      output: [{
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', queries: ['nothing matches'], sources: [] },
      }],
    }))
  })

  const result = await executeJson(createWebSearchTool({
    apiKey: 'search-key',
    endpoint: fixture.url,
    allowPrivateAddresses: true,
  }), { query: 'nothing matches' })

  assert.equal(result.count, 0)
  assert.equal(result.searchCallCount, 1)
  assert.equal(result.message, 'Web search completed but returned no public source URLs')
})

test('WebSearch surfaces backend errors as correctable messages', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'InvalidApiKey', message: 'Invalid API key' } }))
  })

  const result = await executeJson(createWebSearchTool({
    apiKey: 'bad-key',
    endpoint: fixture.url,
    allowPrivateAddresses: true,
  }), { query: 'anything' })

  assert.equal(result.count, 0)
  assert.match(result.message as string, /InvalidApiKey: Invalid API key/)
})

test('WebSearch times out slow backends', async t => {
  const fixture = await startServer(t, (_request, _response) => {
    // Never responds.
  })

  await assert.rejects(
    executeJson(createWebSearchTool({
      apiKey: 'search-key',
      endpoint: fixture.url,
      allowPrivateAddresses: true,
    }), { query: 'anything', timeoutMs: 50 }),
    /timed out/,
  )
})

test('WebSearch refuses non-public endpoints outside test wiring', async () => {
  const tool = createWebSearchTool({ apiKey: 'search-key', endpoint: 'http://dashscope.aliyuncs.com:9999/x' })
  await assert.rejects(tool.execute({ query: 'anything' }), /WebSearch endpoint must use https/)

  const loopback = createWebSearchTool({ apiKey: 'search-key', endpoint: 'http://127.0.0.1:9999/x' })
  await assert.rejects(
    loopback.execute({ query: 'anything' }),
    /must use https|refuses the non-public endpoint/,
  )
})

test('WebSearch validates argument names, types, and unknown keys', async () => {
  const tool = createWebSearchTool({ apiKey: 'search-key', endpoint: 'http://example.com' })
  await assert.rejects(tool.execute({}), /requires a non-empty query/)
  await assert.rejects(tool.execute({ query: '' }), /requires a non-empty query/)
  await assert.rejects(tool.execute('text'), /arguments must be an object/)
  await assert.rejects(tool.execute({ query: 'x', extra: true }), /unknown argument/)
  await assert.rejects(tool.execute({ query: 'x', count: 0 }), /must be an integer from 1/)
  await assert.rejects(tool.execute({ query: 'x', count: 21 }), /must be an integer from 1/)
  await assert.rejects(tool.execute({ query: 'x', timeoutMs: 0 }), /must be an integer from 1/)
})

test('WebSearch is an observe Tool that is safe to run in parallel', () => {
  const tool = createWebSearchTool({ apiKey: 'search-key' })
  assert.equal(tool.effect, 'observe')
  assert.equal(tool.parallelSafe, true)
  assert.equal(tool.description.name, 'WebSearch')
  const required = Reflect.get(tool.description.parameters, 'required')
  assert.deepEqual(required, ['query'])
  const properties = Reflect.get(tool.description.parameters, 'properties') as Record<string, unknown>
  assert.equal(Object.keys(properties).length, 3)
})

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void

interface ServerFixture {
  url: string
  close: () => Promise<void>
}

async function startServer(t: test.TestContext, handler: RequestHandler): Promise<ServerFixture> {
  const server: Server = createServer(handler)
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', () => resolvePromise()))
  t.after(async () => await new Promise<void>(resolvePromise => server.close(() => resolvePromise())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  return {
    url: `http://127.0.0.1:${address.port}/compatible-mode/v1/responses`,
    close: async () => await new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(resolvePromise => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
  })
}

async function executeJson(tool: Tool, input: unknown): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await tool.execute(input))
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}
