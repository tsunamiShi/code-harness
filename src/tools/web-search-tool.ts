import { isIP, type LookupFunction } from 'node:net'

import type { Tool } from '../runtime/types.ts'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 120_000
const MAX_QUERY_CHARACTERS = 400
const MAX_COUNT = 20
const DEFAULT_COUNT = 10
const USER_AGENT = 'code-harness-web-search/0.1'

/**
 * DashScope-hosted search backend. The endpoint is fixed, so the Tool exposes no
 * URL or host override; only public cloud services are contacted.
 */
const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses'

type SearchSource = {
  index: number
  url: string
  siteName: string
}

export interface WebSearchToolOptions {
  apiKey: string
  /** DashScope API key holder's endpoint; defaults to the public cloud service. */
  endpoint?: string
  /** Responses model that can call DashScope's built-in web_search Tool. */
  model?: string
  /** Permits loopback and private targets. Reserved for tests against a local server. */
  allowPrivateAddresses?: boolean
}

/**
 * Creates a read-only Web Search Tool that forces DashScope's server-side
 * web_search Tool and returns only URLs present in completed web_search_call
 * output items. Provider-generated prose is never accepted as source evidence.
 */
export function createWebSearchTool(options: WebSearchToolOptions): Tool {
  const endpoint = options.endpoint === undefined ? DEFAULT_ENDPOINT : options.endpoint
  const model = options.model === undefined ? 'qwen3.7-flash' : options.model
  const allowPrivateAddresses = options.allowPrivateAddresses === true
  return {
    effect: 'observe',
    parallelSafe: true,
    description: {
      name: 'WebSearch',
      description:
        `Search the public web with DashScope's required server-side web_search Tool and return up to ${MAX_COUNT} provider-reported source URLs plus a synthesized summary. Use it when an address or current fact is unknown; verify exact source URLs with WebFetch before relying on the summary.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_CHARACTERS,
            description: 'One natural-language search query; keep it specific and self-contained.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_COUNT,
            description: `Maximum results to return. Defaults to ${DEFAULT_COUNT}.`,
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description: `Search timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      const input = readArguments(arguments_)
      const query = requiredString(input, 'query')
      const count = optionalInteger(input, 'count', MAX_COUNT) ?? DEFAULT_COUNT
      const timeoutMs = optionalInteger(input, 'timeoutMs', MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
      return JSON.stringify(
        await searchWeb(query, { apiKey: options.apiKey, endpoint, model, count, timeoutMs, allowPrivateAddresses }),
      )
    },
  }
}

interface SearchExecutionOptions {
  apiKey: string
  endpoint: string
  model: string
  count: number
  timeoutMs: number
  allowPrivateAddresses: boolean
}

interface SearchOutcome {
  sources: SearchSource[]
  searchQueries: string[]
  searchCallCount: number
  summary?: string
  message?: string
}

async function searchWeb(
  query: string,
  options: SearchExecutionOptions,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now()
  const target = parseSearchEndpoint(options.endpoint, options.allowPrivateAddresses)
  const outcome = await requestSearch(query, target, options)
  const durationMs = Math.round(performance.now() - startedAt)
  return {
    query,
    model: options.model,
    searchCallCount: outcome.searchCallCount,
    ...(outcome.searchQueries.length === 0 ? {} : { searchQueries: outcome.searchQueries }),
    count: outcome.sources.length,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
    ...(outcome.sources.length === 0 ? {} : { results: outcome.sources }),
    ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
    durationMs,
  }
}

async function requestSearch(
  query: string,
  target: URL,
  options: SearchExecutionOptions,
): Promise<SearchOutcome> {
  const payload = {
    model: options.model,
    input:
      `Use the web_search tool to search the public web for the query below. `
      + `Return a concise summary grounded only in the sources found. The caller will use at most ${options.count} source URLs.\n\n`
      + `Query: ${query}`,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    store: false,
  }
  const response = await postJson(target, payload, options)
  if (response.body === undefined) {
    return {
      sources: [],
      searchQueries: [],
      searchCallCount: 0,
      message: response.message ?? 'WebSearch backend returned no Response object',
    }
  }
  return parseResponsesSearch(response.body, options.count)
}

function parseResponsesSearch(body: Record<string, unknown>, count: number): SearchOutcome {
  if (body.status !== 'completed') {
    const error = isRecord(body.error) && typeof body.error.message === 'string'
      ? body.error.message
      : `Responses API returned status ${String(body.status ?? 'unknown')}`
    return { sources: [], searchQueries: [], searchCallCount: 0, message: error }
  }
  const output = Array.isArray(body.output) ? body.output.filter(isRecord) : []
  const calls = output.filter(item => item.type === 'web_search_call' && item.status === 'completed')
  if (calls.length === 0) {
    return {
      sources: [],
      searchQueries: [],
      searchCallCount: 0,
      message: 'DashScope did not execute the required web_search Tool; no unverified model output was returned',
    }
  }

  const searchQueries = uniqueStrings(calls.flatMap(call => readSearchQueries(call.action)))
  const urls = uniqueStrings(calls.flatMap(call => readSearchSourceUrls(call.action)))
  const sources = urls.slice(0, count).map((url, position) => ({
    index: position + 1,
    url,
    siteName: new URL(url).hostname,
  }))
  const summary = readResponseOutputText(output)
  return {
    sources,
    searchQueries,
    searchCallCount: calls.length,
    ...(summary === undefined ? {} : { summary }),
    ...(sources.length === 0 ? { message: 'Web search completed but returned no public source URLs' } : {}),
  }
}

function readSearchQueries(action: unknown): string[] {
  if (!isRecord(action)) return []
  const queries = Array.isArray(action.queries)
    ? action.queries.filter((value): value is string => typeof value === 'string')
    : []
  return typeof action.query === 'string' ? [...queries, action.query] : queries
}

function readSearchSourceUrls(action: unknown): string[] {
  if (!isRecord(action) || !Array.isArray(action.sources)) return []
  return action.sources.flatMap(source => {
    const raw = typeof source === 'string'
      ? source
      : isRecord(source) && (source.type === undefined || source.type === 'url') && typeof source.url === 'string'
        ? source.url
        : undefined
    if (raw === undefined) return []
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
      if (url.username !== '' || url.password !== '') return []
      url.hash = ''
      return [url.toString()]
    } catch {
      return []
    }
  })
}

function readResponseOutputText(output: readonly Record<string, unknown>[]): string | undefined {
  const text = output.flatMap(item => {
    if (item.type !== 'message' || !Array.isArray(item.content)) return []
    return item.content.flatMap(part => isRecord(part) && typeof part.text === 'string' ? [part.text] : [])
  }).join('\n').trim()
  return text.length === 0 ? undefined : text
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(value => value.length > 0))]
}

type BackendResponse = {
  status: number
  requestId?: string
  body?: Record<string, unknown>
  message?: string
}

async function postJson(
  target: URL,
  payload: unknown,
  options: { apiKey: string; timeoutMs: number },
): Promise<BackendResponse> {
  const isHttps = target.protocol === 'https:'
  const requestModule = isHttps ? (await import('node:https')).request : (await import('node:http')).request
  const body = JSON.stringify(payload)
  return await new Promise<BackendResponse>((resolvePromise, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const outgoing = requestModule(
      {
        hostname: target.hostname,
        ...(target.port === '' ? {} : { port: Number(target.port) }),
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'Content-Length': Buffer.byteLength(body),
        },
        ...(isHttps && isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      response => {
        const status = response.statusCode ?? 0
        const requestId = normalizeHeaderValue(response.headers['x-request-id'])
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          if (chunks.reduce((sum, part) => sum + part.length, 0) > MAX_RESPONSE_BYTES) {
            settle(() => reject(new Error('WebSearch response exceeded the size limit')))
            outgoing.destroy()
          }
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          settle(() => resolvePromise(parseBackendResponse(status, requestId, text)))
        })
        response.on('error', error => {
          settle(() => reject(new Error(`WebSearch response error: ${error.message}`)))
        })
      },
    )
    outgoing.on('error', error => {
      if (error.name === 'AbortError') {
        settle(() => reject(new Error(`WebSearch timed out after ${options.timeoutMs}ms`)))
        return
      }
      settle(() => reject(new Error(`WebSearch request error: ${error.message}`)))
    })
    outgoing.end(body)
  })
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function parseBackendResponse(status: number, requestId: string | undefined, text: string): BackendResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      status,
      ...(requestId === undefined ? {} : { requestId }),
      message: `WebSearch backend returned a non-JSON body (HTTP ${status})`,
    }
  }
  if (!isRecord(parsed)) return { status, ...(requestId === undefined ? {} : { requestId }), message: `WebSearch backend returned an unexpected body (HTTP ${status})` }
  if (status < 200 || status >= 300) {
    const error = isRecord(parsed.error) ? parsed.error : parsed
    const message = typeof error.message === 'string' ? error.message : `HTTP ${status}`
    const code = typeof error.code === 'string' ? error.code : undefined
    return {
      status,
      ...(requestId === undefined ? {} : { requestId }),
      message: code === undefined ? message : `WebSearch backend error ${code}: ${message}`,
    }
  }
  return { status, ...(requestId === undefined ? {} : { requestId }), body: parsed }
}

function parseSearchEndpoint(rawUrl: string, allowPrivateAddresses: boolean): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`WebSearch endpoint must be an absolute http(s) URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowPrivateAddresses)) {
    throw new Error(`WebSearch endpoint must use https, received ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('WebSearch endpoint must not embed credentials')
  }
  if (url.hash !== '') url = new URL(`${url.origin}${url.pathname}${url.search}`)
  if (!allowPrivateAddresses && isPrivateOrLoopbackHost(url.hostname)) {
    throw new Error(`WebSearch refuses the non-public endpoint host ${url.hostname}`)
  }
  return url
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const family = isIP(hostname)
  if (family === 4) return isPrivateIpv4(hostname)
  if (family === 6) {
    const value = hostname.toLowerCase()
    if (value === '::' || value === '::1') return true
    if (/^f[cd][0-9a-f]*:/u.test(value)) return true
    if (/^fe[89ab][0-9a-f]*:/u.test(value)) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)
    return mapped === null ? false : isPrivateIpv4(mapped[1]!)
  }
  return /^localhost$/iu.test(hostname) || /\.localhost$/iu.test(hostname) || hostname.startsWith('.')
}

function isPrivateIpv4(address: string): boolean {
  return address === '127.0.0.1' || address === '0.0.0.0'
    || address.startsWith('127.') || address.startsWith('0.')
    || address.startsWith('10.') || address.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(address)
    || address.startsWith('169.254.')
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(address)
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.find(entry => entry.trim().length > 0)?.trim() || undefined
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function readArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('WebSearch arguments must be an object')
  const unknown = Object.keys(value).find(key => !['query', 'count', 'timeoutMs'].includes(key))
  if (unknown) throw new Error(`WebSearch received unknown argument: ${unknown}`)
  return value
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`WebSearch requires a non-empty ${key}`)
  }
  return value.trim()
}

function optionalInteger(input: Record<string, unknown>, key: string, maximum: number): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`WebSearch ${key} must be an integer from 1 through ${maximum}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
