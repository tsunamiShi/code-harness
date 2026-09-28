import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

import type { Tool } from '../runtime/types.ts'

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_URL_CHARACTERS = 2_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 64_000
const USER_AGENT = 'code-harness-web-fetch/0.1'

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/iu,
  /\.localhost$/iu,
  /^127\./u,
  /^0\./u,
  /^10\./u,
  /^169\.254\./u,
  /^192\.168\./u,
  /^172\.(1[6-9]|2\d|3[01])\./u,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u,
  /^198\.1[89]\./u,
  /^\./u,
  /^metadata\.google\.internal$/iu,
]

type ResponseSummary = {
  status: number
  contentType?: string
  bodyBytes: number
  truncated: boolean
}

type FetchedResult = {
  url: string
  finalUrl: string
  redirects: number
  status: number
  contentType?: string
  bodyBytes: number
  bytesTruncated: boolean
  text?: string
  textTruncated?: boolean
  message?: string
  durationMs: number
}

export interface WebFetchToolOptions {
  /** Permits loopback and private targets. Reserved for tests against a local server. */
  allowPrivateAddresses?: boolean
}

/** Creates a read-only HTTP(S) fetch Tool that returns page text for one exact URL. */
export function createWebFetchTool(options: WebFetchToolOptions = {}): Tool {
  const allowPrivateAddresses = options.allowPrivateAddresses === true
  return {
    effect: 'observe',
    parallelSafe: true,
    description: {
      name: 'WebFetch',
      description:
        `Fetch one exact http or https URL and return its body converted to readable text. Use it only when the URL is already known; find unknown addresses with a search capability first. Follows at most ${MAX_REDIRECTS} redirects, allows default ports only, refuses private or loopback targets, and truncates responses beyond ${MAX_TEXT_CHARACTERS} characters. HTTP error statuses are returned as results for correction.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_URL_CHARACTERS,
            description: 'Absolute http(s) URL without credentials, fragment, or non-default port.',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description: `Fetch timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      const input = readArguments(arguments_)
      const url = requiredString(input, 'url')
      if (url.length > MAX_URL_CHARACTERS) {
        throw new Error(`WebFetch url exceeds the ${MAX_URL_CHARACTERS}-character limit`)
      }
      const timeoutMs = optionalInteger(input, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS
      return JSON.stringify(await fetchDocument(url, { timeoutMs, allowPrivateAddresses }))
    },
  }
}

interface FetchDocumentOptions {
  timeoutMs: number
  allowPrivateAddresses: boolean
}

async function fetchDocument(rawUrl: string, options: FetchDocumentOptions): Promise<FetchedResult> {
  const startedAt = performance.now()
  const initial = parseTargetUrl(rawUrl, options)
  const visited = new Set<string>([initial.href])
  let current = initial
  let redirects = 0

  while (true) {
    const pinnedAddresses = await resolvePublicAddress(current, options)
    const outcome = await fetchOnce(current, pinnedAddresses, options.timeoutMs)
    if (outcome.kind === 'redirect') {
      redirects += 1
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`WebFetch exceeded the ${MAX_REDIRECTS}-redirect limit`)
      }
      const next = parseTargetUrl(new URL(outcome.location, current).href, options)
      if (visited.has(next.href)) {
        throw new Error(`WebFetch redirect cycle detected at ${next.href}`)
      }
      visited.add(next.href)
      current = next
      continue
    }

    const { summary, body } = outcome
    return {
      url: initial.href,
      finalUrl: current.href,
      redirects,
      status: summary.status,
      ...(summary.contentType === undefined ? {} : { contentType: summary.contentType }),
      bodyBytes: summary.bodyBytes,
      bytesTruncated: summary.truncated,
      ...summarizeBody(summary, body),
      durationMs: Math.round(performance.now() - startedAt),
    }
  }
}

type SingleFetchOutcome =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'response'; summary: ResponseSummary; body: Buffer }

async function fetchOnce(
  url: URL,
  pinnedAddresses: readonly LookupAddress[],
  timeoutMs: number,
): Promise<SingleFetchOutcome> {
  const isHttps = url.protocol === 'https:'
  const requestModule = isHttps ? httpsRequest : httpRequest
  const requestOptions: HttpRequestOptions & Partial<HttpsRequestOptions> = {
    hostname: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      'Accept-Encoding': 'identity',
    },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (url.protocol === 'https:' && isIP(url.hostname) === 0) {
    requestOptions.servername = url.hostname
  }
  if (pinnedAddresses.length > 0) requestOptions.lookup = pinAddresses(pinnedAddresses)

  return await new Promise<SingleFetchOutcome>((resolvePromise, reject) => {
    const summary: ResponseSummary = { status: 0, bodyBytes: 0, truncated: false }
    const chunks: Buffer[] = []

    const outgoing = requestModule(requestOptions, response => {
      summary.status = response.statusCode ?? 0
      const contentType = normalizeHeaderValue(response.headers['content-type'])
      if (contentType !== undefined) summary.contentType = contentType
      const location = normalizeHeaderValue(response.headers.location)
      if (isRedirectStatus(summary.status) && location !== undefined) {
        response.resume()
        resolvePromise({ kind: 'redirect', status: summary.status, location })
        return
      }

      response.on('data', (chunk: Buffer) => {
        const remaining = MAX_RESPONSE_BYTES - summary.bodyBytes
        if (chunk.length > remaining) {
          summary.truncated = true
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining))
            summary.bodyBytes += remaining
          }
          resolvePromise({ kind: 'response', summary, body: Buffer.concat(chunks) })
          outgoing.destroy()
          return
        }
        chunks.push(chunk)
        summary.bodyBytes += chunk.length
      })
      response.on('end', () => {
        resolvePromise({ kind: 'response', summary, body: Buffer.concat(chunks) })
      })
      response.on('error', error => {
        reject(new Error(`WebFetch response error: ${error.message}`))
      })
    })
    outgoing.on('error', error => {
      if (error.name === 'AbortError') {
        reject(new Error(`WebFetch timed out after ${timeoutMs}ms`))
        return
      }
      reject(new Error(`WebFetch request error: ${error.message}`))
    })
    outgoing.end()
  })
}

/** Pins DNS answers validated before the connection so a re-resolved private address cannot be used. */
function pinAddresses(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, _options, callback) => {
    if (addresses.length === 0) {
      callback(new Error('WebFetch has no validated addresses for this host'), '', 0)
      return
    }
    callback(null, [...addresses])
  }
}

async function resolvePublicAddress(
  url: URL,
  options: { allowPrivateAddresses: boolean },
): Promise<readonly LookupAddress[]> {
  const hostname = url.hostname
  if (isIP(hostname) !== 0) {
    if (!options.allowPrivateAddresses && !isPublicIpLiteral(hostname)) {
      throw new Error(`WebFetch refuses the private address ${hostname}`)
    }
    return []
  }
  if (!options.allowPrivateAddresses && BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(hostname))) {
    throw new Error(`WebFetch refuses the reserved host ${hostname}`)
  }

  let addresses: LookupAddress[]
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  } catch (error: unknown) {
    throw new Error(
      `WebFetch cannot resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (addresses.length === 0) throw new Error(`WebFetch host ${hostname} has no addresses`)
  if (options.allowPrivateAddresses) return addresses
  for (const entry of addresses) {
    if (!isPublicIpLiteral(entry.address)) {
      throw new Error(`WebFetch host ${hostname} resolves to the private address ${entry.address}`)
    }
  }
  return addresses
}

function isPublicIpLiteral(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(address))
  if (family === 6) {
    const value = address.toLowerCase()
    if (value === '::' || value === '::1') return false
    if (/^f[cd][0-9a-f]*:/u.test(value)) return false
    if (/^fe[89ab][0-9a-f]*:/u.test(value)) return false
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)
    return mapped === null ? true : isPublicIpLiteral(mapped[1]!)
  }
  return false
}

function parseTargetUrl(rawUrl: string, options?: { allowPrivateAddresses: boolean }): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`WebFetch url must be an absolute http(s) URL: ${rawUrl}`)
  }
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`WebFetch supports http and https only, received ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('WebFetch url must not embed credentials')
  }
  if (url.hash !== '') url = new URL(`${url.origin}${url.pathname}${url.search}`)
  if (url.port !== '' && options?.allowPrivateAddresses !== true) {
    throw new Error(`WebFetch only reaches default ports, received :${url.port}`)
  }
  return url
}

function summarizeBody(summary: ResponseSummary, body: Buffer): {
  title?: string
  text?: string
  textTruncated?: boolean
  message?: string
} {
  if (body.length === 0) return {}
  const contentType = summary.contentType ?? ''
  if (!isTextualContentType(contentType)) {
    const described = contentType.trim().length === 0 ? 'unknown' : contentType.trim()
    return { message: `Content type ${described} is not textual; ${summary.bodyBytes} body bytes omitted` }
  }
  const decoded = decodeCharset(body, detectCharset(body, contentType))
  if (isHtmlContentType(contentType)) {
    const { text, title } = htmlToText(decoded)
    const bounded = boundText(text)
    return {
      ...(title === undefined || title.length === 0 ? {} : { title }),
      text: bounded.text,
      ...(bounded.truncated ? { textTruncated: true } : {}),
    }
  }
  const bounded = boundText(decoded)
  return { text: bounded.text, ...(bounded.truncated ? { textTruncated: true } : {}) }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.find(entry => entry.trim().length > 0)?.trim() || undefined
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function detectCharset(body: Buffer, contentType: string): string | undefined {
  const fromHeader = /charset\s*=\s*"?([^\s;"]+)"?/iu.exec(contentType)?.[1]
  if (fromHeader !== undefined) return fromHeader
  const head = body.subarray(0, 2048).toString('latin1')
  return /<meta[^>]+charset\s*=\s*["']?([^\s;"'>]+)/iu.exec(head)?.[1]
}

function decodeCharset(body: Buffer, charset: string | undefined): string {
  if (charset === undefined) return body.toString('utf8').replace(/^\uFEFF/u, '')
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body)
  } catch {
    return body.toString('utf8').replace(/^\uFEFF/u, '')
  }
}

function isTextualContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type.startsWith('text/')) return true
  return type === 'application/json'
    || type.endsWith('+json')
    || type.endsWith('+xml')
    || type === 'application/xml'
    || type === 'application/javascript'
}

function isHtmlContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'text/html' || type === 'application/xhtml+xml'
}

function boundText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TEXT_CHARACTERS) return { text: value, truncated: false }
  const head = value.slice(0, Math.ceil(MAX_TEXT_CHARACTERS * 0.7))
  const tail = value.slice(-Math.floor(MAX_TEXT_CHARACTERS * 0.3))
  return {
    text: `${head}\n\n… WebFetch omitted ${value.length - MAX_TEXT_CHARACTERS} characters …\n\n${tail}`,
    truncated: true,
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', cacute: 'ć', zcaron: 'ž',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  ntilde: 'ñ', szlig: 'ß', times: '×', divide: '÷', para: '¶', sect: '§', dagger: '†', euro: '€', pound: '£', yen: '¥', cent: '¢',
}

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10_FFFF
        || (codePoint >= 0xD8_00 && codePoint <= 0xDF_FF)) {
        return match
      }
      return String.fromCodePoint(codePoint)
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function htmlToText(html: string): { text: string; title?: string } {
  const titleRaw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)?.[1]
  const title = titleRaw === undefined ? undefined : collapseWhitespace(decodeEntities(titleRaw))

  let withoutBlocks = html.replace(/<!--[\s\S]*?-->/gu, ' ')
  for (const block of ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed']) {
    withoutBlocks = withoutBlocks.replace(
      new RegExp(`<${block}\\b[^>]*>[\\s\\S]*?<\\/${block}\\s*>`, 'gi'),
      ' ',
    )
  }
  const withoutTags = withoutBlocks
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|section|article|aside|header|footer|nav|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|h[1-6]|blockquote|pre|figure|figcaption|form|fieldset|address|li)\s*>/gi, '\n')
    .replace(/<(?:p|div|section|article|aside|header|footer|nav|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|h[1-6]|blockquote|pre|figure|figcaption|form|fieldset|hr|address)\b[^>]*>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/gu, ' ')

  const text = normalizeLines(decodeEntities(withoutTags))
  return { text, ...(title === undefined || title.length === 0 ? {} : { title }) }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function normalizeLines(value: string): string {
  return value
    .split('\n')
    .map(line => line.replace(/[ \t]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function readArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('WebFetch arguments must be an object')
  const unknown = Object.keys(value).find(key => !['url', 'timeoutMs'].includes(key))
  if (unknown) throw new Error(`WebFetch received unknown argument: ${unknown}`)
  return value
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`WebFetch requires a non-empty ${key}`)
  }
  return value.trim()
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`WebFetch ${key} must be an integer from 1 through ${MAX_TIMEOUT_MS}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
