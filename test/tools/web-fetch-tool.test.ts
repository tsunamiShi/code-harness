import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import test from 'node:test'

import type { Tool } from '../../src/runtime/types.ts'
import { createWebFetchTool } from '../../src/tools/web-fetch-tool.ts'

test('WebFetch converts an HTML page to readable text and reports metadata', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
<html>
<head>
  <title>Example &amp; Demo</title>
  <script>window.secret = 'hidden-script'</script>
  <style>.hidden { display: none }</style>
</head>
<body>
  <h1>Heading</h1>
  <p>First &lt;paragraph&gt; with &quot;quotes&quot; and caf&eacute;.</p>
  <ul>
    <li>one</li>
    <li>two</li>
  </ul>
</body>
</html>`)
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: fixture.url,
  })

  assert.equal(result.status, 200)
  assert.equal(result.finalUrl, `${fixture.url}/`)
  assert.equal(result.url, `${fixture.url}/`)
  assert.equal(result.redirects, 0)
  assert.equal(result.contentType, 'text/html; charset=utf-8')
  assert.equal(result.title, 'Example & Demo')
  assert.match(result.text as string, /Heading/)
  assert.match(result.text as string, /First <paragraph> with "quotes" and café\./)
  assert.match(result.text as string, /- one\s+- two/)
  assert.doesNotMatch(result.text as string, /hidden-script/)
  assert.doesNotMatch(result.text as string, /display: none/)
  assert.equal(result.textTruncated, undefined)
})

test('WebFetch follows redirects and reports the final URL', async t => {
  const fixture = await startServer(t, (request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { Location: '/middle' })
      response.end()
      return
    }
    if (request.url === '/middle') {
      response.writeHead(301, { Location: '/final' })
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('final body')
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: `${fixture.url}/start`,
  })

  assert.equal(result.redirects, 2)
  assert.equal(result.finalUrl, `${fixture.url}/final`)
  assert.equal(result.text, 'final body')
})

test('WebFetch returns HTTP error statuses as correctable results with text bodies', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found here')
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: fixture.url,
  })

  assert.equal(result.status, 404)
  assert.equal(result.text, 'not found here')
})

test('WebFetch rejects redirect cycles and excessive redirects', async t => {
  const fixture = await startServer(t, (request, response) => {
    response.writeHead(302, { Location: request.url })
    response.end()
  })

  await assert.rejects(
    executeJson(createWebFetchTool({ allowPrivateAddresses: true }), { url: fixture.url }),
    /redirect cycle|exceeded the 5-redirect limit/,
  )
})

test('WebFetch refuses reserved hosts, private addresses, credentials, and non-default ports', async () => {
  const tool = createWebFetchTool()
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://user:password@example.com/',
    'ftp://example.com/file',
    'http://example.com:8080/',
    'not-a-url',
  ]) {
    await assert.rejects(
      tool.execute({ url }),
      (error: unknown) => {
        assert.ok(error instanceof Error, url)
        assert.match(error.message, /^WebFetch /, `${url}: ${error.message}`)
        return true
      },
    )
  }
})

test('WebFetch rejects DNS names that resolve to private addresses', async () => {
  const tool = createWebFetchTool()
  await assert.rejects(
    tool.execute({ url: 'http://metadata.google.internal/' }),
    /WebFetch /,
  )
})

test('WebFetch truncates oversized text bodies with head and tail', async t => {
  const largeText = `A${'x'.repeat(200_000)}Z`
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end(largeText)
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: fixture.url,
  })

  assert.equal(result.textTruncated, true)
  const text = result.text as string
  assert.ok(text.startsWith('A'))
  assert.ok(text.endsWith('Z'))
  assert.ok(text.includes('WebFetch omitted'))
})

test('WebFetch caps response bytes on very large responses', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    response.write(Buffer.alloc(3 * 1024 * 1024, 7))
    response.end()
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: fixture.url,
  })

  assert.equal(result.bytesTruncated, true)
  assert.ok((result.bodyBytes as number) <= 2 * 1024 * 1024)
  assert.match(result.message as string, /not textual/)
})

test('WebFetch summarizes non-textual content without a body', async t => {
  const fixture = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  const result = await executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
    url: fixture.url,
  })

  assert.equal(result.text, undefined)
  assert.match(result.message as string, /image\/png/)
})

test('WebFetch times out slow responses', async t => {
  const fixture = await startServer(t, (_request, _response) => {
    // Never responds.
  })

  await assert.rejects(
    executeJson(createWebFetchTool({ allowPrivateAddresses: true }), {
      url: fixture.url,
      timeoutMs: 50,
    }),
    /timed out/,
  )
})

test('WebFetch validates argument names, types, and unknown keys', async () => {
  const tool = createWebFetchTool()
  await assert.rejects(tool.execute({}), /requires a non-empty url/)
  await assert.rejects(tool.execute({ url: '' }), /requires a non-empty url/)
  await assert.rejects(tool.execute('http://example.com/'), /must be an object/)
  await assert.rejects(tool.execute({ url: 'http://example.com/', extra: true }), /unknown argument/)
  await assert.rejects(
    tool.execute({ url: 'http://example.com/', timeoutMs: 0 }),
    /must be an integer from 1/,
  )
  await assert.rejects(
    tool.execute({ url: 'http://example.com/', timeoutMs: 500_000 }),
    /must be an integer from 1/,
  )
})

test('WebFetch is an observe Tool that is safe to run in parallel', () => {
  const tool = createWebFetchTool()
  assert.equal(tool.effect, 'observe')
  assert.equal(tool.parallelSafe, true)
  assert.equal(tool.description.name, 'WebFetch')
  const required = Reflect.get(tool.description.parameters, 'required')
  assert.deepEqual(required, ['url'])
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
    url: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
  }
}

async function executeJson(tool: Tool, input: unknown): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await tool.execute(input))
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}
