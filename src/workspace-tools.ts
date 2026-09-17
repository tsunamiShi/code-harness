import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { glob, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { rgPath } from '@vscode/ripgrep'

import {
  primaryRoot,
  type AgentProject,
  type ProjectRoot,
  type WorkspaceAccessMode,
} from './project.ts'
import type { Tool } from './types.ts'

const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 1_000
const MAX_READ_CHARACTERS = 64_000
const DEFAULT_GLOB_RESULTS = 200
const MAX_GLOB_RESULTS = 2_000
const MAX_GLOB_CANDIDATES = 10_000
const DEFAULT_GREP_RESULTS = 100
const MAX_GREP_RESULTS = 500
const GREP_TIMEOUT_MS = 10_000
const MAX_GREP_LINE_CHARACTERS = 1_000
const BINARY_SAMPLE_BYTES = 8_192
const DEFAULT_EXCLUDES = ['.git/**', 'node_modules/**', 'dist/**'] as const

/** Creates the complete read-only filesystem tool set for one Project. */
export function createWorkspaceTools(
  project: AgentProject,
  accessMode: WorkspaceAccessMode = 'scoped',
): readonly Tool[] {
  const workspace = new Workspace(project, accessMode)
  const rootProperty = workspace.rootProperty()
  const scope = accessMode === 'full' ? 'the selected local directory' : 'the Project'

  return [
    {
      parallelSafe: true,
      description: {
        name: 'Read',
        description:
          `Read UTF-8 text from a file inside ${scope}. Paths are relative to the selected root.`,
        parameters: {
          type: 'object',
          properties: {
            root: rootProperty,
            path: {
              type: 'string',
              description: 'File path relative to the selected Workspace Root.',
            },
            offset: {
              type: 'integer',
              minimum: 1,
              description: 'First line to return, using one-based line numbers. Defaults to 1.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_READ_LINES,
              description: `Maximum lines to return. Defaults to ${DEFAULT_READ_LINES}.`,
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Read', ['root', 'path', 'offset', 'limit'])
        return serialize(
          await workspace.read({
            root: optionalString(input, 'root'),
            path: requiredString(input, 'path', 'Read'),
            offset: optionalInteger(input, 'offset', 1, Number.MAX_SAFE_INTEGER) ?? 1,
            limit: optionalInteger(input, 'limit', 1, MAX_READ_LINES) ?? DEFAULT_READ_LINES,
          }),
        )
      },
    },
    {
      parallelSafe: true,
      description: {
        name: 'Glob',
        description:
          `Find files by a glob pattern inside ${scope}. Results are relative to the selected root.`,
        parameters: {
          type: 'object',
          properties: {
            root: rootProperty,
            pattern: {
              type: 'string',
              description: 'Glob pattern such as src/**/*.ts.',
            },
            path: {
              type: 'string',
              description: 'Optional directory relative to the selected root in which to search.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GLOB_RESULTS,
              description: `Maximum files to return. Defaults to ${DEFAULT_GLOB_RESULTS}.`,
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Glob', ['root', 'pattern', 'path', 'limit'])
        return serialize(
          await workspace.glob({
            root: optionalString(input, 'root'),
            pattern: requiredString(input, 'pattern', 'Glob'),
            path: optionalString(input, 'path'),
            limit:
              optionalInteger(input, 'limit', 1, MAX_GLOB_RESULTS) ?? DEFAULT_GLOB_RESULTS,
          }),
        )
      },
    },
    {
      parallelSafe: true,
      description: {
        name: 'Grep',
        description:
          `Search UTF-8 text files with a regular expression inside ${scope}. Each result identifies one matching line.`,
        parameters: {
          type: 'object',
          properties: {
            root: rootProperty,
            pattern: {
              type: 'string',
              description: 'Rust regular expression accepted by ripgrep.',
            },
            path: {
              type: 'string',
              description: 'Optional file or directory relative to the selected root.',
            },
            glob: {
              type: 'string',
              description: 'Optional file filter such as **/*.ts.',
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Whether matching is case-sensitive. Defaults to true.',
            },
            maxResults: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GREP_RESULTS,
              description: `Maximum matching lines to return. Defaults to ${DEFAULT_GREP_RESULTS}.`,
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Grep', [
          'root',
          'pattern',
          'path',
          'glob',
          'caseSensitive',
          'maxResults',
        ])
        return serialize(
          await workspace.grep({
            root: optionalString(input, 'root'),
            pattern: requiredString(input, 'pattern', 'Grep'),
            path: optionalString(input, 'path'),
            glob: optionalString(input, 'glob'),
            caseSensitive: optionalBoolean(input, 'caseSensitive') ?? true,
            maxResults:
              optionalInteger(input, 'maxResults', 1, MAX_GREP_RESULTS)
              ?? DEFAULT_GREP_RESULTS,
          }),
        )
      },
    },
  ]
}

interface ReadInput {
  root: string | undefined
  path: string
  offset: number
  limit: number
}

interface GlobInput {
  root: string | undefined
  pattern: string
  path: string | undefined
  limit: number
}

interface GrepInput {
  root: string | undefined
  pattern: string
  path: string | undefined
  glob: string | undefined
  caseSensitive: boolean
  maxResults: number
}

class Workspace {
  private readonly primary: ProjectRoot
  private readonly rootsByPath: ReadonlyMap<string, ProjectRoot>

  constructor(
    private readonly project: AgentProject,
    private readonly accessMode: WorkspaceAccessMode,
  ) {
    this.primary = primaryRoot(project)
    this.rootsByPath = new Map(project.roots.map(root => [root.path, root]))
  }

  rootProperty(): Record<string, unknown> {
    if (this.accessMode === 'full') {
      return {
        type: 'string',
        description:
          'Absolute local directory to use as the root. Omit or use primary for the Primary Root.',
      }
    }
    return {
      type: 'string',
      enum: ['primary', ...this.project.roots.map(root => root.path)],
      description:
        'Workspace Root to use. Omit or use primary for the Primary Root; attached roots use their absolute path from the Project context.',
    }
  }

  async read(input: ReadInput): Promise<Record<string, unknown>> {
    const root = await this.selectRoot(input.root)
    const target = await this.resolveExisting(root, input.path, 'file')
    await assertTextFile(target.actualPath, input.path)

    const lines: Array<{ line: number; text: string }> = []
    let lineNumber = 0
    let characters = 0
    let truncated = false
    const reader = createInterface({
      input: createReadStream(target.actualPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    for await (const text of reader) {
      lineNumber += 1
      if (lineNumber < input.offset) continue
      if (lines.length >= input.limit) {
        truncated = true
        break
      }
      const remaining = MAX_READ_CHARACTERS - characters
      if (remaining <= 0) {
        truncated = true
        break
      }
      const visible = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text
      lines.push({ line: lineNumber, text: visible })
      characters += visible.length
      if (visible.length !== text.length) {
        truncated = true
        break
      }
    }

    return {
      root: root.path,
      path: target.displayPath,
      lines,
      truncated,
    }
  }

  async glob(input: GlobInput): Promise<Record<string, unknown>> {
    const root = await this.selectRoot(input.root)
    const pattern = requireRelativePattern(input.pattern, 'Glob pattern')
    const base = await this.resolveExisting(root, input.path ?? '.', 'directory')
    const files: string[] = []
    let candidateCount = 0
    let scanLimitReached = false

    try {
      for await (const match of glob(pattern, {
        cwd: base.actualPath,
        exclude: DEFAULT_EXCLUDES,
      })) {
        candidateCount += 1
        if (candidateCount > MAX_GLOB_CANDIDATES) {
          scanLimitReached = true
          break
        }
        const candidate = await existingFileInside(root, resolve(base.actualPath, match))
        if (!candidate) continue
        files.push(toDisplayPath(root.path, candidate))
      }
    } catch (error: unknown) {
      throw new Error(`Glob failed for pattern ${JSON.stringify(input.pattern)}: ${errorMessage(error)}`)
    }

    const uniqueFiles = [...new Set(files)].sort()
    return {
      root: root.path,
      pattern: input.pattern,
      files: uniqueFiles.slice(0, input.limit),
      truncated: scanLimitReached || uniqueFiles.length > input.limit,
    }
  }

  async grep(input: GrepInput): Promise<Record<string, unknown>> {
    if (input.pattern.length === 0) throw new Error('Grep pattern must not be empty')
    const root = await this.selectRoot(input.root)
    const target = await this.resolveExisting(root, input.path ?? '.', 'file-or-directory')
    const fileGlob = input.glob === undefined
      ? undefined
      : requireRelativePattern(input.glob, 'Grep glob')
    const matches = await runRipgrep({
      root,
      targetPath: toDisplayPath(root.path, target.actualPath),
      pattern: input.pattern,
      fileGlob,
      caseSensitive: input.caseSensitive,
      maxResults: input.maxResults,
    })
    return {
      root: root.path,
      pattern: input.pattern,
      matches: matches.items,
      limitReached: matches.limitReached,
    }
  }

  private async selectRoot(value: string | undefined): Promise<ProjectRoot> {
    if (value === undefined || value === 'primary') return this.primary
    const root = this.rootsByPath.get(value)
    if (root) return root
    if (this.accessMode === 'scoped') throw new Error(`Unknown Workspace Root: ${value}`)
    if (!isAbsolute(value)) {
      throw new Error(`Full-access root must be an absolute directory: ${value}`)
    }
    let actualPath: string
    try {
      actualPath = await realpath(value)
    } catch (error: unknown) {
      throw new Error(`Full-access root does not exist: ${value}`, { cause: error })
    }
    if (!(await stat(actualPath)).isDirectory()) {
      throw new Error(`Full-access root is not a directory: ${value}`)
    }
    return { path: actualPath, role: 'attached' }
  }

  private async resolveExisting(
    root: ProjectRoot,
    inputPath: string,
    expected: 'file' | 'directory' | 'file-or-directory',
  ): Promise<{ actualPath: string; displayPath: string }> {
    const relativePath = requireRelativePath(inputPath)
    const lexicalPath = resolve(root.path, relativePath)
    assertInside(root.path, lexicalPath, inputPath)

    let actualPath: string
    try {
      actualPath = await realpath(lexicalPath)
    } catch (error: unknown) {
      throw new Error(`Workspace path does not exist: ${inputPath}`, { cause: error })
    }
    assertInside(root.path, actualPath, inputPath)

    const details = await stat(actualPath)
    if (expected === 'file' && !details.isFile()) {
      throw new Error(`Workspace path is not a file: ${inputPath}`)
    }
    if (expected === 'directory' && !details.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${inputPath}`)
    }
    if (expected === 'file-or-directory' && !details.isFile() && !details.isDirectory()) {
      throw new Error(`Workspace path is not a file or directory: ${inputPath}`)
    }
    return { actualPath, displayPath: toDisplayPath(root.path, lexicalPath) }
  }
}

interface RipgrepInput {
  root: ProjectRoot
  targetPath: string
  pattern: string
  fileGlob: string | undefined
  caseSensitive: boolean
  maxResults: number
}

interface GrepMatch {
  path: string
  line: number
  text: string
}

async function runRipgrep(
  input: RipgrepInput,
): Promise<{ items: GrepMatch[]; limitReached: boolean }> {
  const arguments_ = [
    '--json',
    '--hidden',
    '--sort',
    'path',
    '--max-filesize',
    '2M',
    ...(input.fileGlob === undefined ? [] : ['--glob', input.fileGlob]),
    ...DEFAULT_EXCLUDES.flatMap(pattern => ['--glob', `!${pattern}`]),
    ...(input.caseSensitive ? [] : ['--ignore-case']),
    '--',
    input.pattern,
    input.targetPath,
  ]
  const child = spawn(rgPath, arguments_, {
    cwd: input.root.path,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = waitForExit(child)
  const items: GrepMatch[] = []
  let stderr = ''
  let limitReached = false
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, GREP_TIMEOUT_MS)
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    if (stderr.length < 8_000) stderr += String(chunk)
  })

  try {
    for await (const line of reader) {
      const match = parseRipgrepMatch(line, input.root.path)
      if (!match) continue
      items.push(match)
      if (items.length >= input.maxResults) {
        limitReached = true
        child.kill()
        break
      }
    }

    const { code, signal } = await exit
    if (timedOut) throw new Error(`Grep exceeded the ${GREP_TIMEOUT_MS}ms timeout`)
    if (!limitReached && code !== 0 && code !== 1) {
      throw new Error(
        `Grep failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}: ${stderr.trim()}`,
      )
    }
    return { items, limitReached }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

function parseRipgrepMatch(line: string, rootPath: string): GrepMatch | undefined {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch (error: unknown) {
    throw new Error('Grep returned malformed JSON output', { cause: error })
  }
  if (!isRecord(event) || event.type !== 'match' || !isRecord(event.data)) return undefined
  const path = textField(event.data.path, 'path')
  const text = textField(event.data.lines, 'lines').replace(/\r?\n$/, '')
  const lineNumber = event.data.line_number
  if (typeof lineNumber !== 'number') throw new Error('Grep result is missing a line number')
  const absolutePath = isAbsolute(path) ? path : resolve(rootPath, path)
  assertInside(rootPath, absolutePath, path)
  return {
    path: toDisplayPath(rootPath, absolutePath),
    line: lineNumber,
    text: text.length > MAX_GREP_LINE_CHARACTERS
      ? `${text.slice(0, MAX_GREP_LINE_CHARACTERS - 1)}…`
      : text,
  }
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal }))
  })
}

async function assertTextFile(path: string, inputPath: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    if (sample.subarray(0, bytesRead).includes(0)) {
      throw new Error(`Read does not support binary files: ${inputPath}`)
    }
  } finally {
    await handle.close()
  }
}

async function existingFileInside(root: ProjectRoot, path: string): Promise<string | undefined> {
  let actualPath: string
  try {
    actualPath = await realpath(path)
  } catch {
    return undefined
  }
  if (!isInside(root.path, actualPath)) return undefined
  try {
    return (await stat(actualPath)).isFile() ? actualPath : undefined
  } catch {
    return undefined
  }
}

function readArguments(
  value: unknown,
  toolName: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${toolName} arguments must be an object`)
  const unknownKey = Object.keys(value).find(key => !allowedKeys.includes(key))
  if (unknownKey) throw new Error(`${toolName} received unknown argument: ${unknownKey}`)
  return value
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${toolName} requires a non-empty ${key}`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function requireRelativePath(value: string): string {
  if (value.includes('\0')) throw new Error('Workspace path must not contain a null byte')
  if (isAbsolute(value)) throw new Error(`Workspace path must be relative: ${value}`)
  if (pathSegments(value).includes('..')) {
    throw new Error(`Workspace path must not contain parent traversal: ${value}`)
  }
  return value.length === 0 ? '.' : value
}

function requireRelativePattern(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  if (value.includes('\0')) throw new Error(`${label} must not contain a null byte`)
  if (isAbsolute(value)) throw new Error(`${label} must be relative`)
  if (pathSegments(value).includes('..')) {
    throw new Error(`${label} must not contain parent traversal`)
  }
  return value
}

function pathSegments(value: string): readonly string[] {
  return value.split(/[\\/]+/)
}

function assertInside(rootPath: string, candidatePath: string, inputPath: string): void {
  if (!isInside(rootPath, candidatePath)) {
    throw new Error(`Workspace path escapes its selected root: ${inputPath}`)
  }
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

function toDisplayPath(rootPath: string, candidatePath: string): string {
  const pathFromRoot = relative(rootPath, candidatePath)
  return (pathFromRoot || '.').split(sep).join('/')
}

function textField(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.text !== 'string') {
    throw new Error(`Grep result is missing ${label} text`)
  }
  return value.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serialize(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
