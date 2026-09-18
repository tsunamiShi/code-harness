import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { glob, link, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { rgPath } from '@vscode/ripgrep'

import {
  primaryRoot,
  type AgentProject,
  type ProjectRoot,
  type WorkspaceAccessMode,
} from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'

const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 1_000
const MAX_READ_CHARACTERS = 64_000
const MAX_EDIT_FILE_BYTES = 2_000_000
const MAX_EDIT_TEXT_CHARACTERS = 64_000
const MAX_WRITE_CHARACTERS = 64_000
const DEFAULT_GLOB_RESULTS = 200
const MAX_GLOB_RESULTS = 2_000
const MAX_GLOB_CANDIDATES = 10_000
const DEFAULT_GREP_RESULTS = 100
const MAX_GREP_RESULTS = 500
const GREP_TIMEOUT_MS = 10_000
const MAX_GREP_LINE_CHARACTERS = 1_000
const BINARY_SAMPLE_BYTES = 8_192
const DEFAULT_EXCLUDES = ['.git/**', 'node_modules/**', 'dist/**'] as const

/** Creates the filesystem tool set for one Project. */
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
      parallelSafe: false,
      description: {
        name: 'Edit',
        description:
          `Replace exactly one occurrence of oldText in an existing UTF-8 file inside ${scope}. Read the target context first.`,
        parameters: {
          type: 'object',
          properties: {
            root: rootProperty,
            path: {
              type: 'string',
              description: 'Existing file path relative to the selected Workspace Root.',
            },
            oldText: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_EDIT_TEXT_CHARACTERS,
              description: 'Exact existing text to replace. It must occur exactly once in the file.',
            },
            newText: {
              type: 'string',
              maxLength: MAX_EDIT_TEXT_CHARACTERS,
              description: 'Replacement text. Use an empty string to delete oldText.',
            },
          },
          required: ['path', 'oldText', 'newText'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Edit', ['root', 'path', 'oldText', 'newText'])
        const oldText = requiredString(input, 'oldText', 'Edit')
        const newText = requiredText(input, 'newText', 'Edit')
        assertMaximumCharacters(oldText, 'Edit oldText', MAX_EDIT_TEXT_CHARACTERS)
        assertMaximumCharacters(newText, 'Edit newText', MAX_EDIT_TEXT_CHARACTERS)
        return serialize(
          await workspace.edit({
            root: optionalString(input, 'root'),
            path: requiredString(input, 'path', 'Edit'),
            oldText,
            newText,
          }),
        )
      },
    },
    {
      parallelSafe: false,
      description: {
        name: 'Write',
        description:
          `Create a new UTF-8 file inside ${scope}. The parent directory must already exist, and an existing path is never overwritten.`,
        parameters: {
          type: 'object',
          properties: {
            root: rootProperty,
            path: {
              type: 'string',
              description: 'New file path relative to the selected Workspace Root.',
            },
            content: {
              type: 'string',
              maxLength: MAX_WRITE_CHARACTERS,
              description: 'Complete UTF-8 content for the new file. An empty string creates an empty file.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Write', ['root', 'path', 'content'])
        const content = requiredText(input, 'content', 'Write')
        assertMaximumCharacters(content, 'Write content', MAX_WRITE_CHARACTERS)
        return serialize(
          await workspace.write({
            root: optionalString(input, 'root'),
            path: requiredString(input, 'path', 'Write'),
            content,
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

interface EditInput {
  root: string | undefined
  path: string
  oldText: string
  newText: string
}

interface WriteInput {
  root: string | undefined
  path: string
  content: string
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
  constructor(
    private readonly project: AgentProject,
    private readonly accessMode: WorkspaceAccessMode,
  ) {}

  rootProperty(): Record<string, unknown> {
    return workspaceRootProperty(this.project, this.accessMode)
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

  async edit(input: EditInput): Promise<Record<string, unknown>> {
    if (input.oldText === input.newText) {
      throw new Error('Edit oldText and newText must be different')
    }
    const root = await this.selectRoot(input.root)
    const target = await this.resolveExisting(root, input.path, 'file')
    const details = await stat(target.actualPath)
    if (details.size > MAX_EDIT_FILE_BYTES) {
      throw new Error(`Edit file exceeds the ${MAX_EDIT_FILE_BYTES}-byte limit: ${input.path}`)
    }
    await assertTextFile(target.actualPath, input.path)

    const before = await readFile(target.actualPath, 'utf8')
    const firstMatch = before.indexOf(input.oldText)
    if (firstMatch === -1) {
      throw new Error(`Edit oldText was not found in ${input.path}; read the latest file content and retry`)
    }
    if (before.indexOf(input.oldText, firstMatch + input.oldText.length) !== -1) {
      throw new Error(`Edit oldText occurs more than once in ${input.path}; provide more surrounding context`)
    }

    const after = `${before.slice(0, firstMatch)}${input.newText}${before.slice(firstMatch + input.oldText.length)}`
    const temporaryPath = `${target.actualPath}.ai-agent-${randomUUID()}.tmp`
    let renamed = false
    try {
      await writeFile(temporaryPath, after, { encoding: 'utf8', mode: details.mode })
      if (await readFile(target.actualPath, 'utf8') !== before) {
        throw new Error(`Edit target changed while preparing the write: ${input.path}`)
      }
      await rename(temporaryPath, target.actualPath)
      renamed = true
    } finally {
      if (!renamed) await rm(temporaryPath, { force: true })
    }

    return {
      root: root.path,
      path: target.displayPath,
      changedRange: {
        startLine: lineNumberAt(before, firstMatch),
        oldLines: lineCount(input.oldText),
        newLines: lineCount(input.newText),
      },
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    }
  }

  async write(input: WriteInput): Promise<Record<string, unknown>> {
    const root = await this.selectRoot(input.root)
    const target = await this.resolveNewFile(root, input.path)
    const temporaryPath = resolve(target.parentPath, `.ai-agent-write-${randomUUID()}.tmp`)
    let targetCreated = false

    try {
      await writeFile(temporaryPath, input.content, { encoding: 'utf8', flag: 'wx' })
      try {
        await link(temporaryPath, target.actualPath)
        targetCreated = true
      } catch (error: unknown) {
        if (hasErrorCode(error, 'EEXIST')) {
          throw new Error(`Write target already exists: ${input.path}; use Edit to modify existing files`)
        }
        throw error
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }

    if (!targetCreated) throw new Error(`Write failed to create target: ${input.path}`)
    return {
      root: root.path,
      path: target.displayPath,
      characters: input.content.length,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      sha256: sha256(input.content),
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
    return await selectWorkspaceRoot(this.project, this.accessMode, value)
  }

  private async resolveExisting(
    root: ProjectRoot,
    inputPath: string,
    expected: 'file' | 'directory' | 'file-or-directory',
  ): Promise<{ actualPath: string; displayPath: string }> {
    return await resolveExistingWorkspacePath(root, inputPath, expected)
  }

  private async resolveNewFile(
    root: ProjectRoot,
    inputPath: string,
  ): Promise<{ actualPath: string; displayPath: string; parentPath: string }> {
    const relativePath = requireRelativePath(inputPath)
    const lexicalPath = resolve(root.path, relativePath)
    assertInside(root.path, lexicalPath, inputPath)

    const lexicalParent = dirname(lexicalPath)
    let parentPath: string
    try {
      parentPath = await realpath(lexicalParent)
    } catch (error: unknown) {
      throw new Error(`Write parent directory does not exist: ${toDisplayPath(root.path, lexicalParent)}`, {
        cause: error,
      })
    }
    assertInside(root.path, parentPath, inputPath)
    if (!(await stat(parentPath)).isDirectory()) {
      throw new Error(`Write parent path is not a directory: ${toDisplayPath(root.path, lexicalParent)}`)
    }

    const actualPath = resolve(parentPath, basename(lexicalPath))
    assertInside(root.path, actualPath, inputPath)
    return {
      actualPath,
      displayPath: toDisplayPath(root.path, lexicalPath),
      parentPath,
    }
  }
}

/** Describes the model-facing root selector for the current access mode. */
export function workspaceRootProperty(
  project: AgentProject,
  accessMode: WorkspaceAccessMode,
): Record<string, unknown> {
  if (accessMode === 'full') {
    return {
      type: 'string',
      description:
        'Absolute local directory to use as the root. Omit or use primary for the Primary Root.',
    }
  }
  return {
    type: 'string',
    enum: ['primary', ...project.roots.map(root => root.path)],
    description:
      'Workspace Root to use. Omit or use primary for the Primary Root; attached roots use their absolute path from the Project context.',
  }
}

/** Resolves a model-selected root under scoped or full filesystem access. */
export async function selectWorkspaceRoot(
  project: AgentProject,
  accessMode: WorkspaceAccessMode,
  value: string | undefined,
): Promise<ProjectRoot> {
  const primary = primaryRoot(project)
  if (value === undefined || value === 'primary') return primary
  const root = project.roots.find(candidate => candidate.path === value)
  if (root) return root
  if (accessMode === 'scoped') throw new Error(`Unknown Workspace Root: ${value}`)
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

/** Resolves and validates an existing path without following it outside the selected root. */
export async function resolveExistingWorkspacePath(
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

function requiredText(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`${toolName} requires a string ${key}`)
  return value
}

function assertMaximumCharacters(value: string, label: string, maximum: number): void {
  if (value.length > maximum) throw new Error(`${label} exceeds the ${maximum}-character limit`)
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

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function serialize(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
