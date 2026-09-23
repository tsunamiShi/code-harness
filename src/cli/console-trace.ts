import type { AgentEvent } from '../runtime/agent-session.ts'
import type { AgentTraceMode } from './config.ts'

const DEFAULT_MAX_TOOL_RESULT_CHARS = 800
const COLLAPSIBLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP'])
const COMPACT_INLINE_CHARACTERS = 240

export interface ConsoleTraceOptions {
  write: (text: string) => void
  colors?: boolean
  mode?: AgentTraceMode
  maxToolResultChars?: number
  renderMarkdown?: (source: string) => string
}

export interface ConsoleTrace {
  handle: (event: AgentEvent) => void
  getMode: () => AgentTraceMode
  toggleMode: () => AgentTraceMode
}

/** Formats Agent runtime events as a readable terminal execution timeline. */
export function createConsoleTrace(options: ConsoleTraceOptions): ConsoleTrace {
  const color = createColor(options.colors === true)
  let mode = options.mode ?? 'compact'
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  let collapsedTools: ToolCompletedEvent[] = []
  const attempts = new Map<number, { headersMs?: number; firstEventMs?: number }>()

  const flushCollapsedTools = (): void => {
    if (collapsedTools.length === 0) return
    const tools = collapsedTools
    collapsedTools = []
    const counts = new Map<string, number>()
    for (const event of tools) counts.set(event.call.name, (counts.get(event.call.name) ?? 0) + 1)
    const names = [...counts].map(([name, count]) => count === 1 ? name : `${name} ×${count}`)
    const slowest = Math.max(...tools.map(event => event.durationMs))
    const details = tools.length <= 3
      ? ` · ${tools.map(event => compactToolTarget(event)).join(', ')}`
      : ''
    options.write(
      `│  ${color.green('✓')} ${color.bold(`Inspected ${tools.length}`)} · ${names.join(', ')}${details} ${color.dim(`· slowest ${formatDuration(slowest)}`)}`,
    )
  }

  const handle = (event: AgentEvent): void => {
    if (
      event.type === 'turn.started'
      || event.type === 'turn.resumed'
      || event.type === 'step.started'
      || event.type === 'turn.completed'
      || event.type === 'turn.failed'
      || event.type === 'tool.batch-started'
      || event.type === 'loop-guard.reminded'
    ) {
      flushCollapsedTools()
    }
    switch (event.type) {
      case 'turn.started':
        options.write(`\n${color.bold('┌─ Turn started')} ${color.dim(shortId(event.turnId))}`)
        options.write(block('User', event.prompt, color.cyan))
        return
      case 'turn.resumed':
        options.write(
          `\n${color.bold('┌─ Turn resumed')} ${color.dim(`${shortId(event.turnId)} · continuing at step ${event.step}`)}`,
        )
        return
      case 'step.started':
        options.write(
          `\n${color.bold(`├─ Step ${event.step}`)} ${color.dim(`model request · ${event.messageCount} messages · ${event.toolCount} tools`)}`,
        )
        return
      case 'model.attempt': {
        const attempt = event.event
        if (attempt.type === 'started') {
          attempts.set(attempt.attempt, {})
          if (mode === 'verbose') {
            options.write(`│  ${color.yellow('→')} Provider attempt ${attempt.attempt} started`)
          }
          return
        }
        if (attempt.type === 'headers-received') {
          const timing = attempts.get(attempt.attempt) ?? {}
          timing.headersMs = attempt.durationMs
          attempts.set(attempt.attempt, timing)
          if (mode === 'verbose') {
            options.write(
              `│  ${color.green('✓')} Response headers ${color.dim(`HTTP ${attempt.httpStatus} · ${formatDuration(attempt.durationMs)}`)}`,
            )
          }
          return
        }
        if (attempt.type === 'first-event') {
          const timing = attempts.get(attempt.attempt) ?? {}
          timing.firstEventMs = attempt.durationMs
          attempts.set(attempt.attempt, timing)
          if (mode === 'verbose') {
            options.write(
              `│  ${color.green('✓')} First SSE event ${color.dim(`${attempt.eventType} · ${formatDuration(attempt.durationMs)}`)}`,
            )
          }
          return
        }
        if (attempt.type === 'completed') {
          const timing = attempts.get(attempt.attempt)
          attempts.delete(attempt.attempt)
          const latency = mode === 'compact'
            ? [
                timing?.headersMs === undefined ? undefined : `headers ${formatDuration(timing.headersMs)}`,
                timing?.firstEventMs === undefined ? undefined : `first ${formatDuration(timing.firstEventMs)}`,
                `total ${formatDuration(attempt.durationMs)}`,
              ].filter(value => value !== undefined).join(' · ')
            : formatDuration(attempt.durationMs)
          options.write(
            `│  ${color.green('✓')} SSE completed ${color.dim(`${attempt.eventCount} events · ${latency}`)}`,
          )
          return
        }
        attempts.delete(attempt.attempt)
        const cause = attempt.causeCode ?? attempt.causeName
        options.write(
          `│  ${color.red('✗')} Provider attempt ${attempt.attempt} failed ${color.dim(`${attempt.phase} · ${formatDuration(attempt.durationMs)}${cause ? ` · ${cause}` : ''}`)}`,
        )
        return
      }
      case 'model.completed':
        if (mode === 'compact') {
          const decision = event.output.kind === 'final'
            ? 'final answer'
            : `${event.output.calls.length} tool call${event.output.calls.length === 1 ? '' : 's'}`
          options.write(
            `│  ${color.green('✓')} Model responded ${color.dim(`${decision} · ${formatDuration(event.durationMs)}`)}`,
          )
          if (event.output.kind === 'final') {
            options.write(block(
              'Final content',
              options.renderMarkdown?.(event.output.content) ?? event.output.content,
              value => value,
            ))
          } else if (event.output.content !== undefined) {
            options.write(`│  ${color.green('Plan')} ${compactInline(event.output.content)}`)
          }
          return
        }
        options.write(`│  ${color.green('✓')} Model responded ${color.dim(formatDuration(event.durationMs))}`)
        if (event.output.reasoningContent) {
          options.write(block('Provider reasoning', event.output.reasoningContent, color.magenta))
        } else {
          options.write(`│  ${color.dim('Provider reasoning: not returned')}`)
        }
        if (event.output.kind === 'final') {
          options.write(block(
            'Final content',
            options.renderMarkdown?.(event.output.content) ?? event.output.content,
            value => value,
          ))
        } else {
          if (event.output.content !== undefined) {
            options.write(block('Model content', event.output.content, color.green))
          }
          options.write(`│  ${color.cyan('Tool calls')} ${event.output.calls.length}`)
        }
        return
      case 'loop-guard.reminded':
        options.write(
          `│  ${color.yellow('!')} ${color.bold('Loop Guard reminder')} ${color.dim(`${event.summary} · after step ${event.afterStep}`)}`,
        )
        options.write(block('Advice', event.content, color.yellow))
        return
      case 'tool.batch-started':
        if (mode === 'compact') return
        options.write(
          `│  ${event.mode === 'parallel' ? color.yellow('⚡ parallel') : color.yellow('→ serial')} tool batch · ${event.count} call${event.count === 1 ? '' : 's'}`,
        )
        return
      case 'tool.started':
        if (mode === 'compact' && COLLAPSIBLE_TOOLS.has(event.call.name)) return
        if (mode === 'compact') {
          renderCompactToolStarted(options.write, color, event)
        } else {
          renderToolStarted(options.write, color, event)
        }
        return
      case 'tool.completed': {
        if (mode === 'compact' && COLLAPSIBLE_TOOLS.has(event.call.name)) {
          if (!event.failed) {
            collapsedTools.push(event)
            return
          }
          renderCompactToolFailure(options.write, color, event)
          return
        }
        if (mode === 'compact') {
          if (event.failed) {
            renderCompactToolFailure(options.write, color, event)
          } else if (event.call.name !== 'Bash') {
            renderCompactToolCompleted(options.write, color, event)
          }
          return
        }
        renderToolCompleted(options.write, color, event, maxToolResultChars)
        return
      }
      case 'turn.completed':
        options.write(
          `${color.bold('└─ Turn completed')} ${color.dim(`${event.steps} steps · ${formatDuration(event.durationMs)}`)}`,
        )
        return
      case 'turn.failed':
        options.write(`${color.red('└─ Turn failed')} ${color.dim(formatDuration(event.durationMs))}`)
        options.write(block('Error', event.error, color.red))
        return
    }
  }

  return {
    handle,
    getMode: () => mode,
    toggleMode: () => {
      flushCollapsedTools()
      mode = mode === 'compact' ? 'verbose' : 'compact'
      return mode
    },
  }
}

type ToolStartedEvent = Extract<AgentEvent, { type: 'tool.started' }>
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>

function renderToolStarted(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolStartedEvent | ToolCompletedEvent,
): void {
  write(`│  ${color.yellow('▶')} ${color.bold(event.call.name)} ${color.dim(event.call.id)}`)
  write(block('Arguments', formatToolArguments(event.call.name, event.call.arguments), color.cyan))
}

function renderToolCompleted(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolCompletedEvent,
  maxToolResultChars: number,
): void {
  const marker = event.failed ? color.red('✗') : color.green('✓')
  write(
    `│  ${marker} ${color.bold(event.call.name)} ${event.failed ? 'failed' : 'completed'} ${color.dim(formatDuration(event.durationMs))}`,
  )
  write(
    block(
      event.failed ? 'Error' : 'Result',
      formatToolResult(event.call.name, event.content, maxToolResultChars),
      event.failed ? color.red : color.dim,
    ),
  )
}

function renderCompactToolStarted(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolStartedEvent,
): void {
  write(
    `│  ${color.yellow('▶')} ${color.bold(event.call.name)} ${compactToolInvocation(event.call.name, event.call.arguments)}`,
  )
}

function renderCompactToolCompleted(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolCompletedEvent,
): void {
  write(
    `│  ${color.green('✓')} ${color.bold(event.call.name)} completed ${color.dim(formatDuration(event.durationMs))}`,
  )
}

function renderCompactToolFailure(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolCompletedEvent,
): void {
  const target = compactToolInvocation(event.call.name, event.call.arguments)
  const reason = compactFailureReason(event.call.name, event.content)
  write(
    `│  ${color.red('✗')} ${color.bold(event.call.name)} failed ${color.dim(`${formatDuration(event.durationMs)} · ${target}${reason ? ` · ${reason}` : ''}`)}`,
  )
}

function compactToolInvocation(name: string, arguments_: unknown): string {
  const input = isRecord(arguments_) ? arguments_ : {}
  if (name === 'Bash') {
    return compactInline(typeof input.command === 'string' ? input.command : '(command unavailable)')
  }
  const path = typeof input.path === 'string' ? compactPath(input.path) : undefined
  if (name === 'Edit') {
    return [
      path,
      textLength(input.oldText, 'old'),
      textLength(input.newText, 'new'),
    ].filter(value => value !== undefined).join(' · ')
  }
  if (name === 'Write') {
    return [path, textLength(input.content, 'content')]
      .filter(value => value !== undefined).join(' · ')
  }
  if (name === 'Read') return path ?? '(target unavailable)'
  if (name === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
    return [path, pattern].filter(value => value !== undefined).join(' · ') || '(target unavailable)'
  }
  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? `/${input.pattern}/` : undefined
    return [path, pattern].filter(value => value !== undefined).join(' · ') || '(target unavailable)'
  }
  if (name === 'LSP') {
    const operation = typeof input.operation === 'string' ? input.operation : undefined
    return [operation, path].filter(value => value !== undefined).join(' · ') || '(target unavailable)'
  }
  const fields = formatMainFields(input, 3).replaceAll('\n', ' · ')
  return fields.length === 0 ? '(arguments unavailable)' : compactInline(fields)
}

function compactFailureReason(name: string, content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return compactInline(content)
  }
  if (!isRecord(parsed)) return compactInline(formatDisplayValue(parsed))
  if (name === 'Bash') {
    const parts = [
      typeof parsed.exitCode === 'number' ? `exit ${parsed.exitCode}` : undefined,
      parsed.timedOut === true ? 'timed out' : undefined,
      typeof parsed.signal === 'string' ? parsed.signal : undefined,
      typeof parsed.stderr === 'string' && parsed.stderr.trim().length > 0
        ? parsed.stderr
        : typeof parsed.stdout === 'string' ? parsed.stdout : undefined,
    ].filter(value => value !== undefined)
    return compactInline(parts.join(' · '))
  }
  const error = typeof parsed.error === 'string'
    ? parsed.error
    : typeof parsed.message === 'string' ? parsed.message : undefined
  return error === undefined ? '' : compactInline(error)
}

function compactToolTarget(event: ToolCompletedEvent): string {
  const input = isRecord(event.call.arguments) ? event.call.arguments : {}
  const path = typeof input.path === 'string' ? compactPath(input.path) : undefined
  if (event.call.name === 'Read') return path ?? event.call.id
  if (event.call.name === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
    return [path, pattern].filter(value => value !== undefined).join(' · ') || event.call.id
  }
  if (event.call.name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? `/${input.pattern}/` : undefined
    return [path, pattern].filter(value => value !== undefined).join(' · ') || event.call.id
  }
  if (event.call.name === 'LSP') {
    const operation = typeof input.operation === 'string' ? input.operation : undefined
    return [operation, path].filter(value => value !== undefined).join(' · ') || event.call.id
  }
  return event.call.id
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 3) return path
  return `…/${parts.slice(-3).join('/')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function block(label: string, content: string, decorate: (value: string) => string): string {
  const lines = content.length === 0 ? ['(empty)'] : content.split('\n')
  return [`│  ${decorate(label)}`, ...lines.map(line => `│    ${line}`)].join('\n')
}

function formatToolArguments(name: string, value: unknown): string {
  if (!isRecord(value)) return String(value)
  if (name === 'Bash') {
    return formatSelectedFields(value, ['command', 'cwd', 'timeoutMs'])
  }
  if (name === 'Edit') {
    return [
      fieldLine('path', value.path),
      textLength(value.oldText, 'oldText'),
      textLength(value.newText, 'newText'),
    ].filter(line => line !== undefined).join('\n')
  }
  if (name === 'Write') {
    return [fieldLine('path', value.path), textLength(value.content, 'content')]
      .filter(line => line !== undefined).join('\n')
  }
  return formatMainFields(value)
}

function formatToolResult(name: string, content: string, maxChars: number): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return truncate(content, maxChars)
  }
  if (!isRecord(parsed)) return truncate(formatDisplayValue(parsed), maxChars)
  if (name === 'Bash') {
    return truncate(formatSelectedFields(parsed, [
      'exitCode',
      'signal',
      'timedOut',
      'durationMs',
      'stdoutTruncated',
      'stderrTruncated',
      'stdout',
      'stderr',
    ]), maxChars)
  }
  return truncate(formatMainFields(parsed), maxChars)
}

function formatSelectedFields(record: Record<string, unknown>, keys: readonly string[]): string {
  return keys
    .filter(key => record[key] !== undefined && record[key] !== '' && record[key] !== null)
    .map(key => fieldLine(key, record[key]))
    .filter(line => line !== undefined)
    .join('\n')
}

function formatMainFields(record: Record<string, unknown>, limit = 12): string {
  return Object.entries(record)
    .slice(0, limit)
    .map(([key, value]) => fieldLine(key, value))
    .filter(line => line !== undefined)
    .join('\n')
}

function fieldLine(key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  return `${key}: ${formatDisplayValue(value)}`
}

function formatDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) {
    const preview = value.slice(0, 5).map(item => `  - ${formatArrayItem(item)}`)
    const remaining = value.length - preview.length
    return [
      `${value.length} item${value.length === 1 ? '' : 's'}`,
      ...preview,
      ...(remaining > 0 ? [`  - … ${remaining} more`] : []),
    ].join('\n')
  }
  if (isRecord(value)) {
    const scalars = Object.entries(value)
      .filter(([, item]) => typeof item !== 'object' || item === null)
      .map(([key, item]) => `${key}=${String(item)}`)
    return scalars.length === 0 ? 'object' : scalars.join(', ')
  }
  return String(value)
}

function formatArrayItem(value: unknown): string {
  if (!isRecord(value)) return compactInline(formatDisplayValue(value))
  const fields = Object.entries(value)
    .filter(([, item]) => typeof item !== 'object' || item === null)
    .slice(0, 5)
    .map(([key, item]) => `${key}=${compactInline(String(item))}`)
  return fields.length === 0 ? 'object' : fields.join(', ')
}

function textLength(value: unknown, label: string): string | undefined {
  return typeof value === 'string' ? `${label}: ${value.length} chars` : undefined
}

function compactInline(value: string): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= COMPACT_INLINE_CHARACTERS
    ? inline
    : `${inline.slice(0, COMPACT_INLINE_CHARACTERS - 1)}…`
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const headChars = Math.ceil(maxChars * 0.625)
  const tailChars = maxChars - headChars
  const tail = tailChars === 0 ? '' : value.slice(-tailChars)
  return `${value.slice(0, headChars)}\n… ${value.length - maxChars} characters omitted …\n${tail}`
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(2)}s`
}

function createColor(enabled: boolean) {
  const wrap = (code: number) => (value: string) => enabled ? `\u001B[${code}m${value}\u001B[0m` : value
  return {
    bold: wrap(1),
    dim: wrap(2),
    red: wrap(31),
    green: wrap(32),
    yellow: wrap(33),
    cyan: wrap(36),
    magenta: wrap(35),
  }
}
