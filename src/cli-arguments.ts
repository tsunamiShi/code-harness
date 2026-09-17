export type ChatTarget = { kind: 'project' | 'session'; id: string }

/** Parses direct Node arguments and pnpm arguments that retain a leading separator. */
export function readChatTarget(arguments_: readonly string[]): ChatTarget {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  if (normalized.length === 2 && normalized[0] === '--project' && normalized[1]) {
    return { kind: 'project', id: normalized[1] }
  }
  if (normalized.length === 2 && normalized[0] === '--session' && normalized[1]) {
    return { kind: 'session', id: normalized[1] }
  }
  throw new Error('Usage: pnpm chat -- --project <project-id> | --session <session-id>')
}
