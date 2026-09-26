import type { FilesystemAccessMode } from '../projects/project.ts'

export type ChatTarget = {
  kind: 'project'
  id: string
  accessMode: FilesystemAccessMode
  mcpConfigPath?: string
} | {
  kind: 'session'
  id: string
  accessMode: FilesystemAccessMode
  mcpConfigPath?: string
} | {
  kind: 'directory'
  path: string
  accessMode: FilesystemAccessMode
  mcpConfigPath?: string
}

/** Parses direct Node arguments and pnpm arguments that retain a leading separator. */
export function readChatTarget(
  arguments_: readonly string[],
  currentDirectory = process.cwd(),
): ChatTarget {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  let target: { kind: 'project' | 'session'; id: string } | undefined
  let accessMode: FilesystemAccessMode = 'scoped'
  let mcpConfigPath: string | undefined

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index]
    if (argument === '--full-access') {
      if (accessMode === 'full') throw new Error(usage())
      accessMode = 'full'
      continue
    }
    if (argument === '--project' || argument === '--session') {
      const id = normalized[index + 1]
      if (target !== undefined || !id || id.startsWith('--')) throw new Error(usage())
      target = { kind: argument === '--project' ? 'project' : 'session', id }
      index += 1
      continue
    }
    if (argument === '--mcp-config') {
      const path = normalized[index + 1]
      if (mcpConfigPath !== undefined || !path || path.startsWith('--')) throw new Error(usage())
      mcpConfigPath = path
      index += 1
      continue
    }
    throw new Error(usage())
  }

  if (target === undefined) {
    return {
      kind: 'directory',
      path: currentDirectory,
      accessMode,
      ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    }
  }
  return {
    ...target,
    accessMode,
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
  }
}

function usage(): string {
  return 'Usage: ai-agent [--project <project-id> | --session <session-id>] [--full-access] [--mcp-config <path>]'
}
