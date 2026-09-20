import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'

import type { AgentProject, ProjectRoot, FilesystemAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import { LspClientPool, type PooledLspClient } from './lsp-client-pool.ts'
import { resolveAuthorizedExistingPath } from './filesystem-tools.ts'
import { VueTsServerBridge } from './vue-tsserver-bridge.ts'

const LSP_TIMEOUT_MS = 15_000
const MAX_LOCATIONS = 200
const MAX_HOVER_CHARACTERS = 16_000
const TYPESCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'])
const require = createRequire(import.meta.url)
const typescriptLanguageServerPackage = require.resolve('typescript-language-server/package.json')
const typescriptLanguageServerCli = resolve(dirname(typescriptLanguageServerPackage), 'lib/cli.mjs')
const vueLanguageServerPackage = require.resolve('@vue/language-server/package.json')
const vueLanguageServerCli = resolve(dirname(vueLanguageServerPackage), 'bin/vue-language-server.js')
const typescriptPackage = require.resolve('typescript/package.json')
const typescriptSdk = resolve(dirname(typescriptPackage), 'lib')

type LspOperation = 'definition' | 'references' | 'hover'

/** Creates read-only Vue, TypeScript, and JavaScript intelligence backed by real LSP servers. */
export function createLspTool(
  project: AgentProject,
  accessMode: FilesystemAccessMode,
): Tool {
  const clients = new LspClientPool<LanguageServerQuery, Record<string, unknown>>(
    (_key, input) => new LanguageServerClient(input.root, input.languageServer),
  )
  return {
    parallelSafe: false,
    description: {
      name: 'LSP',
      description:
        'Query Vue, TypeScript, or JavaScript language intelligence. Use one-based line and column positions for definition, references, or hover information.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['definition', 'references', 'hover'],
            description: 'Language Server operation to perform.',
          },
          path: {
            type: 'string',
            description: 'Absolute path of a Vue, TypeScript, or JavaScript file.',
          },
          line: {
            type: 'integer',
            minimum: 1,
            description: 'One-based source line.',
          },
          column: {
            type: 'integer',
            minimum: 1,
            description: 'One-based source column.',
          },
        },
        required: ['operation', 'path', 'line', 'column'],
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      const input = readArguments(arguments_)
      const operation = requiredOperation(input)
      const inputPath = requiredString(input, 'path')
      const line = requiredInteger(input, 'line')
      const column = requiredInteger(input, 'column')
      const target = await resolveAuthorizedExistingPath(project, accessMode, inputPath, 'file')
      const root = await languageServerRoot(project, target.actualPath)
      const languageServer = languageServerFor(inputPath)
      const content = await readFile(target.actualPath, 'utf8')
      const query = {
        root,
        operation,
        targetPath: target.actualPath,
        languageServer,
        content,
        line,
        column,
      }
      const key = `${root.path}\0${languageServer.name}`
      return JSON.stringify(await clients.query(key, query))
    },
    async close() {
      await clients.close()
    },
  }
}

interface LanguageServerQuery {
  root: ProjectRoot
  operation: LspOperation
  targetPath: string
  languageServer: LanguageServerAdapter
  content: string
  line: number
  column: number
}

interface LanguageServerAdapter {
  name: 'typescript-language-server' | 'vue-language-server'
  cliPath: string
  arguments: readonly string[]
  languageId: string
  sourceDefinitionCommand?: string
}

class LanguageServerClient implements PooledLspClient<LanguageServerQuery, Record<string, unknown>> {
  private child: ChildProcessWithoutNullStreams | undefined
  private connection: MessageConnection | undefined
  private vueTsServer: VueTsServerBridge | undefined
  private readonly documents = new Map<string, { content: string; version: number }>()
  private tail: Promise<void> = Promise.resolve()
  private stderr = ''
  private bridgeError: Error | undefined
  private closing = false
  private active = true

  constructor(
    private readonly root: ProjectRoot,
    private readonly languageServer: LanguageServerAdapter,
  ) {}

  get healthy(): boolean {
    return this.active && (this.vueTsServer?.healthy ?? true)
  }

  async query(input: LanguageServerQuery): Promise<Record<string, unknown>> {
    const result = this.tail.then(async () => await this.querySerial(input))
    this.tail = result.then(() => undefined, () => undefined)
    return await result
  }

  async close(): Promise<void> {
    this.closing = true
    await this.tail
    const graceful = this.healthy
    const connection = this.connection
    const child = this.child
    this.connection = undefined
    this.child = undefined
    this.active = false
    if (connection && graceful) await shutdownLanguageServer(connection)
    else connection?.dispose()
    this.vueTsServer?.close()
    this.vueTsServer = undefined
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
  }

  private async querySerial(input: LanguageServerQuery): Promise<Record<string, unknown>> {
    const connection = await this.start()
    await this.syncDocument(connection, input)
    const position = { line: input.line - 1, character: input.column - 1 }
    const uri = pathToFileURL(input.targetPath).href
    const textDocumentPosition = { textDocument: { uri }, position }
    try {
      let result = await withTimeout(
        input.operation === 'references'
          ? connection.sendRequest('textDocument/references', {
              textDocument: { uri },
              position,
              context: { includeDeclaration: true },
            })
          : input.operation === 'definition' && this.languageServer.sourceDefinitionCommand
            ? connection.sendRequest('workspace/executeCommand', {
                command: this.languageServer.sourceDefinitionCommand,
                arguments: [uri, position],
              })
            : connection.sendRequest(
                input.operation === 'definition' ? 'textDocument/definition' : 'textDocument/hover',
                textDocumentPosition,
              ),
        input.operation,
      )
      if (input.operation === 'definition' && (result === null || result === undefined)) {
        result = await withTimeout(
          connection.sendRequest('textDocument/definition', textDocumentPosition),
          input.operation,
        )
      }
      if (this.bridgeError) throw this.bridgeError
      if (this.vueTsServer && lacksResult(input.operation, result)) {
        result = await this.vueTsServer.query(
          input.operation,
          input.targetPath,
          input.line,
          input.column,
        )
      }

      if (input.operation === 'hover') {
        return {
          languageServer: input.languageServer.name,
          operation: input.operation,
          path: input.targetPath,
          position: { line: input.line, column: input.column },
          hover: normalizeHover(result),
        }
      }
      const locations = await normalizeLocations(input.root.path, result)
      return {
        languageServer: input.languageServer.name,
        operation: input.operation,
        path: input.targetPath,
        position: { line: input.line, column: input.column },
        locations: locations.slice(0, MAX_LOCATIONS),
        truncated: locations.length > MAX_LOCATIONS,
      }
    } catch (error: unknown) {
      const details = this.stderr.trim()
      throw new Error(
        `LSP ${input.operation} failed: ${errorMessage(error)}${details ? `; server: ${details}` : ''}`,
        { cause: error },
      )
    }
  }

  private async start(): Promise<MessageConnection> {
    if (this.connection) return this.connection
    const child = spawn(
      process.execPath,
      [this.languageServer.cliPath, ...this.languageServer.arguments],
      { cwd: this.root.path, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.child = child
    child.once('error', () => {
      if (!this.closing) this.active = false
    })
    child.once('exit', () => {
      if (!this.closing) this.active = false
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (this.stderr.length < 8_000) this.stderr += String(chunk)
    })
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    )
    this.connection = connection
    if (this.languageServer.name === 'vue-language-server') {
      this.vueTsServer = new VueTsServerBridge(this.root.path)
      connection.onNotification('tsserver/request', async value => {
        if (!Array.isArray(value) || typeof value[0] !== 'number') return
        try {
          const response = await this.vueTsServer!.request(String(value[1]), value[2])
          connection.sendNotification('tsserver/response', [value[0], response])
        } catch (error: unknown) {
          this.bridgeError = error instanceof Error ? error : new Error(String(error))
          connection.sendNotification('tsserver/response', [value[0], null])
        }
      })
    }
    connection.listen()
    try {
      await withTimeout(connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'ai-agent', version: '0.1.0' },
        rootUri: pathToFileURL(this.root.path).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root.path).href, name: 'project' }],
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: {
            definition: {},
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
          },
        },
      }), 'initialize')
      await connection.sendNotification('initialized', {})
      return connection
    } catch (error: unknown) {
      this.active = false
      throw error
    }
  }

  private async syncDocument(
    connection: MessageConnection,
    input: LanguageServerQuery,
  ): Promise<void> {
    const previous = this.documents.get(input.targetPath)
    if (previous?.content === input.content) return
    await this.vueTsServer?.syncDocument(input.targetPath, input.content)
    const uri = pathToFileURL(input.targetPath).href
    if (!previous) {
      this.documents.set(input.targetPath, { content: input.content, version: 1 })
      await connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.languageServer.languageId,
          version: 1,
          text: input.content,
        },
      })
      return
    }
    const version = previous.version + 1
    this.documents.set(input.targetPath, { content: input.content, version })
    await connection.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: input.content }],
    })
  }
}

function lacksResult(operation: LspOperation, value: unknown): boolean {
  return operation === 'hover' ? value === null || value === undefined : !Array.isArray(value) || value.length === 0
}

async function shutdownLanguageServer(connection: MessageConnection): Promise<void> {
  try {
    await withTimeout(connection.sendRequest('shutdown'), 'shutdown', 1_000)
    connection.sendNotification('exit')
  } catch {
    // The enclosing Tool Call already owns the useful result or failure; shutdown is best effort.
  } finally {
    connection.dispose()
  }
}

interface NormalizedLocation {
  path: string
  start: { line: number; column: number }
  end: { line: number; column: number }
}

async function normalizeLocations(
  rootPath: string,
  value: unknown,
): Promise<NormalizedLocation[]> {
  const rawLocations = Array.isArray(value) ? value : value === null ? [] : [value]
  const locations: NormalizedLocation[] = []
  for (const raw of rawLocations) {
    if (!isRecord(raw)) continue
    const uri = typeof raw.uri === 'string'
      ? raw.uri
      : typeof raw.targetUri === 'string'
        ? raw.targetUri
        : undefined
    const range = isRecord(raw.range)
      ? raw.range
      : isRecord(raw.targetSelectionRange)
        ? raw.targetSelectionRange
        : undefined
    if (!uri || !range || !uri.startsWith('file:')) continue
    let actualPath: string
    try {
      actualPath = await realpath(fileURLToPath(uri))
    } catch {
      continue
    }
    if (!isInside(rootPath, actualPath)) continue
    const normalizedRange = normalizeRange(range)
    if (!normalizedRange) continue
    locations.push({
      path: actualPath,
      ...normalizedRange,
    })
  }
  return locations
}

function normalizeHover(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const content = hoverText(value.contents)
  const range = isRecord(value.range) ? normalizeRange(value.range) : undefined
  return {
    content: content.length > MAX_HOVER_CHARACTERS
      ? `${content.slice(0, MAX_HOVER_CHARACTERS - 1)}…`
      : content,
    ...(range === undefined ? {} : range),
  }
}

function hoverText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(hoverText).filter(Boolean).join('\n\n')
  if (!isRecord(value)) return ''
  if (typeof value.value === 'string') return value.value
  return ''
}

function normalizeRange(
  value: Record<string, unknown>,
): { start: { line: number; column: number }; end: { line: number; column: number } } | undefined {
  const start = normalizePosition(value.start)
  const end = normalizePosition(value.end)
  if (!start || !end) return undefined
  return { start, end }
}

function normalizePosition(value: unknown): { line: number; column: number } | undefined {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.character !== 'number') {
    return undefined
  }
  return { line: value.line + 1, column: value.character + 1 }
}

async function withTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs = LSP_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} exceeded the ${timeoutMs}ms timeout`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function languageServerFor(path: string): LanguageServerAdapter {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'vue') {
    return {
      name: 'vue-language-server',
      cliPath: vueLanguageServerCli,
      arguments: ['--stdio', `--tsdk=${typescriptSdk}`],
      languageId: 'vue',
    }
  }
  if (!extension || !TYPESCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(`LSP supports Vue, TypeScript, and JavaScript files only: ${path}`)
  }
  return {
    name: 'typescript-language-server',
    cliPath: typescriptLanguageServerCli,
    arguments: ['--stdio'],
    languageId: extension === 'ts' || extension === 'mts' || extension === 'cts'
      ? 'typescript'
      : extension === 'tsx'
        ? 'typescriptreact'
        : extension === 'jsx'
          ? 'javascriptreact'
          : 'javascript',
    sourceDefinitionCommand: '_typescript.goToSourceDefinition',
  }
}

function readArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('LSP arguments must be an object')
  const unknown = Object.keys(value).find(
    key => !['operation', 'path', 'line', 'column'].includes(key),
  )
  if (unknown) throw new Error(`LSP received unknown argument: ${unknown}`)
  return value
}

function requiredOperation(input: Record<string, unknown>): LspOperation {
  const value = input.operation
  if (value === 'definition' || value === 'references' || value === 'hover') return value
  throw new Error('LSP operation must be definition, references, or hover')
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`LSP requires a non-empty ${key}`)
  }
  return value
}

function requiredInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`LSP ${key} must be a positive integer`)
  }
  return value
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

async function languageServerRoot(
  project: AgentProject,
  absolutePath: string,
): Promise<ProjectRoot> {
  const root = [...project.roots]
    .filter(candidate => isInside(candidate.path, absolutePath))
    .sort((left, right) => right.path.length - left.path.length)[0]
  if (root) return root

  const containingDirectory = dirname(absolutePath)
  let candidate = containingDirectory
  while (true) {
    if (await containsProjectMarker(candidate)) {
      return { path: candidate, role: 'attached' }
    }
    const parent = dirname(candidate)
    if (parent === candidate) return { path: containingDirectory, role: 'attached' }
    candidate = parent
  }
}

async function containsProjectMarker(path: string): Promise<boolean> {
  for (const marker of ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']) {
    try {
      await access(resolve(path, marker))
      return true
    } catch {
      // A missing marker is expected while walking toward the filesystem root.
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
