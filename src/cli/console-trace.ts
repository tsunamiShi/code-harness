import type { AgentEvent } from '../runtime/agent-session.ts'

const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000

export interface ConsoleTraceOptions {
  write: (text: string) => void
  colors?: boolean
  maxToolResultChars?: number
}

/** Formats Agent runtime events as a readable terminal execution timeline. */
export function createConsoleTrace(options: ConsoleTraceOptions): (event: AgentEvent) => void {
  const color = createColor(options.colors === true)
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS

  return event => {
    switch (event.type) {
      case 'turn.started':
        options.write(`\n${color.bold('┌─ Turn started')} ${color.dim(shortId(event.turnId))}`)
        options.write(block('User', event.prompt, color.cyan))
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
          options.write(block('Final content', event.output.content, color.green))
        } else {
          if (event.output.content !== undefined) {
            options.write(block('Model content', event.output.content, color.green))
          }
          options.write(`│  ${color.cyan('Tool calls')} ${event.output.calls.length}`)
        }
        return
      case 'tool.batch-started':
        options.write(
          `│  ${event.mode === 'parallel' ? color.yellow('⚡ parallel') : color.yellow('→ serial')} tool batch · ${event.count} call${event.count === 1 ? '' : 's'}`,
        )
        return
      case 'tool.started':
        options.write(`│  ${color.yellow('▶')} ${color.bold(event.call.name)} ${color.dim(event.call.id)}`)
        options.write(block('Arguments', formatValue(event.call.arguments), color.cyan))
        return
      case 'tool.completed': {
        const marker = event.failed ? color.red('✗') : color.green('✓')
        options.write(
          `│  ${marker} ${color.bold(event.call.name)} ${event.failed ? 'failed' : 'completed'} ${color.dim(formatDuration(event.durationMs))}`,
        )
        options.write(
          block(
            event.failed ? 'Error' : 'Result',
            truncate(event.content, maxToolResultChars),
            event.failed ? color.red : color.dim,
          ),
        )
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
