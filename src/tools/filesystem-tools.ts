import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { glob, link, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { rgPath } from '@vscode/ripgrep'

import {
  type AgentProject,
  type FilesystemAccessMode,
} from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'

const DEFAULT_READ_LINES = 500
const MAX_READ_LINES = 2_000
const MAX_READ_CHARACTERS = 64_000
const MAX_READ_TOTAL_LINES_BYTES = 16_000_000
const MAX_EDIT_FILE_BYTES = 2_000_000
const MAX_EDIT_TEXT_CHARACTERS = 64_000
const MAX_WRITE_CHARACTERS = 64_000
const DEFAULT_GLOB_RESULTS = 200
const MAX_GLOB_RESULTS = 2_000
const MAX_GLOB_CANDIDATES = 10_000
const DEFAULT_GREP_RESULTS = 100
const MAX_GREP_RESULTS = 500
const MAX_GREP_CONTEXT_LINES = 50
const GREP_TIMEOUT_MS = 10_000
const MAX_GREP_LINE_CHARACTERS = 1_000
const BINARY_SAMPLE_BYTES = 8_192
const DEFAULT_EXCLUDES = ['.git/**', 'node_modules/**', 'dist/**'] as const

/** Creates the filesystem tool set for one Project. */
export function createFilesystemTools(
  project: AgentProject,
  accessMode: FilesystemAccessMode = 'scoped',
): readonly Tool[] {
  const filesystem = new ProjectFilesystem(project, accessMode)
  const scope = accessMode === 'full' ? 'the local filesystem' : 'the Project roots'

  return [
    {
      effect: 'observe',
      parallelSafe: true,
      description: {
        name: 'Read',
        description:
          `Read UTF-8 text from an absolute file path inside ${scope}. Results report the file's total line count, so the remaining range can be requested in one follow-up call instead of paging blindly.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute file path. Reuse paths returned by Glob, Grep, or LSP.',
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
              description: `Maximum lines to return. Defaults to ${DEFAULT_READ_LINES}; request the full remaining range in one call.`,
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Read', ['path', 'offset', 'limit'])
        return serialize(
          await filesystem.read({
            path: requiredString(input, 'path', 'Read'),
            offset: optionalInteger(input, 'offset', 1, Number.MAX_SAFE_INTEGER) ?? 1,
            limit: optionalInteger(input, 'limit', 1, MAX_READ_LINES) ?? DEFAULT_READ_LINES,
          }),
        )
      },
    },
    {
      effect: 'mutate',
      parallelSafe: false,
      description: {
        name: 'Edit',
        description:
          `Replace exactly one occurrence of oldText in an existing UTF-8 file inside ${scope}. Read the target context first.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path of the existing file. Read the same path before editing.',
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
        const input = readArguments(arguments_, 'Edit', ['path', 'oldText', 'newText'])
        const oldText = requiredString(input, 'oldText', 'Edit')
        const newText = requiredText(input, 'newText', 'Edit')
        assertMaximumCharacters(oldText, 'Edit oldText', MAX_EDIT_TEXT_CHARACTERS)
        assertMaximumCharacters(newText, 'Edit newText', MAX_EDIT_TEXT_CHARACTERS)
        return serialize(
          await filesystem.edit({
            path: requiredString(input, 'path', 'Edit'),
            oldText,
            newText,
          }),
        )
      },
    },
    {
      effect: 'mutate',
      parallelSafe: false,
      description: {
        name: 'Write',
        description:
          `Create a new UTF-8 file inside ${scope}. The parent directory must already exist, and an existing path is never overwritten.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path of the new file.',
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
        const input = readArguments(arguments_, 'Write', ['path', 'content'])
        const content = requiredText(input, 'content', 'Write')
        assertMaximumCharacters(content, 'Write content', MAX_WRITE_CHARACTERS)
        return serialize(
          await filesystem.write({
            path: requiredString(input, 'path', 'Write'),
            content,
          }),
        )
      },
    },
    {
      effect: 'observe',
      parallelSafe: true,
      description: {
        name: 'Glob',
        description:
          `Find files by a glob pattern below an absolute directory path inside ${scope}. Results are absolute paths; set includeDirectories to also list matching directories, so pattern * lists one directory level instead of Bash ls.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern such as src/**/*.ts.',
            },
            path: {
              type: 'string',
              description: 'Absolute directory path in which to search.',
            },
            includeDirectories: {
              type: 'boolean',
              description: 'Also return directories matching the pattern. Defaults to false.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GLOB_RESULTS,
              description: `Maximum files to return. Defaults to ${DEFAULT_GLOB_RESULTS}.`,
            },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Glob', ['pattern', 'path', 'includeDirectories', 'limit'])
        return serialize(
          await filesystem.glob({
            pattern: requiredString(input, 'pattern', 'Glob'),
            path: requiredString(input, 'path', 'Glob'),
            includeDirectories: optionalBoolean(input, 'includeDirectories') ?? false,
            limit:
              optionalInteger(input, 'limit', 1, MAX_GLOB_RESULTS) ?? DEFAULT_GLOB_RESULTS,
          }),
        )
      },
    },
    {
      effect: 'observe',
      parallelSafe: true,
      description: {
        name: 'Grep',
        description:
          `Search UTF-8 text files with a regular expression inside ${scope}. Each result line is either a matching line or a surrounding context line, identified by kind.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Rust regular expression accepted by ripgrep.',
            },
            path: {
              type: 'string',
              description: 'Absolute file or directory path to search.',
            },
            glob: {
              type: 'string',
              description: 'Optional file filter such as **/*.ts.',
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Whether matching is case-sensitive. Defaults to true.',
            },
            before: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GREP_CONTEXT_LINES,
              description: 'Number of context lines to return before each matching line. Defaults to 0.',
            },
            after: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GREP_CONTEXT_LINES,
              description: 'Number of context lines to return after each matching line. Defaults to 0.',
            },
            maxResults: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_GREP_RESULTS,
              description: `Maximum matching lines to return; context lines do not count. Defaults to ${DEFAULT_GREP_RESULTS}.`,
            },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const input = readArguments(arguments_, 'Grep', [
          'pattern',
          'path',
          'glob',
          'caseSensitive',
          'before',
          'after',
          'maxResults',
        ])
        return serialize(
          await filesystem.grep({
            pattern: requiredString(input, 'pattern', 'Grep'),
            path: requiredString(input, 'path', 'Grep'),
            glob: optionalString(input, 'glob'),
            caseSensitive: optionalBoolean(input, 'caseSensitive') ?? true,
            before: optionalInteger(input, 'before', 1, MAX_GREP_CONTEXT_LINES) ?? 0,
            after: optionalInteger(input, 'after', 1, MAX_GREP_CONTEXT_LINES) ?? 0,
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
  path: string
  offset: number
  limit: number
}

interface EditInput {
  path: string
  oldText: string
  newText: string
}

interface WriteInput {
  path: string
  content: string
}

interface GlobInput {
  pattern: string
  path: string
  includeDirectories: boolean
  limit: number
}

interface GrepInput {
  pattern: string
  path: string
  glob: string | undefined
  caseSensitive: boolean
  before: number
  after: number
  maxResults: number
}

class ProjectFilesystem {
  constructor(
    private readonly project: AgentProject,
    private readonly accessMode: FilesystemAccessMode,
  ) {}

  async read(input: ReadInput): Promise<Record<string, unknown>> {
    const target = await this.resolveExisting(input.path, 'file')
    await assertTextFile(target.actualPath, input.path)
    const { size } = await stat(target.actualPath)
    const countTotalLines = size <= MAX_READ_TOTAL_LINES_BYTES

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
      if (lines.length >= input.limit || characters >= MAX_READ_CHARACTERS) {
        truncated = true
        if (!countTotalLines) break
        continue
      }
      const remaining = MAX_READ_CHARACTERS - characters
      const visible = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text
      lines.push({ line: lineNumber, text: visible })
      characters += visible.length
      if (visible.length !== text.length) truncated = true
    }

    const result: Record<string, unknown> = {
      path: target.actualPath,
      lines,
      truncated,
    }
    if (countTotalLines) result.totalLines = lineNumber
    return result
  }

  async edit(input: EditInput): Promise<Record<string, unknown>> {
    if (input.oldText === input.newText) {
      throw new Error('Edit oldText and newText must be different')
    }
    const target = await this.resolveExisting(input.path, 'file')
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
    const temporaryPath = `${target.actualPath}.code-harness-${randomUUID()}.tmp`
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
      path: target.actualPath,
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
    const target = await this.resolveNewFile(input.path)
    const temporaryPath = resolve(target.parentPath, `.code-harness-write-${randomUUID()}.tmp`)
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
      path: target.actualPath,
      characters: input.content.length,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      sha256: sha256(input.content),
    }
  }

  async glob(input: GlobInput): Promise<Record<string, unknown>> {
    const pattern = requireRelativePattern(input.pattern, 'Glob pattern')
    const base = await this.resolveExisting(input.path, 'directory')
    const files: string[] = []
    const directories: string[] = []
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
        const candidate = await existingAuthorizedEntry(
          this.project,
          this.accessMode,
          resolve(base.actualPath, match),
        )
        if (!candidate) continue
        if (candidate.isFile) files.push(candidate.actualPath)
        else if (input.includeDirectories) directories.push(candidate.actualPath)
      }
    } catch (error: unknown) {
      throw new Error(`Glob failed for pattern ${JSON.stringify(input.pattern)}: ${errorMessage(error)}`)
    }

    const uniqueFiles = [...new Set(files)].sort()
    const uniqueDirectories = [...new Set(directories)].sort()
    const result: Record<string, unknown> = {
      path: base.actualPath,
      pattern: input.pattern,
      files: uniqueFiles.slice(0, input.limit),
      truncated: scanLimitReached
        || uniqueFiles.length > input.limit
        || (input.includeDirectories && uniqueDirectories.length > input.limit),
    }
    if (input.includeDirectories) {
      result.directories = uniqueDirectories.slice(0, input.limit)
    }
    return result
  }

  async grep(input: GrepInput): Promise<Record<string, unknown>> {
    if (input.pattern.length === 0) throw new Error('Grep pattern must not be empty')
    const target = await this.resolveExisting(input.path, 'file-or-directory')
    const fileGlob = input.glob === undefined
      ? undefined
      : requireRelativePattern(input.glob, 'Grep glob')
    const matches = await runRipgrep({
      cwd: target.details.isDirectory() ? target.actualPath : dirname(target.actualPath),
      targetPath: target.actualPath,
      pattern: input.pattern,
      fileGlob,
      caseSensitive: input.caseSensitive,
      before: input.before,
      after: input.after,
      maxResults: input.maxResults,
    })
    return {
      path: target.actualPath,
      pattern: input.pattern,
      matches: matches.items,
      limitReached: matches.limitReached,
    }
  }

  private async resolveExisting(
    inputPath: string,
    expected: 'file' | 'directory' | 'file-or-directory',
  ): Promise<AuthorizedExistingPath> {
    return await resolveAuthorizedExistingPath(this.project, this.accessMode, inputPath, expected)
  }

  private async resolveNewFile(
    inputPath: string,
  ): Promise<{ actualPath: string; parentPath: string }> {
    const absolutePath = requireAbsolutePath(inputPath)
    const lexicalParent = dirname(absolutePath)
    let parentPath: string
    try {
      parentPath = await realpath(lexicalParent)
    } catch (error: unknown) {
      throw new Error(`Write parent directory does not exist: ${lexicalParent}`, {
        cause: error,
      })
    }
    authorizePath(this.project, this.accessMode, parentPath, inputPath)
    if (!(await stat(parentPath)).isDirectory()) {
      throw new Error(`Write parent path is not a directory: ${lexicalParent}`)
    }

    const actualPath = resolve(parentPath, basename(absolutePath))
    authorizePath(this.project, this.accessMode, actualPath, inputPath)
    return {
      actualPath,
      parentPath,
    }
  }
}

export interface AuthorizedExistingPath {
  actualPath: string
  details: Awaited<ReturnType<typeof stat>>
}

/** Resolves an absolute existing path and applies the current Project access mode. */
export async function resolveAuthorizedExistingPath(
  project: AgentProject,
  accessMode: FilesystemAccessMode,
  inputPath: string,
  expected: 'file' | 'directory' | 'file-or-directory',
): Promise<AuthorizedExistingPath> {
  const absolutePath = requireAbsolutePath(inputPath)
  let actualPath: string
  try {
    actualPath = await realpath(absolutePath)
  } catch (error: unknown) {
    throw new Error(`Project path does not exist: ${inputPath}`, { cause: error })
  }
  authorizePath(project, accessMode, actualPath, inputPath)

  const details = await stat(actualPath)
  if (expected === 'file' && !details.isFile()) {
    throw new Error(`Project path is not a file: ${inputPath}`)
  }
  if (expected === 'directory' && !details.isDirectory()) {
    throw new Error(`Project path is not a directory: ${inputPath}`)
  }
  if (expected === 'file-or-directory' && !details.isFile() && !details.isDirectory()) {
    throw new Error(`Project path is not a file or directory: ${inputPath}`)
  }
  return { actualPath, details }
}

interface RipgrepInput {
  cwd: string
  targetPath: string
  pattern: string
  fileGlob: string | undefined
  caseSensitive: boolean
  before: number
  after: number
  maxResults: number
}

interface GrepResultLine {
  path: string
  line: number
  text: string
  kind: 'match' | 'context'
}

async function runRipgrep(
  input: RipgrepInput,
): Promise<{ items: GrepResultLine[]; limitReached: boolean }> {
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
    ...(input.before > 0 ? ['--before-context', String(input.before)] : []),
    ...(input.after > 0 ? ['--after-context', String(input.after)] : []),
    '--',
    input.pattern,
    input.targetPath,
  ]
  const child = spawn(rgPath, arguments_, {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = waitForExit(child)
  const items: GrepResultLine[] = []
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
    let matchCount = 0
    let previousKey: string | undefined
    for await (const line of reader) {
      const event = parseRipgrepEvent(line, input.cwd)
      if (!event) continue
      if (event.type === 'file-start') {
        if (limitReached) {
          child.kill()
          break
        }
        continue
      }
      const result = event.line
      const key = `${result.path}:${result.line}`
      if (key === previousKey) continue
      previousKey = key
      if (result.kind === 'match' && limitReached) {
        child.kill()
        break
      }
      items.push(result)
      if (result.kind === 'match') {
        matchCount += 1
        if (matchCount >= input.maxResults) limitReached = true
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

type RipgrepEvent = { type: 'file-start' } | { type: 'result'; line: GrepResultLine }

function parseRipgrepEvent(line: string, rootPath: string): RipgrepEvent | undefined {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch (error: unknown) {
    throw new Error('Grep returned malformed JSON output', { cause: error })
  }
  if (
    !isRecord(event)
    || (event.type !== 'match' && event.type !== 'context' && event.type !== 'begin')
    || !isRecord(event.data)
  ) return undefined
  if (event.type === 'begin') return { type: 'file-start' }
  const path = textField(event.data.path, 'path')
  const text = textField(event.data.lines, 'lines').replace(/\r?\n$/, '')
  const lineNumber = event.data.line_number
  if (typeof lineNumber !== 'number') throw new Error('Grep result is missing a line number')
  const absolutePath = isAbsolute(path) ? path : resolve(rootPath, path)
  assertInside(rootPath, absolutePath, path)
  return {
    type: 'result',
    line: {
      path: absolutePath,
      line: lineNumber,
      text: text.length > MAX_GREP_LINE_CHARACTERS
        ? `${text.slice(0, MAX_GREP_LINE_CHARACTERS - 1)}…`
        : text,
      kind: event.type,
    },
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

async function existingAuthorizedEntry(
  project: AgentProject,
  accessMode: FilesystemAccessMode,
  path: string,
): Promise<{ actualPath: string; isFile: boolean } | undefined> {
  let actualPath: string
  try {
    actualPath = await realpath(path)
  } catch {
    return undefined
  }
  try {
    authorizePath(project, accessMode, actualPath, path)
  } catch {
    return undefined
  }
  try {
    const details = await stat(actualPath)
    if (!details.isFile() && !details.isDirectory()) return undefined
    return { actualPath, isFile: details.isFile() }
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

function requireAbsolutePath(value: string): string {
  if (value.includes('\0')) throw new Error('Project path must not contain a null byte')
  if (!isAbsolute(value)) throw new Error(`Project path must be absolute: ${value}`)
  return resolve(value)
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
    throw new Error(`Path escapes its search directory: ${inputPath}`)
  }
}

function authorizePath(
  project: AgentProject,
  accessMode: FilesystemAccessMode,
  candidatePath: string,
  inputPath: string,
): void {
  if (accessMode === 'full') return
  if (project.roots.some(root => isInside(root.path, candidatePath))) return
  throw new Error(`Path is outside the Project roots: ${inputPath}`)
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
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
