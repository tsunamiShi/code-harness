import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REQUEST_TIMEOUT_MS = 15_000
const require = createRequire(import.meta.url)
const tsserverPath = require.resolve('typescript/lib/tsserver.js')
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Bridges Vue Language Server's custom notifications to a Vue-enabled tsserver. */
export class VueTsServerBridge {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<string, string>()
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private active = true

  constructor(private readonly rootPath: string) {
    this.child = spawn(process.execPath, [
      tsserverPath,
      '--useInferredProjectPerProjectRoot',
      '--globalPlugins',
      '@vue/typescript-plugin',
      '--pluginProbeLocations',
      packageRoot,
      '--allowLocalPluginLoads',
    ], {
      cwd: rootPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stderr.resume()
    this.child.once('error', error => {
      this.active = false
      this.rejectPending(error)
    })
    this.child.once('close', () => {
      this.active = false
      this.rejectPending(new Error('Vue tsserver bridge closed'))
    })
  }

  get healthy(): boolean {
    return this.active
  }

  async syncDocument(filePath: string, content: string): Promise<void> {
    const previous = this.documents.get(filePath)
    if (previous === content) return
    if (previous === undefined) {
      this.send('open', {
        file: filePath,
        fileContent: content,
        projectRootPath: this.rootPath,
        scriptKindName: 'Deferred',
      })
    } else {
      this.send('updateOpen', {
        changedFiles: [{
          fileName: filePath,
          textChanges: [{
            start: { line: 1, offset: 1 },
            end: endPosition(previous),
            newText: content,
          }],
        }],
        closedFiles: [],
        openFiles: [],
      })
    }
    this.documents.set(filePath, content)
  }

  /** Queries TypeScript semantic features enhanced by the Vue TypeScript plugin. */
  async query(
    operation: 'definition' | 'references' | 'hover',
    filePath: string,
    line: number,
    column: number,
  ): Promise<unknown> {
    const location = { file: filePath, line, offset: column }
    if (operation === 'hover') {
      const result = await this.request('_vue:quickinfo', location)
      if (!isRecord(result)) return null
      return {
        contents: [result.displayString, documentationText(result.documentation)]
          .filter(value => typeof value === 'string' && value.length > 0)
          .join('\n\n'),
        range: protocolRange(result),
      }
    }
    if (operation === 'definition') {
      const result = await this.request('definitionAndBoundSpan', location)
      const definitions = isRecord(result) && Array.isArray(result.definitions)
        ? result.definitions
        : []
      return definitions.map(protocolLocation).filter(isDefined)
    }
    const result = await this.request('references', location)
    const references = isRecord(result) && Array.isArray(result.refs) ? result.refs : []
    return references.map(protocolLocation).filter(isDefined)
  }

  async request(command: string, arguments_: unknown): Promise<unknown> {
    const sequence = this.send(command, arguments_)
    return await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(sequence)
        reject(new Error(`Vue tsserver request ${command} exceeded ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(sequence, {
        resolve: value => {
          clearTimeout(timeout)
          resolvePromise(value)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
  }

  close(): void {
    this.active = false
    this.rejectPending(new Error('Vue tsserver bridge stopped'))
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }

  private send(command: string, arguments_: unknown): number {
    const sequence = ++this.sequence
    this.child.stdin.write(`${JSON.stringify({
      seq: sequence,
      type: 'request',
      command,
      arguments: arguments_,
    })}\n`)
    return sequence
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const lengthMatch = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header)
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const contentLength = Number(lengthMatch[1])
      const messageEnd = headerEnd + 4 + contentLength
      if (this.buffer.length < messageEnd) return
      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
      this.buffer = this.buffer.subarray(messageEnd)
      this.handleMessage(body)
    }
  }

  private handleMessage(body: string): void {
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return
    }
    if (!isRecord(message) || message.type !== 'response' || typeof message.request_seq !== 'number') {
      return
    }
    const pending = this.pending.get(message.request_seq)
    if (!pending) return
    this.pending.delete(message.request_seq)
    if (message.success === false) {
      pending.reject(new Error(
        typeof message.message === 'string' ? message.message : 'Vue tsserver request failed',
      ))
      return
    }
    pending.resolve(message.body)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function protocolLocation(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.file !== 'string') return undefined
  const range = protocolRange(value)
  if (!range) return undefined
  return { uri: pathToFileURL(value.file).href, range }
}

function protocolRange(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(value.start) || !isRecord(value.end)) return undefined
  const startLine = value.start.line
  const startColumn = value.start.offset
  const endLine = value.end.line
  const endColumn = value.end.offset
  if (
    typeof startLine !== 'number'
    || typeof startColumn !== 'number'
    || typeof endLine !== 'number'
    || typeof endColumn !== 'number'
  ) return undefined
  return {
    start: { line: startLine - 1, character: startColumn - 1 },
    end: { line: endLine - 1, character: endColumn - 1 },
  }
}

function documentationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function endPosition(content: string): { line: number; offset: number } {
  const lines = content.split('\n')
  return { line: lines.length, offset: (lines.at(-1)?.length ?? 0) + 1 }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
