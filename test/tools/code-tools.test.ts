import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentProject } from '../../src/projects/project.ts'
import type { Tool } from '../../src/runtime/types.ts'
import { createCodeTools } from '../../src/tools/code-tools.ts'

test('scoped mode exposes language intelligence but withholds unsandboxed Bash', async t => {
  const fixture = await createFixture(t)

  assert.deepEqual(
    createCodeTools(fixture.project, 'scoped').map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP'],
  )
  assert.deepEqual(
    createCodeTools(fixture.project, 'full').map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'Bash'],
  )
  assert.deepEqual(
    createCodeTools(fixture.project, 'scoped', { webFetch: true }).map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'WebFetch'],
  )
  assert.deepEqual(
    createCodeTools(fixture.project, 'full', { webFetch: true }).map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'WebFetch', 'Bash'],
  )
  assert.deepEqual(
    createCodeTools(fixture.project, 'scoped', {
      webFetch: true,
      webSearch: { apiKey: 'search-key' },
    }).map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch'],
  )
  assert.deepEqual(
    createCodeTools(fixture.project, 'full', {
      webFetch: true,
      webSearch: { apiKey: 'search-key' },
    }).map(tool => tool.description.name),
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch', 'Bash'],
  )
})

test('code Tool schemas expose absolute paths without a root selector', async t => {
  const fixture = await createFixture(t)
  const tools = createCodeTools(fixture.project, 'full')

  for (const tool of tools) {
    const properties = Reflect.get(tool.description.parameters, 'properties')
    assert.ok(typeof properties === 'object' && properties !== null)
    assert.equal(Reflect.has(properties, 'root'), false, tool.description.name)
  }

  const bash = requireTool(tools, 'Bash')
  const bashRequired = Reflect.get(bash.description.parameters, 'required')
  assert.deepEqual(bashRequired, ['cwd', 'command'])
})

test('Bash runs in a selected working directory and returns non-zero exits as results', async t => {
  const fixture = await createFixture(t)
  await mkdir(join(fixture.primary, 'packages'))
  const bash = requireTool(createCodeTools(fixture.project, 'full'), 'Bash')

  const result = await executeJson(bash, {
    cwd: join(fixture.primary, 'packages'),
    command: 'printf "out"; printf "err" >&2; exit 7',
  })

  assert.equal(result.cwd, join(fixture.primary, 'packages'))
  assert.equal(result.exitCode, 7)
  assert.equal(result.timedOut, false)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.stdoutTruncated, false)
  assert.equal(result.stderrTruncated, false)
})

test('Bash terminates commands after the requested timeout', async t => {
  const fixture = await createFixture(t)
  const bash = requireTool(createCodeTools(fixture.project, 'full'), 'Bash')

  const result = await executeJson(bash, {
    cwd: fixture.primary,
    command: 'sleep 5',
    timeoutMs: 20,
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGTERM')
})

test('LSP resolves a TypeScript definition through the language-server protocol', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.primary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['*.ts'],
  }))
  await writeFile(
    join(fixture.primary, 'definition.ts'),
    'export function greet(name: string): string { return `Hello ${name}` }\ngreet("Local")\n',
  )
  await writeFile(
    join(fixture.primary, 'use.ts'),
    "import { greet } from './definition.ts'\ngreet('Agent')\n",
  )
  const lsp = requireTool(createCodeTools(fixture.project), 'LSP')
  t.after(async () => await lsp.close?.())

  const result = await executeJson(lsp, {
    operation: 'definition',
    path: join(fixture.primary, 'use.ts'),
    line: 2,
    column: 2,
  })

  assert.equal(result.operation, 'definition')
  assert.deepEqual(result.position, { line: 2, column: 2 })
  assert.deepEqual(result.locations, [
    {
      path: join(fixture.primary, 'definition.ts'),
      start: { line: 1, column: 17 },
      end: { line: 1, column: 22 },
    },
  ])
  assert.equal(result.truncated, false)

  const references = await executeJson(lsp, {
    operation: 'references',
    path: join(fixture.primary, 'definition.ts'),
    line: 1,
    column: 18,
  })
  assert.ok(Array.isArray(references.locations))
  assert.ok(references.locations.length >= 2)
  assert.match(JSON.stringify(references.locations), /definition\.ts/)

  const hover = await executeJson(lsp, {
    operation: 'hover',
    path: join(fixture.primary, 'use.ts'),
    line: 2,
    column: 2,
  })
  assert.match(JSON.stringify(hover.hover), /greet/)
})

test('LSP routes Vue files through Vue Language Server', async t => {
  const fixture = await createFixture(t)
  await writeFile(join(fixture.primary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true },
    include: ['*.vue'],
  }))
  await writeFile(
    join(fixture.primary, 'Example.vue'),
    [
      '<script setup lang="ts">',
      'function format(value: string): string { return value.toUpperCase() }',
      "const message = format('hello')",
      '</script>',
      '<template><p>{{ message }}</p></template>',
      '',
    ].join('\n'),
  )
  const lsp = requireTool(createCodeTools(fixture.project), 'LSP')
  t.after(async () => await lsp.close?.())

  const result = await executeJson(lsp, {
    operation: 'definition',
    path: join(fixture.primary, 'Example.vue'),
    line: 3,
    column: 18,
  })

  assert.equal(result.languageServer, 'vue-language-server')
  assert.deepEqual(result.locations, [
    {
      path: join(fixture.primary, 'Example.vue'),
      start: { line: 2, column: 10 },
      end: { line: 2, column: 16 },
    },
  ])

  const references = await executeJson(lsp, {
    operation: 'references',
    path: join(fixture.primary, 'Example.vue'),
    line: 2,
    column: 11,
  })
  assert.ok(Array.isArray(references.locations))
  assert.ok(references.locations.length >= 2)

  const hover = await executeJson(lsp, {
    operation: 'hover',
    path: join(fixture.primary, 'Example.vue'),
    line: 3,
    column: 18,
  })
  assert.match(JSON.stringify(hover.hover), /format/)

  await writeFile(
    join(fixture.primary, 'Example.vue'),
    [
      '<script setup lang="ts">',
      'function formatValue(value: string): string { return value.toUpperCase() }',
      "const message = formatValue('hello')",
      '</script>',
      '<template><p>{{ message }}</p></template>',
      '',
    ].join('\n'),
  )
  const changedDefinition = await executeJson(lsp, {
    operation: 'definition',
    path: join(fixture.primary, 'Example.vue'),
    line: 3,
    column: 18,
  })
  assert.deepEqual(changedDefinition.locations, [
    {
      path: join(fixture.primary, 'Example.vue'),
      start: { line: 2, column: 10 },
      end: { line: 2, column: 21 },
    },
  ])
})

function requireTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find(candidate => candidate.description.name === name)
  assert.ok(tool)
  return tool
}

async function executeJson(tool: Tool, input: unknown): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await tool.execute(input))
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function createFixture(t: test.TestContext): Promise<{
  project: AgentProject
  primary: string
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ai-agent-code-tools-')))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const primary = join(directory, 'primary')
  await mkdir(primary)
  return {
    project: {
      id: 'project-1',
      name: 'project',
      roots: [{ path: primary, role: 'primary' }],
    },
    primary,
  }
}
