import { stat, realpath } from 'node:fs/promises'
import { basename } from 'node:path'

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
  loadProjectByPrimaryRoot(path: string): Promise<AgentProject | undefined>
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

  /** Reuses the Project for a canonical primary root, or creates it on first use. */
  async getOrCreateForDirectory(path: string): Promise<AgentProject> {
    const primaryPath = await resolveDirectory(path)
    const existing = await this.store.loadProjectByPrimaryRoot(primaryPath)
    if (existing) return existing
    return await this.store.createProject({
      name: basename(primaryPath) || primaryPath,
      roots: [{ path: primaryPath, role: 'primary' }],
    })
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
    'All code Tool paths must be absolute.',
    'Reuse exact absolute paths returned by Tools instead of converting them to relative paths or guessing them.',
    'Project roots are exploration starting points; the Runtime enforces filesystem access.',
    '',
    'Available code tools:',
    '- Read: read a bounded line range from one UTF-8 text file; results report the file total line count, and one call can return up to 2000 lines, so request the full remaining range instead of paging in small windows.',
    '- Glob: discover files by path pattern; set includeDirectories with pattern * to list one directory level instead of Bash ls.',
    '- Grep: search file contents with a regular expression, optional file filter, and optional surrounding context lines.',
    '- LSP: query definitions, references, and hover information from a language server.',
    '- Edit: replace one exact, unique text occurrence in an existing file.',
    '- Write: create a new file; it never overwrites an existing path.',
    '',
    'Working style:',
    '- Start implementing as soon as you have enough information to act; do not keep exploring beyond what the task needs.',
    '- Do not re-read files or re-derive facts that earlier Tool Results in this Turn already established.',
    '- Request independent Read, Glob, Grep, and LSP operations together in one tool-call batch instead of spending one Step per call.',
    '- Read the full relevant range of a file in one call instead of paging in small windows.',
    '- Use Grep context lines instead of follow-up Read calls that only inspect the lines around a match.',
    '- After mutating a file, verify with a targeted Read of the changed range, LSP, or the relevant checks; do not re-read entire files to confirm an Edit.',
    '',
    'Tool selection policy:',
    '- Use a dedicated tool whenever it covers the operation.',
    '- Use Read instead of Bash commands such as cat, sed, head, or tail for file contents.',
    '- Use Glob instead of Bash commands such as ls or find for file discovery, including one-level directory listings through includeDirectories.',
    '- Use Grep instead of Bash commands such as grep or rg for source-text search, including context lines requested through its before and after parameters instead of Bash flags such as -A, -B, or -C.',
    '- Use Edit or Write instead of Bash, sed, perl, or scripting languages for file changes.',
    '- Use LSP for semantic definitions and references when it is configured; do not emulate semantic queries with Bash.',
    '- If a dedicated tool returns a bounded or truncated result, narrow or paginate that tool rather than switching to Bash.',
  ]
  if (accessMode === 'full') {
    instructions.push(
      '- Bash: run builds, tests, Git, package-manager commands, and operations that have no dedicated tool; cwd must be absolute.',
      '- Do not use Bash for reading, discovering, searching, or editing project files when the dedicated tools can perform the operation.',
      '',
      'Filesystem access mode: full.',
      'Filesystem Tools may access any absolute local path allowed by the host operating system.',
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
