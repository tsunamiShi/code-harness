import type { AgentEvent } from '../runtime/agent-session.ts'
import { createColor, type TraceColor } from './colors.ts'
import type { AgentTraceMode } from './config.ts'

const DEFAULT_MAX_TOOL_RESULT_CHARS = 800
const COLLAPSIBLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch'])
const COMPACT_INLINE_CHARACTERS = 240

export interface ConsoleTraceOptions {
  write: (text: string) => void
  writeFragment?: (text: string) => void
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
  const writeFragment = options.writeFragment ?? options.write
  const renderedStreams = new Set<string>()
  let activeStreamKey: string | undefined

  const finishActiveStream = (): void => {
    if (activeStreamKey === undefined) return
    writeFragment('\n')
    activeStreamKey = undefined
  }

  const renderDelta = (event: ModelDeltaEvent): void => {
    const key = `${event.turnId}:${event.step}:${event.event.type}`
    if (activeStreamKey !== key) {
      finishActiveStream()
      const reasoning = event.event.type === 'reasoning'
      const label = reasoning ? 'Provider reasoning' : 'Final content'
      writeFragment(`${color.dim('│')}  ${reasoning ? color.magenta(label) : color.boldCyan(label)}\n${color.dim('│')}    `)
      activeStreamKey = key
      renderedStreams.add(key)
    }
    const delta = event.event.type === 'reasoning' ? color.magenta(event.event.delta) : event.event.delta
    writeFragment(delta.replaceAll('\n', `\n${color.dim('│')}    `))
  }

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
      `${color.dim('│')}  ${color.green('✓')} ${color.boldCyan(`Inspected ${tools.length}`)} ${color.dim(`· ${names.join(', ')}${details} · slowest ${formatDuration(slowest)}`)}`,
    )
  }

  const handle = (event: AgentEvent): void => {
    if (event.type === 'model.delta') {
      renderDelta(event)
      return
    }
    finishActiveStream()
    if (
      event.type === 'turn.started'
      || event.type === 'turn.resumed'
      || event.type === 'step.started'
      || event.type === 'turn.completed'
      || event.type === 'turn.failed'
      || event.type === 'tool.batch-started'
      || event.type === 'loop-guard.reminded'
      || event.type.startsWith('context.compaction-')
    ) {
      flushCollapsedTools()
    }
    switch (event.type) {
      case 'turn.started':
        options.write(`\n${color.boldCyan('┌─ Turn started')} ${color.dim(shortId(event.turnId))}`)
        options.write(block('User', event.prompt, color.cyan, color))
        return
      case 'turn.resumed':
        options.write(
          `\n${color.boldCyan('┌─ Turn resumed')} ${color.dim(`${shortId(event.turnId)} · continuing at step ${event.step}`)}`,
        )
        return
      case 'context.compaction-started':
        options.write(
          `${color.dim('│')}  ${color.yellow('→')} ${color.boldCyan('Context compaction')} ${color.dim(`${event.trigger} · ${event.estimatedTokensBefore} estimated tokens`)}`,
        )
        return
      case 'context.compaction-completed':
        options.write(
          `${color.dim('│')}  ${color.green('✓')} ${color.boldGreen(`Context checkpoint ${event.checkpointNumber}`)} ${color.dim(`${event.estimatedTokensBefore} → ${event.estimatedTokensAfter} estimated tokens`)}`,
        )
        return
      case 'context.compaction-failed':
        options.write(
          `${color.dim('│')}  ${color.red('✗')} ${color.boldRed('Context compaction failed')} ${color.dim(`${event.trigger} · ${event.error}`)}`,
        )
        return
      case 'step.started':
        options.write(
          `\n${color.dim('├─')} ${color.boldCyan(`Step ${event.step}`)} ${color.dim(`model request · ${event.messageCount} messages · ${event.toolCount} tools`)}`,
        )
        return
      case 'model.attempt': {
        const attempt = event.event
        if (attempt.type === 'started') {
          attempts.set(attempt.attempt, {})
          if (mode === 'verbose') {
            options.write(`${color.dim('│')}  ${color.yellow('→')} Provider attempt ${attempt.attempt} started`)
          }
          return
        }
        if (attempt.type === 'headers-received') {
          const timing = attempts.get(attempt.attempt) ?? {}
          timing.headersMs = attempt.durationMs
          attempts.set(attempt.attempt, timing)
          if (mode === 'verbose') {
            options.write(
              `${color.dim('│')}  ${color.green('✓')} Response headers ${color.dim(`HTTP ${attempt.httpStatus} · ${formatDuration(attempt.durationMs)}`)}`,
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
              `${color.dim('│')}  ${color.green('✓')} First SSE event ${color.dim(`${attempt.eventType} · ${formatDuration(attempt.durationMs)}`)}`,
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
            `${color.dim('│')}  ${color.green('✓')} SSE completed ${color.dim(`${attempt.eventCount} events · ${latency}`)}`,
          )
          return
        }
        attempts.delete(attempt.attempt)
        const cause = attempt.causeCode ?? attempt.causeName
        options.write(
          `${color.dim('│')}  ${color.red('✗')} ${color.boldRed(`Provider attempt ${attempt.attempt} failed`)} ${color.dim(`${attempt.phase} · ${formatDuration(attempt.durationMs)}${cause ? ` · ${cause}` : ''}`)}`,
        )
        return
      }
      case 'model.completed':
        const streamedReasoning = renderedStreams.delete(
          `${event.turnId}:${event.step}:reasoning`,
        )
        const streamedOutput = renderedStreams.delete(
          `${event.turnId}:${event.step}:output-text`,
        )
        if (mode === 'compact') {
          const decision = event.output.kind === 'final'
            ? 'final answer'
            : `${event.output.calls.length} tool call${event.output.calls.length === 1 ? '' : 's'}`
          options.write(
            `${color.dim('│')}  ${color.green('✓')} Model responded ${color.dim(`${decision} · ${formatDuration(event.durationMs)}`)}`,
          )
          if (event.output.kind === 'final' && !streamedOutput) {
            options.write(block(
              'Final content',
              options.renderMarkdown?.(event.output.content) ?? event.output.content,
              value => value,
              color,
            ))
          } else if (event.output.kind === 'tool-calls' && event.output.content !== undefined && !streamedOutput) {
            options.write(`${color.dim('│')}  ${color.boldCyan('Plan')} ${color.italic(compactInline(event.output.content))}`)
          }
          return
        }
        options.write(`${color.dim('│')}  ${color.green('✓')} Model responded ${color.dim(formatDuration(event.durationMs))}`)
        if (event.output.reasoningContent && !streamedReasoning) {
          options.write(block('Provider reasoning', event.output.reasoningContent, color.magenta, color))
        } else if (!streamedReasoning) {
          options.write(`${color.dim('│')}  ${color.dimItalic('Provider reasoning: not returned')}`)
        }
        if (event.output.kind === 'final' && !streamedOutput) {
          options.write(block(
            'Final content',
            options.renderMarkdown?.(event.output.content) ?? event.output.content,
            value => value,
            color,
          ))
        } else if (event.output.kind === 'tool-calls') {
          if (event.output.content !== undefined && !streamedOutput) {
            options.write(block('Model content', event.output.content, color.cyan, color))
          }
          options.write(`${color.dim('│')}  ${color.boldCyan('Tool calls')} ${color.cyan(String(event.output.calls.length))}`)
        }
        return
      case 'loop-guard.reminded':
        options.write(
          `${color.dim('│')}  ${color.yellow('!')} ${color.boldYellow('Loop Guard reminder')} ${color.dim(`${event.summary} · after step ${event.afterStep}`)}`,
        )
        options.write(block('Advice', event.content, color.yellow, color))
        return
      case 'tool.batch-started':
        if (mode === 'compact') return
        options.write(
          `${color.dim('│')}  ${event.mode === 'parallel' ? color.yellow('⚡ parallel') : color.yellow('→ serial')} tool batch ${color.dim(`· ${event.count} call${event.count === 1 ? '' : 's'}`)}`,
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
          `${color.boldGreen('└─ Turn completed')} ${color.dim(`${event.steps} steps · ${formatDuration(event.durationMs)}`)}`,
        )
        options.write(renderContextUsage(event.contextUsage, color))
        return
      case 'turn.failed':
        options.write(`${color.boldRed('└─ Turn failed')} ${color.dim(formatDuration(event.durationMs))}`)
        options.write(block('Error', event.error, color.red, color))
        options.write(renderContextUsage(event.contextUsage, color))
        return
    }
  }

  return {
    handle,
    getMode: () => mode,
    toggleMode: () => {
      finishActiveStream()
      flushCollapsedTools()
      mode = mode === 'compact' ? 'verbose' : 'compact'
      return mode
    },
  }
}

type ToolStartedEvent = Extract<AgentEvent, { type: 'tool.started' }>
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>
type ModelDeltaEvent = Extract<AgentEvent, { type: 'model.delta' }>

function renderToolStarted(
  write: (text: string) => void,
  color: TraceColor,
  event: ToolStartedEvent | ToolCompletedEvent,
): void {
  write(`${color.dim('│')}  ${color.yellow('▶')} ${color.boldCyan(event.call.name)} ${color.dim(event.call.id)}`)
  write(block('Arguments', formatToolArguments(event.call.name, event.call.arguments), color.cyan, color))
}

function renderToolCompleted(
  write: (text: string) => void,
  color: TraceColor,
  event: ToolCompletedEvent,
  maxToolResultChars: number,
): void {
  const marker = event.failed ? color.red('✗') : color.green('✓')
  write(
    `${color.dim('│')}  ${marker} ${color.boldCyan(event.call.name)} ${event.failed ? color.red('failed') : color.green('completed')} ${color.dim(formatDuration(event.durationMs))}`,
  )
  write(
    block(
      event.failed ? 'Error' : 'Result',
      formatToolResult(event.call.name, event.content, maxToolResultChars),
      event.failed ? color.red : color.dim,
      color,
    ),
  )
}

function renderCompactToolStarted(
  write: (text: string) => void,
  color: TraceColor,
  event: ToolStartedEvent,
): void {
  write(
    `${color.dim('│')}  ${color.yellow('▶')} ${color.boldCyan(event.call.name)} ${color.dim(compactToolInvocation(event.call.name, event.call.arguments))}`,
  )
}

function renderCompactToolCompleted(
  write: (text: string) => void,
  color: TraceColor,
  event: ToolCompletedEvent,
): void {
  write(
    `${color.dim('│')}  ${color.green('✓')} ${color.boldCyan(event.call.name)} ${color.green('completed')} ${color.dim(formatDuration(event.durationMs))}`,
  )
}

function renderCompactToolFailure(
  write: (text: string) => void,
  color: TraceColor,
  event: ToolCompletedEvent,
): void {
  const target = compactToolInvocation(event.call.name, event.call.arguments)
  const reason = compactFailureReason(event.call.name, event.content)
  write(
    `${color.dim('│')}  ${color.red('✗')} ${color.boldCyan(event.call.name)} ${color.boldRed('failed')} ${color.dim(`${formatDuration(event.durationMs)} · ${target}${reason ? ` · ${reason}` : ''}`)}`,
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
  if (name === 'WebFetch') {
    const url = typeof input.url === 'string' ? compactInline(input.url) : undefined
    return url ?? '(target unavailable)'
  }
  if (name === 'WebSearch') {
    const query = typeof input.query === 'string' ? compactInline(input.query) : undefined
    return query ?? '(query unavailable)'
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
  if (event.call.name === 'WebFetch') {
    const url = typeof input.url === 'string' ? compactInline(input.url) : undefined
    return url ?? event.call.id
  }
  if (event.call.name === 'WebSearch') {
    const query = typeof input.query === 'string' ? compactInline(input.query) : undefined
    return query ?? event.call.id
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

function block(label: string, content: string, decorate: (value: string) => string, color?: TraceColor): string {
  const gutter = color ? color.dim('│') : '│'
  const lines = content.length === 0 ? ['(empty)'] : content.split('\n')
  return [`${gutter}  ${decorate(label)}`, ...lines.map(line => `${gutter}    ${line}`)].join('\n')
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

function renderContextUsage(
  usage: Extract<AgentEvent, { type: 'turn.completed' }>['contextUsage'],
  color: TraceColor,
): string {
  const estimated = `~${formatInteger(usage.estimatedTokens)}`
  if (usage.contextWindowTokens !== undefined) {
    const ratio = usage.estimatedTokens / usage.contextWindowTokens
    const remaining = Math.max(0, usage.contextWindowTokens - usage.estimatedTokens)
    const threshold = usage.autoCompactTokenLimit === undefined
      ? ''
      : ` · auto-compact at ${formatPercentage(usage.autoCompactTokenLimit / usage.contextWindowTokens)} (${formatInteger(Math.max(0, usage.autoCompactTokenLimit - usage.estimatedTokens))} left)`
    const decorate = ratio >= 0.9 ? color.red : ratio >= 0.7 ? color.yellow : color.green
    const bar = contextProgressBar(ratio)
    return `   ${color.bold('Context')} ${decorate(bar)} ${decorate(estimated)} ${color.dim(`/ ${formatInteger(usage.contextWindowTokens)} tokens (${formatPercentage(ratio)}) · ${formatInteger(remaining)} remaining${threshold}`)}`
  }
  if (usage.autoCompactTokenLimit !== undefined) {
    const ratio = usage.estimatedTokens / usage.autoCompactTokenLimit
    const decorate = ratio >= 1 ? color.red : ratio >= 0.75 ? color.yellow : color.green
    const bar = contextProgressBar(ratio)
    return `   ${color.bold('Context')} ${decorate(bar)} ${decorate(estimated)} ${color.dim(`tokens · ${formatPercentage(ratio)} of auto-compact limit · ${formatInteger(Math.max(0, usage.autoCompactTokenLimit - usage.estimatedTokens))} remaining`)}`
  }
  return `   ${color.dim(`Context ${estimated} tokens · window size not configured`)}`
}

function contextProgressBar(ratio: number): string {
  const width = 10
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)))
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`
}

function formatPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}
