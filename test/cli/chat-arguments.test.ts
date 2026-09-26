import assert from 'node:assert/strict'
import test from 'node:test'

import { readChatTarget } from '../../src/cli/chat-arguments.ts'

test('uses the current directory when no explicit target is provided', () => {
  assert.deepEqual(readChatTarget([], '/Users/example/project'), {
    kind: 'directory',
    path: '/Users/example/project',
    accessMode: 'scoped',
  })
})

test('allows current-directory chat options without an explicit target', () => {
  assert.deepEqual(
    readChatTarget(['--full-access', '--mcp-config', '/tmp/project.mcp.json'], '/project'),
    {
      kind: 'directory',
      path: '/project',
      accessMode: 'full',
      mcpConfigPath: '/tmp/project.mcp.json',
    },
  )
})

test('accepts the pnpm argument separator passed through to the chat script', () => {
  assert.deepEqual(readChatTarget(['--', '--project', 'project-1']), {
    kind: 'project',
    id: 'project-1',
    accessMode: 'scoped',
  })
})

test('accepts a session target without a retained separator', () => {
  assert.deepEqual(readChatTarget(['--session', 'session-1']), {
    kind: 'session',
    id: 'session-1',
    accessMode: 'scoped',
  })
})

test('enables full filesystem access for one CLI process', () => {
  assert.deepEqual(readChatTarget(['--session', 'session-1', '--full-access']), {
    kind: 'session',
    id: 'session-1',
    accessMode: 'full',
  })
})

test('accepts an explicit MCP config in either flag order', () => {
  assert.deepEqual(
    readChatTarget([
      '--mcp-config',
      '/tmp/project.mcp.json',
      '--project',
      'project-1',
      '--full-access',
    ]),
    {
      kind: 'project',
      id: 'project-1',
      accessMode: 'full',
      mcpConfigPath: '/tmp/project.mcp.json',
    },
  )
})

test('rejects duplicate or incomplete MCP config arguments', () => {
  assert.throws(
    () => readChatTarget(['--project', 'project-1', '--mcp-config']),
    /Usage:/,
  )
  assert.throws(
    () => readChatTarget([
      '--project',
      'project-1',
      '--mcp-config',
      'one.json',
      '--mcp-config',
      'two.json',
    ]),
    /Usage:/,
  )
})
