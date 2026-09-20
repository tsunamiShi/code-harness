import { spawn, type ChildProcess } from 'node:child_process'

import type { AgentProject, FilesystemAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import { resolveAuthorizedExistingPath } from './filesystem-tools.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_COMMAND_CHARACTERS = 16_000
const MAX_OUTPUT_CHARACTERS = 64_000

/** Creates a full-access shell Tool; scoped execution requires an OS sandbox first. */
export function createBashTool(
  project: AgentProject,
  accessMode: FilesystemAccessMode,
): Tool {
  if (accessMode !== 'full') {
    throw new Error('Bash requires full filesystem access because no OS sandbox is configured')
  }

  return {
    parallelSafe: false,
    description: {
      name: 'Bash',
      description:
        'Run one Bash command with full host-process authority. Use it for builds, tests, Git inspection, and commands not covered by structured Tools. Non-zero exits are returned as results.',
      parameters: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description: 'Absolute working directory for the command.',
          },
          command: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_COMMAND_CHARACTERS,
            description: 'Command string passed to Bash with -lc.',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description: `Execution timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['cwd', 'command'],
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      const input = readArguments(arguments_)
      const command = requiredString(input, 'command')
      if (command.length > MAX_COMMAND_CHARACTERS) {
        throw new Error(`Bash command exceeds the ${MAX_COMMAND_CHARACTERS}-character limit`)
      }
      const workingDirectory = await resolveAuthorizedExistingPath(
        project,
        accessMode,
        requiredString(input, 'cwd'),
        'directory',
      )
      const timeoutMs = optionalInteger(input, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS
      return JSON.stringify(await runBash({
        command,
        cwd: workingDirectory.actualPath,
        timeoutMs,
      }))
    },
  }
}

interface RunBashInput {
  command: string
  cwd: string
  timeoutMs: number
}

async function runBash(input: RunBashInput): Promise<Record<string, unknown>> {
  if (process.platform === 'win32') {
    throw new Error('Bash is unavailable on Windows; add a PowerShell Tool for native execution')
  }
  const startedAt = performance.now()
  const child = spawn('/bin/bash', ['-lc', input.command], {
    cwd: input.cwd,
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = boundedOutput()
  const stderr = boundedOutput()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', stdout.append)
  child.stderr.on('data', stderr.append)

  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(child, 'SIGTERM')
    forceKill = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 250)
  }, input.timeoutMs)

  try {
    const { code, signal } = await waitForExit(child)
    return {
      cwd: input.cwd,
      command: input.command,
      exitCode: code,
      signal,
      timedOut,
      durationMs: Math.round(performance.now() - startedAt),
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
    }
  } finally {
    clearTimeout(timeout)
    if (forceKill !== undefined) clearTimeout(forceKill)
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessGroup(child, 'SIGKILL')
    }
  }
}

function boundedOutput(): {
  append: (chunk: string) => void
  value: () => string
  truncated: () => boolean
} {
  let content = ''
  let wasTruncated = false
  return {
    append(chunk) {
      const remaining = MAX_OUTPUT_CHARACTERS - content.length
      if (chunk.length > remaining) wasTruncated = true
      if (remaining > 0) content += chunk.slice(0, remaining)
    },
    value: () => content,
    truncated: () => wasTruncated,
  }
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ESRCH')) throw error
  }
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal }))
  })
}

function readArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Bash arguments must be an object')
  const unknown = Object.keys(value).find(key => !['cwd', 'command', 'timeoutMs'].includes(key))
  if (unknown) throw new Error(`Bash received unknown argument: ${unknown}`)
  return value
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Bash requires a non-empty ${key}`)
  }
  return value
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`Bash ${key} must be an integer from 1 through ${MAX_TIMEOUT_MS}`)
  }
  return value
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
