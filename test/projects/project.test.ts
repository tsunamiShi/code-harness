import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  type AgentProject,
  ProjectCatalog,
  type ProjectRoot,
  type ProjectStore,
  projectInstructions,
} from '../../src/projects/project.ts'

test('creates a project with one primary root and deduplicated attached roots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-harness-project-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  const attached = join(directory, 'attached')
  await Promise.all([mkdir(primary), mkdir(attached)])
  const store = new RecordingProjectStore()

  const project = await new ProjectCatalog(store).create({
    name: ' project ',
    primaryPath: primary,
    additionalPaths: [attached, attached, primary],
  })

  assert.equal(project.name, 'project')
  assert.deepEqual(project.roots, [
    { path: await realpath(primary), role: 'primary' },
    { path: await realpath(attached), role: 'attached' },
  ])
})

test('rejects a project root that is not a directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-harness-project-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'file.txt')
  await writeFile(file, 'not a directory')

  await assert.rejects(
    new ProjectCatalog(new RecordingProjectStore()).create({
      name: 'invalid',
      primaryPath: file,
    }),
    /not a directory/,
  )
})

test('attaches a canonical directory to an existing project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-harness-project-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  const attached = join(directory, 'attached')
  await Promise.all([mkdir(primary), mkdir(attached)])
  const store = new RecordingProjectStore()
  const catalog = new ProjectCatalog(store)
  const project = await catalog.create({ name: 'project', primaryPath: primary })

  const updated = await catalog.attach(project.id, attached)

  assert.deepEqual(updated.roots, [
    { path: await realpath(primary), role: 'primary' },
    { path: await realpath(attached), role: 'attached' },
  ])
})

test('creates a directory Project once and reuses it by canonical primary root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-harness-project-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'memory')
  await mkdir(primary)
  const store = new RecordingProjectStore()
  const catalog = new ProjectCatalog(store)

  const created = await catalog.getOrCreateForDirectory(primary)
  const reused = await catalog.getOrCreateForDirectory(primary)

  assert.equal(created.name, 'memory')
  assert.equal(reused.id, created.id)
  assert.equal(store.createCount, 1)
  assert.deepEqual(created.roots, [{ path: await realpath(primary), role: 'primary' }])
})

test('full-access instructions allow arbitrary absolute paths without changing the Project', () => {
  const project: AgentProject = {
    id: 'project-1',
    name: 'project',
    roots: [{ path: '/project/primary', role: 'primary' }],
  }

  const instructions = projectInstructions(project, 'full')

  assert.match(instructions, /Filesystem access mode: full/)
  assert.match(instructions, /any absolute local path/)
  assert.match(instructions, /All code Tool paths must be absolute/)
  assert.doesNotMatch(instructions, /Do not access paths outside/)
})

test('instructions require dedicated code tools instead of Bash equivalents', () => {
  const project: AgentProject = {
    id: 'project-1',
    name: 'project',
    roots: [{ path: '/project/primary', role: 'primary' }],
  }

  const instructions = projectInstructions(project, 'full')

  assert.match(instructions, /Available code tools:/)
  assert.match(instructions, /Read: read a bounded line range/)
  assert.match(instructions, /Glob: discover files/)
  assert.match(instructions, /Grep: search file contents/)
  assert.match(instructions, /LSP: query definitions, references/)
  assert.match(instructions, /Edit: replace one exact, unique text occurrence/)
  assert.match(instructions, /Write: create a new file/)
  assert.match(instructions, /Use Read instead of Bash commands such as cat, sed, head, or tail/)
  assert.match(instructions, /Use Glob instead of Bash commands such as ls or find/)
  assert.match(instructions, /Use Grep instead of Bash commands such as grep or rg/)
  assert.match(instructions, /Do not use Bash for reading, discovering, searching, or editing/)
  assert.doesNotMatch(instructions, /First determine whether the user is asking a question/)
  assert.match(instructions, /Working style:/)
  assert.match(instructions, /Start implementing as soon as you have enough information/)
  assert.match(instructions, /together in one tool-call batch/)
  assert.match(instructions, /Reuse exact absolute paths returned by Tools/)
})

test('scoped instructions omit unavailable Bash guidance', () => {
  const project: AgentProject = {
    id: 'project-1',
    name: 'project',
    roots: [{ path: '/project/primary', role: 'primary' }],
  }

  const instructions = projectInstructions(project)

  assert.match(instructions, /Filesystem access mode: scoped/)
  assert.doesNotMatch(instructions, /Bash: run builds/)
  assert.doesNotMatch(instructions, /WebFetch/)
})

test('WebFetch instructions appear only when the Tool is exposed', () => {
  const project: AgentProject = {
    id: 'project-1',
    name: 'project',
    roots: [{ path: '/project/primary', role: 'primary' }],
  }

  const instructions = projectInstructions(project, 'scoped', { webFetch: true })

  assert.match(instructions, /Use WebFetch to read one exact http\(s\) URL/)
  assert.match(instructions, /Do not guess or invent URLs/)
  assert.doesNotMatch(instructions, /WebSearch/)
})

test('WebSearch instructions appear only when the Tool is exposed', () => {
  const project: AgentProject = {
    id: 'project-1',
    name: 'project',
    roots: [{ path: '/project/primary', role: 'primary' }],
  }

  const instructions = projectInstructions(project, 'scoped', { webSearch: true })

  assert.match(instructions, /Use WebSearch with one natural-language query/)
  assert.match(instructions, /Read exact source URLs found by WebSearch with WebFetch/)
})

class RecordingProjectStore implements ProjectStore {
  private project: AgentProject | undefined
  createCount = 0

  async createProject(input: {
    name: string
    roots: readonly ProjectRoot[]
  }): Promise<AgentProject> {
    this.createCount += 1
    this.project = { id: 'project-1', name: input.name, roots: structuredClone(input.roots) }
    return this.project
  }

  async loadProject(projectId: string): Promise<AgentProject | undefined> {
    return this.project?.id === projectId ? this.project : undefined
  }

  async loadProjectByPrimaryRoot(path: string): Promise<AgentProject | undefined> {
    return this.project?.roots.some(root => root.role === 'primary' && root.path === path)
      ? this.project
      : undefined
  }

  async listProjects(): Promise<readonly AgentProject[]> {
    return this.project ? [this.project] : []
  }

  async attachRoot(projectId: string, path: string): Promise<AgentProject> {
    if (!this.project || this.project.id !== projectId) {
      throw new Error(`Unknown project: ${projectId}`)
    }
    if (this.project.roots.some(root => root.path === path)) return this.project
    this.project = {
      ...this.project,
      roots: [...this.project.roots, { path, role: 'attached' }],
    }
    return this.project
  }
}
