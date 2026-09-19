import { stat, realpath } from 'node:fs/promises'

export type ProjectRootRole = 'primary' | 'attached'
export type FilesystemAccessMode = 'scoped' | 'full'

export interface ProjectRoot {
  path: string
  role: ProjectRootRole
}

export interface AgentProject {
  id: string
  name: string
  roots: readonly ProjectRoot[]
}

export interface CreateProjectInput {
  name: string
  primaryPath: string
  additionalPaths?: readonly string[]
}

export interface ProjectStore {
  createProject(input: {
    name: string
    roots: readonly ProjectRoot[]
  }): Promise<AgentProject>
  loadProject(projectId: string): Promise<AgentProject | undefined>
  listProjects(): Promise<readonly AgentProject[]>
  attachRoot(projectId: string, path: string): Promise<AgentProject>
}

/** Validates local directories and persists projects through a ProjectStore adapter. */
export class ProjectCatalog {
  constructor(private readonly store: ProjectStore) {}

  async create(input: CreateProjectInput): Promise<AgentProject> {
    const name = input.name.trim()
    if (name.length === 0) throw new Error('Project name must not be empty')

    const primaryPath = await resolveDirectory(input.primaryPath)
    const additionalPaths = await Promise.all(
      (input.additionalPaths ?? []).map(resolveDirectory),
    )
    const uniqueAdditionalPaths = [...new Set(additionalPaths)].filter(
      path => path !== primaryPath,
    )

    return await this.store.createProject({
      name,
      roots: [
        { path: primaryPath, role: 'primary' },
        ...uniqueAdditionalPaths.map(path => ({ path, role: 'attached' as const })),
      ],
    })
  }

  async get(projectId: string): Promise<AgentProject> {
    const project = await this.store.loadProject(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    return project
  }

  async list(): Promise<readonly AgentProject[]> {
    return await this.store.listProjects()
  }

  /** Adds one canonical directory as an Attached Root and returns the updated Project. */
  async attach(projectId: string, path: string): Promise<AgentProject> {
    const resolvedPath = await resolveDirectory(path)
    return await this.store.attachRoot(projectId, resolvedPath)
  }
}

export function primaryRoot(project: AgentProject): ProjectRoot {
  const roots = project.roots.filter(root => root.role === 'primary')
  if (roots.length !== 1) {
    throw new Error(`Project ${project.id} must have exactly one primary root`)
  }
  return roots[0]!
}

/** Produces stable model instructions from the Project and current runtime access mode. */
export function projectInstructions(
  project: AgentProject,
  accessMode: FilesystemAccessMode = 'scoped',
): string {
  const primary = primaryRoot(project)
  const roots = project.roots.map(root => `- ${root.path} (${root.role})`).join('\n')
  const instructions = [
    `Project: ${project.name}`,
    `Primary working directory: ${primary.path}`,
    'Project roots:',
    roots,
    'Resolve relative paths against the primary working directory.',
    '',
    'Available code tools:',
    '- Read: read a bounded line range from one UTF-8 text file.',
    '- Glob: discover files by path pattern.',
    '- Grep: search file contents with a regular expression and optional file filter.',
    '- LSP: query definitions, references, and hover information from a language server.',
    '- Edit: replace one exact, unique text occurrence in an existing file.',
    '- Write: create a new file; it never overwrites an existing path.',
    '',
    'Tool selection policy:',
    '- Use a dedicated tool whenever it covers the operation.',
    '- Use Read instead of Bash commands such as cat, sed, head, or tail for file contents.',
    '- Use Glob instead of Bash commands such as ls or find for file discovery.',
    '- Use Grep instead of Bash commands such as grep or rg for source-text search.',
    '- Use Edit or Write instead of Bash, sed, perl, or scripting languages for file changes.',
    '- Use LSP for semantic definitions and references when it is configured; do not emulate semantic queries with Bash.',
    '- When multiple Read, Glob, or Grep operations are independent, request them together in one tool-call batch.',
    '- If a dedicated tool returns a bounded or truncated result, narrow or paginate that tool rather than switching to Bash.',
  ]
  if (accessMode === 'full') {
    instructions.push(
      '- Bash: run builds, tests, Git, package-manager commands, and operations that have no dedicated tool.',
      '- Do not use Bash for reading, discovering, searching, or editing project files when the dedicated tools can perform the operation.',
      '',
      'Filesystem access mode: full.',
      'All Filesystem Tools, including Edit and Write, may select any absolute local directory as root; paths remain relative to that root.',
    )
  } else {
    instructions.push(
      '',
      'Filesystem access mode: scoped.',
      'Do not access paths outside the listed project roots.',
    )
  }
  return instructions.join('\n')
}

async function resolveDirectory(path: string): Promise<string> {
  if (path.trim().length === 0) throw new Error('Project root path must not be empty')
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch (error: unknown) {
    throw new Error(`Project root does not exist: ${path}`, { cause: error })
  }
  const details = await stat(resolved)
  if (!details.isDirectory()) throw new Error(`Project root is not a directory: ${path}`)
  return resolved
}
