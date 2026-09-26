import type { AgentSessionSummary } from '../runtime/session-store.ts'

export const SLASH_COMMANDS = [
  { name: '/resume', description: 'Select a Session from the current Project.' },
  { name: '/retry', description: 'Continue the current failed or interrupted Turn.' },
  { name: '/help', description: 'Show available slash commands.' },
  { name: '/exit', description: 'Exit the CLI.' },
] as const

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line]
  return [
    SLASH_COMMANDS.map(command => command.name).filter(name => name.startsWith(line)),
    line,
  ]
}

export function slashCommandHelp(): string {
  return [
    'Slash commands:',
    ...SLASH_COMMANDS.map(command => `  ${command.name.padEnd(8)} ${command.description}`),
    '',
    'Type / then press Tab to complete a command.',
  ].join('\n')
}

export async function selectProjectSession(options: {
  sessions: readonly AgentSessionSummary[]
  currentSessionId: string
  ask: (prompt: string) => Promise<string>
  write: (text: string) => void
}): Promise<string | undefined> {
  const candidates = options.sessions.filter(session => session.id !== options.currentSessionId)
  if (candidates.length === 0) {
    options.write('No other Sessions exist for this Project.')
    return undefined
  }

  options.write([
    'Sessions for the current Project:',
    ...candidates.map((session, index) => formatSessionChoice(session, index)),
  ].join('\n'))
  const answer = (await options.ask('Select a Session number, or press Enter to cancel: ')).trim()
  if (answer.length === 0) return undefined
  const selection = Number(answer)
  if (!Number.isSafeInteger(selection) || selection < 1 || selection > candidates.length) {
    options.write(`Invalid Session selection: ${answer}`)
    return undefined
  }
  return candidates[selection - 1]?.id
}

function formatSessionChoice(session: AgentSessionSummary, index: number): string {
  const turnLabel = session.turnCount === 1 ? '1 Turn' : `${session.turnCount} Turns`
  const state = session.lastTurnStatus === undefined ? 'empty' : session.lastTurnStatus
  const prompt = session.lastPrompt === undefined
    ? '(no prompts yet)'
    : session.lastPrompt.replaceAll(/\s+/g, ' ').slice(0, 80)
  return `  ${index + 1}. ${session.id} · ${formatTimestamp(session.updatedAt)} · ${turnLabel} · ${state} · ${prompt}`
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}
