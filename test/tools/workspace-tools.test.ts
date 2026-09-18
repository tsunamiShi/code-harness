import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentProject } from '../../src/projects/project.ts'
import type { Tool } from '../../src/runtime/types.ts'
import { createWorkspaceTools } from '../../src/tools/workspace-tools.ts'

test('exposes only Read, Glob, and Grep for one Project', async t => {
  const fixture = await createFixture(t)
  const tools = createWorkspaceTools(fixture.project)

  assert.deepEqual(tools.map(tool => tool.description.name), ['Read', 'Glob', 'Grep'])
  const read = tools[0]
  assert.ok(read)
  const properties = Reflect.get(read.description.parameters, 'properties')
  assert.ok(typeof properties === 'object' && properties !== null)
  const root = Reflect.get(properties, 'root')
  assert.ok(typeof root === 'object' && root !== null)
  assert.deepEqual(
    Reflect.get(root, 'enum'),
    ['primary', fixture.primary, fixture.attached],
  )
})

test('Read returns a bounded line range and can select an attached root', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.primary, 'notes.txt'), 'one\ntwo\nthree\nfour\n')
  await writeFile(join(fixture.attached, 'shared.txt'), 'attached\n')
  const read = requireTool(fixture.project, 'Read')

  assert.deepEqual(await executeJson(read, { path: 'notes.txt', offset: 2, limit: 2 }), {
    root: fixture.primary,
    path: 'notes.txt',
    lines: [
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
    ],
    truncated: true,
  })
  assert.deepEqual(await executeJson(read, { root: fixture.attached, path: 'shared.txt' }), {
    root: fixture.attached,
    path: 'shared.txt',
    lines: [{ line: 1, text: 'attached' }],
    truncated: false,
  })
})

test('Read rejects traversal and symlinks that escape the selected root', async t => {
  const fixture = await createFixture(t)
  const outsideFile = join(fixture.outside, 'secret.txt')
  await writeFile(outsideFile, 'secret')
  await symlink(outsideFile, join(fixture.primary, 'escape.txt'))
  const read = requireTool(fixture.project, 'Read')

  await assert.rejects(read.execute({ path: '../outside/secret.txt' }), /parent traversal/)
  await assert.rejects(read.execute({ path: 'escape.txt' }), /escapes its selected root/)
  await assert.rejects(read.execute({ root: fixture.outside, path: 'secret.txt' }), /Unknown Workspace Root/)
})

test('full access can select an unregistered absolute directory', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.outside, 'note.txt'), 'outside content\n')
  const read = createWorkspaceTools(fixture.project, 'full').find(
    candidate => candidate.description.name === 'Read',
  )
  assert.ok(read)

  assert.deepEqual(await executeJson(read, { root: fixture.outside, path: 'note.txt' }), {
    root: fixture.outside,
    path: 'note.txt',
    lines: [{ line: 1, text: 'outside content' }],
    truncated: false,
  })
})

test('Glob returns sorted Project-relative files and excludes dependency output', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'src'))
  await mkdir(join(fixture.primary, 'node_modules'))
  await Promise.all([
    writeFile(join(fixture.primary, 'src', 'b.ts'), ''),
    writeFile(join(fixture.primary, 'src', 'a.ts'), ''),
    writeFile(join(fixture.primary, 'node_modules', 'ignored.ts'), ''),
  ])
  const glob = requireTool(fixture.project, 'Glob')

  assert.deepEqual(await executeJson(glob, { pattern: '**/*.ts' }), {
    root: fixture.primary,
    pattern: '**/*.ts',
    files: ['src/a.ts', 'src/b.ts'],
    truncated: false,
  })
})

test('Grep searches regular expressions with file filters and a global result limit', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'src'))
  await mkdir(join(fixture.primary, 'dist'))
  await Promise.all([
    writeFile(join(fixture.primary, 'src', 'a.ts'), 'Agent runtime\nagent loop\n'),
    writeFile(join(fixture.primary, 'src', 'b.ts'), 'another Agent\n'),
    writeFile(join(fixture.primary, 'dist', 'ignored.ts'), 'Agent\n'),
  ])
  const grep = requireTool(fixture.project, 'Grep')

  const result = await executeJson(grep, {
    pattern: 'agent',
    glob: '**/*.ts',
    caseSensitive: false,
    maxResults: 2,
  })

  assert.deepEqual(result, {
    root: fixture.primary,
    pattern: 'agent',
    matches: [
      { path: 'src/a.ts', line: 1, text: 'Agent runtime' },
      { path: 'src/a.ts', line: 2, text: 'agent loop' },
    ],
    limitReached: true,
  })
})

test('Grep reports invalid regular expressions as tool errors', async t => {
  const fixture = await createFixture(t)
  const grep = requireTool(fixture.project, 'Grep')

  await assert.rejects(grep.execute({ pattern: '[' }), /Grep failed/)
})

function requireTool(project: AgentProject, name: string): Tool {
  const tool = createWorkspaceTools(project).find(candidate => candidate.description.name === name)
  assert.ok(tool)
  return tool
}

async function executeJson(tool: Tool, input: unknown): Promise<unknown> {
  return JSON.parse(await tool.execute(input))
}

async function createFixture(t: test.TestContext): Promise<{
  project: AgentProject
  primary: string
  attached: string
  outside: string
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ai-agent-workspace-')))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  const attached = join(directory, 'attached')
  const outside = join(directory, 'outside')
  await Promise.all([mkdir(primary), mkdir(attached), mkdir(outside)])
  return {
    project: {
      id: 'project-1',
      name: 'workspace',
      roots: [
        { path: primary, role: 'primary' },
        { path: attached, role: 'attached' },
      ],
    },
    primary,
    attached,
    outside,
  }
}
