import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentProject } from '../../src/projects/project.ts'
import type { Tool } from '../../src/runtime/types.ts'
import { createWorkspaceTools } from '../../src/tools/workspace-tools.ts'

test('exposes Read, Edit, Write, Glob, and Grep for one Project', async t => {
  const fixture = await createFixture(t)
  const tools = createWorkspaceTools(fixture.project)

  assert.deepEqual(tools.map(tool => tool.description.name), ['Read', 'Edit', 'Write', 'Glob', 'Grep'])
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

test('Edit replaces one exact occurrence in an existing Project file', async t => {
  const fixture = await createFixture(t)
  const path = join(fixture.primary, 'app.ts')
  const before = 'const mode = "old"\nconst untouched = true\n'
  const after = 'const mode = "new"\nconst untouched = true\n'
  await writeFile(path, before)
  const edit = requireTool(fixture.project, 'Edit')

  assert.equal(edit.parallelSafe, false)
  assert.deepEqual(
    await executeJson(edit, {
      path: 'app.ts',
      oldText: 'const mode = "old"',
      newText: 'const mode = "new"',
    }),
    {
      root: fixture.primary,
      path: 'app.ts',
      changedRange: { startLine: 1, oldLines: 1, newLines: 1 },
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    },
  )
  assert.equal(await readFile(path, 'utf8'), after)
})

test('Edit can modify an Attached Root but rejects ambiguous or stale text', async t => {
  const fixture = await createFixture(t)
  const path = join(fixture.attached, 'shared.ts')
  await writeFile(path, 'same\nsame\n')
  const edit = requireTool(fixture.project, 'Edit')

  await assert.rejects(
    edit.execute({ root: fixture.attached, path: 'shared.ts', oldText: 'same', newText: 'new' }),
    /occurs more than once/,
  )
  await assert.rejects(
    edit.execute({ root: fixture.attached, path: 'shared.ts', oldText: 'missing', newText: 'new' }),
    /was not found/,
  )
  await assert.rejects(
    edit.execute({ root: fixture.attached, path: 'shared.ts', oldText: 'same', newText: 'same' }),
    /must be different/,
  )
  assert.equal(await readFile(path, 'utf8'), 'same\nsame\n')
})

test('Edit rejects traversal, escaping symlinks, binary files, and unregistered roots in scoped mode', async t => {
  const fixture = await createFixture(t)
  const outsideFile = join(fixture.outside, 'secret.txt')
  await writeFile(outsideFile, 'secret')
  await symlink(outsideFile, join(fixture.primary, 'escape.txt'))
  await writeFile(join(fixture.primary, 'binary.dat'), Buffer.from([0, 1, 2]))
  const edit = createWorkspaceTools(fixture.project, 'scoped').find(
    candidate => candidate.description.name === 'Edit',
  )
  assert.ok(edit)

  await assert.rejects(
    edit.execute({ path: '../outside/secret.txt', oldText: 'secret', newText: 'changed' }),
    /parent traversal/,
  )
  await assert.rejects(
    edit.execute({ path: 'escape.txt', oldText: 'secret', newText: 'changed' }),
    /escapes its selected root/,
  )
  await assert.rejects(
    edit.execute({ path: 'binary.dat', oldText: 'x', newText: 'y' }),
    /does not support binary files/,
  )
  await assert.rejects(
    edit.execute({ root: fixture.outside, path: 'secret.txt', oldText: 'secret', newText: 'changed' }),
    /Unknown Workspace Root/,
  )
  assert.equal(await readFile(outsideFile, 'utf8'), 'secret')
})

test('Write creates new files in Primary and Attached Roots without returning their content', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'generated'))
  const write = requireTool(fixture.project, 'Write')
  const content = 'export const greeting = "你好"\n'

  assert.equal(write.parallelSafe, false)
  assert.deepEqual(
    await executeJson(write, { path: 'generated/greeting.ts', content }),
    {
      root: fixture.primary,
      path: 'generated/greeting.ts',
      characters: content.length,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
    },
  )
  assert.equal(await readFile(join(fixture.primary, 'generated', 'greeting.ts'), 'utf8'), content)

  assert.deepEqual(
    await executeJson(write, { root: fixture.attached, path: 'empty.txt', content: '' }),
    {
      root: fixture.attached,
      path: 'empty.txt',
      characters: 0,
      bytes: 0,
      sha256: sha256(''),
    },
  )
  assert.equal(await readFile(join(fixture.attached, 'empty.txt'), 'utf8'), '')
})

test('Write never overwrites an existing file or symbolic link', async t => {
  const fixture = await createFixture(t)
  const existingPath = join(fixture.primary, 'existing.txt')
  const outsidePath = join(fixture.outside, 'secret.txt')
  await writeFile(existingPath, 'existing')
  await writeFile(outsidePath, 'secret')
  await symlink(outsidePath, join(fixture.primary, 'linked.txt'))
  const write = requireTool(fixture.project, 'Write')

  await assert.rejects(
    write.execute({ path: 'existing.txt', content: 'replacement' }),
    /target already exists.*use Edit/,
  )
  await assert.rejects(
    write.execute({ path: 'linked.txt', content: 'replacement' }),
    /target already exists.*use Edit/,
  )
  assert.equal(await readFile(existingPath, 'utf8'), 'existing')
  assert.equal(await readFile(outsidePath, 'utf8'), 'secret')
  assert.deepEqual(
    (await readdir(fixture.primary)).filter(name => name.startsWith('.ai-agent-write-')),
    [],
  )
})

test('Write rejects traversal, missing or escaping parents, oversized content, and unregistered roots in scoped mode', async t => {
  const fixture = await createFixture(t)
  await symlink(fixture.outside, join(fixture.primary, 'escape'))
  const write = createWorkspaceTools(fixture.project, 'scoped').find(
    candidate => candidate.description.name === 'Write',
  )
  assert.ok(write)

  await assert.rejects(
    write.execute({ path: '../outside/new.txt', content: 'new' }),
    /parent traversal/,
  )
  await assert.rejects(
    write.execute({ path: 'missing/new.txt', content: 'new' }),
    /parent directory does not exist/,
  )
  await assert.rejects(
    write.execute({ path: 'escape/new.txt', content: 'new' }),
    /escapes its selected root/,
  )
  await assert.rejects(
    write.execute({ path: 'large.txt', content: 'x'.repeat(64_001) }),
    /64000-character limit/,
  )
  await assert.rejects(
    write.execute({ root: fixture.outside, path: 'new.txt', content: 'new' }),
    /Unknown Workspace Root/,
  )
})

test('full access allows Edit and Write in an unregistered absolute directory', async t => {
  const fixture = await createFixture(t)
  const existingPath = join(fixture.outside, 'existing.txt')
  await writeFile(existingPath, 'before\n')
  const tools = createWorkspaceTools(fixture.project, 'full')
  const edit = requireNamedTool(tools, 'Edit')
  const write = requireNamedTool(tools, 'Write')

  const editResult = await executeJson(edit, {
    root: fixture.outside,
    path: 'existing.txt',
    oldText: 'before',
    newText: 'after',
  })
  assert.equal(Reflect.get(editResult as object, 'root'), fixture.outside)
  assert.equal(await readFile(existingPath, 'utf8'), 'after\n')

  const writeResult = await executeJson(write, {
    root: fixture.outside,
    path: 'created.txt',
    content: 'created\n',
  })
  assert.equal(Reflect.get(writeResult as object, 'root'), fixture.outside)
  assert.equal(await readFile(join(fixture.outside, 'created.txt'), 'utf8'), 'created\n')
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
  return requireNamedTool(createWorkspaceTools(project), name)
}

function requireNamedTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find(candidate => candidate.description.name === name)
  assert.ok(tool)
  return tool
}

async function executeJson(tool: Tool, input: unknown): Promise<unknown> {
  return JSON.parse(await tool.execute(input))
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
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
