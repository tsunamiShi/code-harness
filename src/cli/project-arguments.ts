export type ProjectCommand =
  | {
      kind: 'create'
      name: string
      primaryPath: string
      additionalPaths: readonly string[]
    }
  | { kind: 'list' }
  | { kind: 'show'; projectId: string }
  | { kind: 'attach'; projectId: string; path: string }

/** Parses Project management commands without opening the database. */
export function readProjectCommand(arguments_: readonly string[]): ProjectCommand {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  const [command, ...rest] = normalized

  if (command === 'create') return readCreateArguments(rest)
  if (command === 'list' && rest.length === 0) return { kind: 'list' }
  if (command === 'show' && rest.length === 1 && rest[0]) {
    return { kind: 'show', projectId: rest[0] }
  }
  if (command === 'attach' && rest.length === 3 && rest[0] && rest[1] === '--path' && rest[2]) {
    return { kind: 'attach', projectId: rest[0], path: rest[2] }
  }
  throw new Error(projectUsage())
}

export function projectUsage(): string {
  return [
    'Usage:',
    '  code-harness project create --name <name> --primary <path> [--root <path> ...]',
    '  code-harness project list',
    '  code-harness project show <project-id>',
    '  code-harness project attach <project-id> --path <directory>',
  ].join('\n')
}

function readCreateArguments(arguments_: readonly string[]): Extract<ProjectCommand, { kind: 'create' }> {
  let name: string | undefined
  let primaryPath: string | undefined
  const additionalPaths: string[] = []

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!value) throw new Error(projectUsage())
    if (flag === '--name' && name === undefined) name = value
    else if (flag === '--primary' && primaryPath === undefined) primaryPath = value
    else if (flag === '--root') additionalPaths.push(value)
    else throw new Error(`Unknown or duplicate option: ${flag}\n${projectUsage()}`)
  }

  if (!name || !primaryPath) throw new Error(projectUsage())
  return { kind: 'create', name, primaryPath, additionalPaths }
}
