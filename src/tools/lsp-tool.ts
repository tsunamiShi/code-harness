import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'

import type { AgentProject, ProjectRoot, WorkspaceAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import {
  resolveExistingWorkspacePath,
  selectWorkspaceRoot,
  workspaceRootProperty,
} from './workspace-tools.ts'

const LSP_TIMEOUT_MS = 15_000
const MAX_LOCATIONS = 200
const MAX_HOVER_CHARACTERS = 16_000
const TYPESCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'])
const require = createRequire(import.meta.url)
const languageServerPackage = require.resolve('typescript-language-server/package.json')
const languageServerCli = resolve(dirname(languageServerPackage), 'lib/cli.mjs')

type LspOperation = 'definition' | 'references' | 'hover'

/** Creates read-only TypeScript language intelligence backed by a real LSP server. */
export function createLspTool(
  project: AgentProject,
  accessMode: WorkspaceAccessMode,
): Tool {
  return {
    parallelSafe: false,
    description: {
      name: 'LSP',
      description:
        'Query TypeScript or JavaScript language intelligence. Use one-based line and column positions for definition, references, or hover information.',
      parameters: {
        type: 'object',
        properties: {
          root: workspaceRootProperty(project, accessMode),
          operation: {
            type: 'string',
            enum: ['definition', 'references', 'hover'],
            description: 'Language Server operation to perform.',
          },
          path: {
            type: 'string',
            description: 'TypeScript or JavaScript file relative to the selected root.',
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
      const root = await selectWorkspaceRoot(project, accessMode, optionalString(input, 'root'))
      const target = await resolveExistingWorkspacePath(root, inputPath, 'file')
      const languageId = languageIdFor(inputPath)
      const content = await readFile(target.actualPath, 'utf8')
      return JSON.stringify(await queryLanguageServer({
        root,
        operation,
        targetPath: target.actualPath,
        displayPath: target.displayPath,
        languageId,
        content,
        line,
        column,
      }))
    },
  }
}

interface LanguageServerQuery {
  root: ProjectRoot
  operation: LspOperation
  targetPath: string
  displayPath: string
  languageId: string
  content: string
  line: number
  column: number
}

async function queryLanguageServer(input: LanguageServerQuery): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [languageServerCli, '--stdio'], {
    cwd: input.root.path,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill()
    throw new Error('LSP server did not expose stdio streams')
  }
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', chunk => {
    if (stderr.length < 8_000) stderr += String(chunk)
  })
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  )
  connection.listen()

  try {
    await withTimeout(connection.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: { name: 'ai-agent', version: '0.1.0' },
      rootUri: pathToFileURL(input.root.path).href,
      workspaceFolders: [{ uri: pathToFileURL(input.root.path).href, name: 'workspace' }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          definition: {},
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    }), 'initialize')
    connection.sendNotification('initialized', {})
    const uri = pathToFileURL(input.targetPath).href
    connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: input.languageId,
        version: 1,
        text: input.content,
      },
    })
    const position = { line: input.line - 1, character: input.column - 1 }
    const textDocumentPosition = { textDocument: { uri }, position }
    let result = await withTimeout(
      input.operation === 'references'
        ? connection.sendRequest('textDocument/references', {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          })
        : input.operation === 'definition'
          ? connection.sendRequest('workspace/executeCommand', {
              command: '_typescript.goToSourceDefinition',
              arguments: [uri, position],
            })
          : connection.sendRequest('textDocument/hover', textDocumentPosition),
      input.operation,
    )
    if (input.operation === 'definition' && (result === null || result === undefined)) {
      result = await withTimeout(
        connection.sendRequest('textDocument/definition', textDocumentPosition),
        input.operation,
      )
    }

    if (input.operation === 'hover') {
      return {
        root: input.root.path,
        operation: input.operation,
        path: input.displayPath,
        position: { line: input.line, column: input.column },
        hover: normalizeHover(result),
      }
    }
    const locations = await normalizeLocations(input.root.path, result)
    return {
      root: input.root.path,
      operation: input.operation,
      path: input.displayPath,
      position: { line: input.line, column: input.column },
      locations: locations.slice(0, MAX_LOCATIONS),
      truncated: locations.length > MAX_LOCATIONS,
    }
  } catch (error: unknown) {
    const details = stderr.trim()
    throw new Error(
      `LSP ${input.operation} failed: ${errorMessage(error)}${details ? `; server: ${details}` : ''}`,
      { cause: error },
    )
  } finally {
    await shutdownLanguageServer(connection)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
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
      path: toDisplayPath(rootPath, actualPath),
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

function languageIdFor(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (!extension || !TYPESCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(`LSP supports TypeScript and JavaScript files only: ${path}`)
  }
  if (extension === 'ts' || extension === 'mts' || extension === 'cts') return 'typescript'
  if (extension === 'tsx') return 'typescriptreact'
  if (extension === 'jsx') return 'javascriptreact'
  return 'javascript'
}

function readArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('LSP arguments must be an object')
  const unknown = Object.keys(value).find(
    key => !['root', 'operation', 'path', 'line', 'column'].includes(key),
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

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`LSP ${key} must be a non-empty string`)
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

function toDisplayPath(rootPath: string, candidatePath: string): string {
  return relative(rootPath, candidatePath).split(sep).join('/') || '.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
