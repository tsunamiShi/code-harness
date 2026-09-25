import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { AgentSession } from '../../src/runtime/agent-session.ts'
import type { Model, Tool } from '../../src/runtime/types.ts'
import { MemorySessionStore } from '../../src/storage/memory-session-store.ts'
import { connectMcpTools } from '../../src/tools/mcp-tools.ts'

test('connects a stdio server, discovers tools, calls them, and closes idempotently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-mcp-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, '.mcp.json')
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      fixture: {
        type: 'stdio',
        command: resolve('node_modules/.bin/tsx'),
        args: [resolve('test/fixtures/mcp-echo-server.ts')],
        cwd: '${workspaceFolder}',
        env: { MCP_TEST_PREFIX: '${MCP_TEST_PREFIX}' },
        timeoutMs: 5_000,
      },
    },
  }))

  const toolSet = await connectMcpTools({
    configPath,
    workspaceFolder: directory,
    environment: { ...process.env, MCP_TEST_PREFIX: 'configured' },
  })
  t.after(async () => await toolSet.close())

  assert.equal(toolSet.configPath, configPath)
  assert.deepEqual(toolSet.servers, [{ name: 'fixture', transport: 'stdio', toolCount: 3 }])
  assert.deepEqual(
    toolSet.tools.map(tool => tool.description.name),
    ['mcp__fixture__echo', 'mcp__fixture__inspect', 'mcp__fixture__fail'],
  )
  assert.equal(requireTool(toolSet.tools, 'mcp__fixture__echo').effect, 'observe')
  assert.equal(requireTool(toolSet.tools, 'mcp__fixture__fail').effect, 'execute')

  assert.equal(
    await requireTool(toolSet.tools, 'mcp__fixture__echo').execute({ text: 'hello' }),
    'configured:hello',
  )
  assert.deepEqual(
    JSON.parse(await requireTool(toolSet.tools, 'mcp__fixture__inspect').execute({})),
    {
      content: [{ type: 'text', text: 'structured' }],
      structuredContent: { ok: true },
    },
  )

  let modelInvocation = 0
  const model: Model = {
    async generate(input) {
      modelInvocation += 1
      if (modelInvocation === 1) {
        assert.ok(input.tools.some(tool => tool.name === 'mcp__fixture__echo'))
        return {
          kind: 'tool-calls',
          calls: [{ id: 'mcp-call-1', name: 'mcp__fixture__echo', arguments: { text: 'agent' } }],
        }
      }
      assert.deepEqual(input.messages.at(-1), {
        role: 'tool',
        toolCallId: 'mcp-call-1',
        content: 'configured:agent',
      })
      return { kind: 'final', content: 'MCP completed' }
    },
  }
  const session = await AgentSession.create({
    model,
    tools: toolSet.tools,
    store: new MemorySessionStore(),
  })
  assert.equal(await session.send('Use the MCP echo tool'), 'MCP completed')

  await assert.rejects(
    requireTool(toolSet.tools, 'mcp__fixture__fail').execute({}),
    /reported an error: requested failure/,
  )
  await assert.rejects(
    requireTool(toolSet.tools, 'mcp__fixture__echo').execute('invalid'),
    /arguments for MCP tool fixture\.echo must be an object/,
  )

  await toolSet.close()
  await toolSet.close()
})

test('supports VS Code server maps, disabled entries, defaults, and environment fallbacks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-mcp-config-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'mcp.json')
  await writeFile(configPath, JSON.stringify({
    servers: {
      disabled: {
        type: 'stdio',
        command: 'does-not-run',
        disabled: true,
      },
    },
  }))

  const toolSet = await connectMcpTools({
    configPath,
    workspaceFolder: directory,
    environment: {},
  })
  assert.deepEqual(toolSet.servers, [])
  assert.deepEqual(toolSet.tools, [])
  await toolSet.close()
})

test('rejects ambiguous configs and missing environment variables before starting servers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-mcp-invalid-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const ambiguousPath = join(directory, 'ambiguous.json')
  await writeFile(ambiguousPath, JSON.stringify({ mcpServers: {}, servers: {} }))
  await assert.rejects(
    connectMcpTools({ configPath: ambiguousPath, workspaceFolder: directory }),
    /either "mcpServers" or "servers", not both/,
  )

  const missingEnvironmentPath = join(directory, 'missing-env.json')
  await writeFile(missingEnvironmentPath, JSON.stringify({
    mcpServers: {
      fixture: {
        command: '${MISSING_MCP_COMMAND}',
      },
    },
  }))
  await assert.rejects(
    connectMcpTools({
      configPath: missingEnvironmentPath,
      workspaceFolder: directory,
      environment: {},
    }),
    /Missing environment variable MISSING_MCP_COMMAND/,
  )
})

function requireTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find(candidate => candidate.description.name === name)
  assert.ok(tool)
  return tool
}
