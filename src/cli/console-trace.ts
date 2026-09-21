import type { AgentEvent } from '../runtime/agent-session.ts'
import type { AgentTraceMode } from './config.ts'

const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000
const COLLAPSIBLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP'])

export interface ConsoleTraceOptions {
  write: (text: string) => void
  colors?: boolean
  mode?: AgentTraceMode
  maxToolResultChars?: number
  renderMarkdown?: (source: string) => string
}

/** Formats Agent runtime events as a readable terminal execution timeline. */
export function createConsoleTrace(options: ConsoleTraceOptions): (event: AgentEvent) => void {
  const color = createColor(options.colors === true)
  const mode = options.mode ?? 'compact'
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  let collapsedTools: ToolCompletedEvent[] = []

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

  return event => {
    if (
      event.type === 'turn.started'
      || event.type === 'turn.resumed'
      || event.type === 'step.started'
      || event.type === 'turn.completed'
      || event.type === 'turn.failed'
      || event.type === 'tool.batch-started'
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
      case 'model.completed':
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
      case 'tool.batch-started':
        if (mode === 'compact') return
        options.write(
          `│  ${event.mode === 'parallel' ? color.yellow('⚡ parallel') : color.yellow('→ serial')} tool batch · ${event.count} call${event.count === 1 ? '' : 's'}`,
        )
        return
      case 'tool.started':
        if (mode === 'compact' && COLLAPSIBLE_TOOLS.has(event.call.name)) return
        renderToolStarted(options.write, color, event)
        return
      case 'tool.completed': {
        if (mode === 'compact' && COLLAPSIBLE_TOOLS.has(event.call.name)) {
          if (!event.failed) {
            collapsedTools.push(event)
            return
          }
          renderToolStarted(options.write, color, event)
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
}

type ToolStartedEvent = Extract<AgentEvent, { type: 'tool.started' }>
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>

function renderToolStarted(
  write: (text: string) => void,
  color: ReturnType<typeof createColor>,
  event: ToolStartedEvent | ToolCompletedEvent,
): void {
  write(`│  ${color.yellow('▶')} ${color.bold(event.call.name)} ${color.dim(event.call.id)}`)
  write(block('Arguments', formatValue(event.call.arguments), color.cyan))
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
      truncate(event.content, maxToolResultChars),
      event.failed ? color.red : color.dim,
    ),
  )
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

function formatValue(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2)
  return formatted ?? String(value)
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… ${value.length - maxChars} more characters omitted`
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
