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
} from '../src/project.ts'

test('creates a project with one primary root and deduplicated attached roots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-project-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  const attached = join(directory, 'attached')
  await Promise.all([mkdir(primary), mkdir(attached)])
  const store = new RecordingProjectStore()

  const project = await new ProjectCatalog(store).create({
    name: ' workspace ',
    primaryPath: primary,
    additionalPaths: [attached, attached, primary],
  })

  assert.equal(project.name, 'workspace')
  assert.deepEqual(project.roots, [
    { path: await realpath(primary), role: 'primary' },
    { path: await realpath(attached), role: 'attached' },
  ])
})

test('rejects a workspace root that is not a directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-project-'))
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

class RecordingProjectStore implements ProjectStore {
  private project: AgentProject | undefined

  async createProject(input: {
    name: string
    roots: readonly ProjectRoot[]
  }): Promise<AgentProject> {
    this.project = { id: 'project-1', name: input.name, roots: structuredClone(input.roots) }
    return this.project
  }

  async loadProject(projectId: string): Promise<AgentProject | undefined> {
    return this.project?.id === projectId ? this.project : undefined
  }

  async listProjects(): Promise<readonly AgentProject[]> {
    return this.project ? [this.project] : []
  }
}
