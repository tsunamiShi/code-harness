import type { WorkspaceAccessMode } from './project.ts'

export type ChatTarget = {
  kind: 'project' | 'session'
  id: string
  accessMode: WorkspaceAccessMode
}

/** Parses direct Node arguments and pnpm arguments that retain a leading separator. */
export function readChatTarget(arguments_: readonly string[]): ChatTarget {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  const accessFlags = normalized.filter(argument => argument === '--full-access')
  if (accessFlags.length > 1) throw new Error(usage())
  const targetArguments = normalized.filter(argument => argument !== '--full-access')
  const accessMode = accessFlags.length === 1 ? 'full' : 'scoped'
  if (targetArguments.length === 2 && targetArguments[0] === '--project' && targetArguments[1]) {
    return { kind: 'project', id: targetArguments[1], accessMode }
  }
  if (targetArguments.length === 2 && targetArguments[0] === '--session' && targetArguments[1]) {
    return { kind: 'session', id: targetArguments[1], accessMode }
  }
  throw new Error(usage())
}

function usage(): string {
  return 'Usage: pnpm chat -- (--project <project-id> | --session <session-id>) [--full-access]'
}
