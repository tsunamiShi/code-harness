import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentProject } from '../../src/projects/project.ts'
import type { Tool } from '../../src/runtime/types.ts'
import { createFilesystemTools } from '../../src/tools/filesystem-tools.ts'

test('exposes Read, Edit, Write, Glob, and Grep for one Project', async t => {
  const fixture = await createFixture(t)
  const tools = createFilesystemTools(fixture.project)

  assert.deepEqual(tools.map(tool => tool.description.name), ['Read', 'Edit', 'Write', 'Glob', 'Grep'])
  const read = tools[0]
  assert.ok(read)
  const properties = Reflect.get(read.description.parameters, 'properties')
  assert.ok(typeof properties === 'object' && properties !== null)
  assert.equal(Reflect.has(properties, 'root'), false)
  assert.match(String(Reflect.get(Reflect.get(properties, 'path'), 'description')), /Absolute/)
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
      path,
      oldText: 'const mode = "old"',
      newText: 'const mode = "new"',
    }),
    {
      path,
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
    edit.execute({ path, oldText: 'same', newText: 'new' }),
    /occurs more than once/,
  )
  await assert.rejects(
    edit.execute({ path, oldText: 'missing', newText: 'new' }),
    /was not found/,
  )
  await assert.rejects(
    edit.execute({ path, oldText: 'same', newText: 'same' }),
    /must be different/,
  )
  assert.equal(await readFile(path, 'utf8'), 'same\nsame\n')
})

test('Edit rejects relative, escaping symlink, binary, and outside paths in scoped mode', async t => {
  const fixture = await createFixture(t)
  const outsideFile = join(fixture.outside, 'secret.txt')
  await writeFile(outsideFile, 'secret')
  await symlink(outsideFile, join(fixture.primary, 'escape.txt'))
  await writeFile(join(fixture.primary, 'binary.dat'), Buffer.from([0, 1, 2]))
  const edit = createFilesystemTools(fixture.project, 'scoped').find(
    candidate => candidate.description.name === 'Edit',
  )
  assert.ok(edit)

  await assert.rejects(
    edit.execute({ path: '../outside/secret.txt', oldText: 'secret', newText: 'changed' }),
    /must be absolute/,
  )
  await assert.rejects(
    edit.execute({ path: join(fixture.primary, 'escape.txt'), oldText: 'secret', newText: 'changed' }),
    /outside the Project roots/,
  )
  await assert.rejects(
    edit.execute({ path: join(fixture.primary, 'binary.dat'), oldText: 'x', newText: 'y' }),
    /does not support binary files/,
  )
  await assert.rejects(
    edit.execute({ path: outsideFile, oldText: 'secret', newText: 'changed' }),
    /outside the Project roots/,
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
    await executeJson(write, { path: join(fixture.primary, 'generated', 'greeting.ts'), content }),
    {
      path: join(fixture.primary, 'generated', 'greeting.ts'),
      characters: content.length,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
    },
  )
  assert.equal(await readFile(join(fixture.primary, 'generated', 'greeting.ts'), 'utf8'), content)

  assert.deepEqual(
    await executeJson(write, { path: join(fixture.attached, 'empty.txt'), content: '' }),
    {
      path: join(fixture.attached, 'empty.txt'),
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
    write.execute({ path: existingPath, content: 'replacement' }),
    /target already exists.*use Edit/,
  )
  await assert.rejects(
    write.execute({ path: join(fixture.primary, 'linked.txt'), content: 'replacement' }),
    /target already exists.*use Edit/,
  )
  assert.equal(await readFile(existingPath, 'utf8'), 'existing')
  assert.equal(await readFile(outsidePath, 'utf8'), 'secret')
  assert.deepEqual(
    (await readdir(fixture.primary)).filter(name => name.startsWith('.code-harness-write-')),
    [],
  )
})

test('Write rejects relative, missing, escaping, oversized, and outside paths in scoped mode', async t => {
  const fixture = await createFixture(t)
  await symlink(fixture.outside, join(fixture.primary, 'escape'))
  const write = createFilesystemTools(fixture.project, 'scoped').find(
    candidate => candidate.description.name === 'Write',
  )
  assert.ok(write)

  await assert.rejects(
    write.execute({ path: '../outside/new.txt', content: 'new' }),
    /must be absolute/,
  )
  await assert.rejects(
    write.execute({ path: join(fixture.primary, 'missing', 'new.txt'), content: 'new' }),
    /parent directory does not exist/,
  )
  await assert.rejects(
    write.execute({ path: join(fixture.primary, 'escape', 'new.txt'), content: 'new' }),
    /outside the Project roots/,
  )
  await assert.rejects(
    write.execute({ path: join(fixture.primary, 'large.txt'), content: 'x'.repeat(64_001) }),
    /64000-character limit/,
  )
  await assert.rejects(
    write.execute({ path: join(fixture.outside, 'new.txt'), content: 'new' }),
    /outside the Project roots/,
  )
})

test('full access allows Edit and Write in an unregistered absolute directory', async t => {
  const fixture = await createFixture(t)
  const existingPath = join(fixture.outside, 'existing.txt')
  await writeFile(existingPath, 'before\n')
  const tools = createFilesystemTools(fixture.project, 'full')
  const edit = requireNamedTool(tools, 'Edit')
  const write = requireNamedTool(tools, 'Write')

  const editResult = await executeJson(edit, {
    path: existingPath,
    oldText: 'before',
    newText: 'after',
  })
  assert.equal(Reflect.get(editResult as object, 'path'), existingPath)
  assert.equal(await readFile(existingPath, 'utf8'), 'after\n')

  const writeResult = await executeJson(write, {
    path: join(fixture.outside, 'created.txt'),
    content: 'created\n',
  })
  assert.equal(Reflect.get(writeResult as object, 'path'), join(fixture.outside, 'created.txt'))
  assert.equal(await readFile(join(fixture.outside, 'created.txt'), 'utf8'), 'created\n')
})

test('Read returns absolute paths and supports Primary and Attached Roots', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.primary, 'notes.txt'), 'one\ntwo\nthree\nfour\n')
  await writeFile(join(fixture.attached, 'shared.txt'), 'attached\n')
  const read = requireTool(fixture.project, 'Read')

  const notesPath = join(fixture.primary, 'notes.txt')
  const sharedPath = join(fixture.attached, 'shared.txt')
  assert.deepEqual(await executeJson(read, { path: notesPath, offset: 2, limit: 2 }), {
    path: notesPath,
    lines: [
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
    ],
    truncated: true,
    totalLines: 4,
  })
  assert.deepEqual(await executeJson(read, { path: sharedPath }), {
    path: sharedPath,
    lines: [{ line: 1, text: 'attached' }],
    truncated: false,
    totalLines: 1,
  })
})

test('Read reports the total line count so the remaining range can be requested in one call', async t => {
  const fixture = await createFixture(t)
  await writeFile(
    join(fixture.primary, 'long.txt'),
    Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n'),
  )
  const read = requireTool(fixture.project, 'Read')
  const path = join(fixture.primary, 'long.txt')

  const first = await executeJson(read, { path, limit: 10 })
  assert.deepEqual(first, {
    path,
    lines: Array.from({ length: 10 }, (_, index) => ({
      line: index + 1,
      text: `line ${index + 1}`,
    })),
    truncated: true,
    totalLines: 30,
  })

  const rest = await executeJson(read, { path, offset: 11, limit: 20 })
  assert.deepEqual(rest, {
    path,
    lines: Array.from({ length: 20 }, (_, index) => ({
      line: index + 11,
      text: `line ${index + 11}`,
    })),
    truncated: false,
    totalLines: 30,
  })
})

test('Read rejects relative and absolute paths outside scoped Project Roots', async t => {
  const fixture = await createFixture(t)
  const outsideFile = join(fixture.outside, 'secret.txt')
  await writeFile(outsideFile, 'secret')
  await symlink(outsideFile, join(fixture.primary, 'escape.txt'))
  const read = requireTool(fixture.project, 'Read')

  await assert.rejects(read.execute({ path: '../outside/secret.txt' }), /must be absolute/)
  await assert.rejects(
    read.execute({ path: join(fixture.primary, 'escape.txt') }),
    /outside the Project roots/,
  )
  await assert.rejects(read.execute({ path: outsideFile }), /outside the Project roots/)
})

test('full access accepts an absolute file outside Project Roots', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.outside, 'note.txt'), 'outside content\n')
  const read = createFilesystemTools(fixture.project, 'full').find(
    candidate => candidate.description.name === 'Read',
  )
  assert.ok(read)

  const path = join(fixture.outside, 'note.txt')
  assert.deepEqual(await executeJson(read, { path }), {
    path,
    lines: [{ line: 1, text: 'outside content' }],
    truncated: false,
    totalLines: 1,
  })
})

test('Glob returns sorted absolute files and excludes dependency output', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'src'))
  await mkdir(join(fixture.primary, 'node_modules'))
  await Promise.all([
    writeFile(join(fixture.primary, 'src', 'b.ts'), ''),
    writeFile(join(fixture.primary, 'src', 'a.ts'), ''),
    writeFile(join(fixture.primary, 'node_modules', 'ignored.ts'), ''),
  ])
  const glob = requireTool(fixture.project, 'Glob')

  assert.deepEqual(await executeJson(glob, { path: fixture.primary, pattern: '**/*.ts' }), {
    path: fixture.primary,
    pattern: '**/*.ts',
    files: [join(fixture.primary, 'src', 'a.ts'), join(fixture.primary, 'src', 'b.ts')],
    truncated: false,
  })
})

test('Glob lists directories when includeDirectories is set', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'src'))
  await mkdir(join(fixture.primary, 'docs'))
  await Promise.all([
    writeFile(join(fixture.primary, 'README.md'), ''),
    writeFile(join(fixture.primary, 'src', 'a.ts'), ''),
  ])
  const globTool = requireTool(fixture.project, 'Glob')

  const listed = await executeJson(globTool, {
    path: fixture.primary,
    pattern: '*',
    includeDirectories: true,
  })
  assert.deepEqual(listed, {
    path: fixture.primary,
    pattern: '*',
    files: [join(fixture.primary, 'README.md')],
    directories: [join(fixture.primary, 'docs'), join(fixture.primary, 'src')],
    truncated: false,
  })

  const filesOnly = await executeJson(globTool, { path: fixture.primary, pattern: '*' })
  assert.deepEqual(filesOnly, {
    path: fixture.primary,
    pattern: '*',
    files: [join(fixture.primary, 'README.md')],
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
    path: fixture.primary,
    pattern: 'agent',
    glob: '**/*.ts',
    caseSensitive: false,
    maxResults: 2,
  })

  assert.deepEqual(result, {
    path: fixture.primary,
    pattern: 'agent',
    matches: [
      { path: join(fixture.primary, 'src', 'a.ts'), line: 1, text: 'Agent runtime', kind: 'match' },
      { path: join(fixture.primary, 'src', 'a.ts'), line: 2, text: 'agent loop', kind: 'match' },
    ],
    limitReached: true,
  })
})

test('Grep returns surrounding context lines around matches', async t => {
  const fixture = await createFixture(t)
  await writeFile(
    join(fixture.primary, 'a.ts'),
    'one\ntwo\nAgent\nfour\nfive\nsix\n',
  )
  const grep = requireTool(fixture.project, 'Grep')

  const result = await executeJson(grep, {
    path: fixture.primary,
    pattern: 'Agent',
    before: 1,
    after: 2,
  })

  assert.deepEqual(result, {
    path: fixture.primary,
    pattern: 'Agent',
    matches: [
      { path: join(fixture.primary, 'a.ts'), line: 2, text: 'two', kind: 'context' },
      { path: join(fixture.primary, 'a.ts'), line: 3, text: 'Agent', kind: 'match' },
      { path: join(fixture.primary, 'a.ts'), line: 4, text: 'four', kind: 'context' },
      { path: join(fixture.primary, 'a.ts'), line: 5, text: 'five', kind: 'context' },
    ],
    limitReached: false,
  })
})

test('Grep counts only matching lines toward the result limit', async t => {
  const fixture = await createFixture(t)
  await Promise.all([
    writeFile(join(fixture.primary, 'a.ts'), 'one\nAgent\nthree\n'),
    writeFile(join(fixture.primary, 'b.ts'), 'uno\nAgent\ntres\n'),
  ])
  const grep = requireTool(fixture.project, 'Grep')

  const result = await executeJson(grep, {
    path: fixture.primary,
    pattern: 'Agent',
    after: 1,
    maxResults: 1,
  })

  assert.deepEqual(result, {
    path: fixture.primary,
    pattern: 'Agent',
    matches: [
      { path: join(fixture.primary, 'a.ts'), line: 2, text: 'Agent', kind: 'match' },
      { path: join(fixture.primary, 'a.ts'), line: 3, text: 'three', kind: 'context' },
    ],
    limitReached: true,
  })
})

test('Grep rejects out-of-range context parameters', async t => {
  const fixture = await createFixture(t)
  const grep = requireTool(fixture.project, 'Grep')

  await assert.rejects(
    grep.execute({ path: fixture.primary, pattern: 'Agent', before: 51 }),
    /before must be an integer from 1 through 50/,
  )
  await assert.rejects(
    grep.execute({ path: fixture.primary, pattern: 'Agent', after: 0 }),
    /after must be an integer from 1 through 50/,
  )
})

test('Grep reports invalid regular expressions as tool errors', async t => {
  const fixture = await createFixture(t)
  const grep = requireTool(fixture.project, 'Grep')

  await assert.rejects(grep.execute({ path: fixture.primary, pattern: '[' }), /Grep failed/)
})

function requireTool(project: AgentProject, name: string): Tool {
  return requireNamedTool(createFilesystemTools(project), name)
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'code-harness-project-')))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  const attached = join(directory, 'attached')
  const outside = join(directory, 'outside')
  await Promise.all([mkdir(primary), mkdir(attached), mkdir(outside)])
  return {
    project: {
      id: 'project-1',
      name: 'project',
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
