import { stat, realpath } from 'node:fs/promises'

export type ProjectRootRole = 'primary' | 'attached'

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
}

export function primaryRoot(project: AgentProject): ProjectRoot {
  const roots = project.roots.filter(root => root.role === 'primary')
  if (roots.length !== 1) {
    throw new Error(`Project ${project.id} must have exactly one primary root`)
  }
  return roots[0]!
}

/** Produces stable model instructions from the durable Project definition. */
export function projectInstructions(project: AgentProject): string {
  const primary = primaryRoot(project)
  const roots = project.roots.map(root => `- ${root.path} (${root.role})`).join('\n')
  return [
    `Project: ${project.name}`,
    `Primary working directory: ${primary.path}`,
    'Workspace roots:',
    roots,
    'Resolve relative paths against the primary working directory.',
    'Do not access paths outside the listed workspace roots.',
  ].join('\n')
}

async function resolveDirectory(path: string): Promise<string> {
  if (path.trim().length === 0) throw new Error('Workspace root path must not be empty')
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch (error: unknown) {
    throw new Error(`Workspace root does not exist: ${path}`, { cause: error })
  }
  const details = await stat(resolved)
  if (!details.isDirectory()) throw new Error(`Workspace root is not a directory: ${path}`)
  return resolved
}
