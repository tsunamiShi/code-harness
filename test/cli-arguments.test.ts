import assert from 'node:assert/strict'
import test from 'node:test'

import { readChatTarget } from '../src/cli-arguments.ts'

test('accepts the pnpm argument separator passed through to the chat script', () => {
  assert.deepEqual(readChatTarget(['--', '--project', 'project-1']), {
    kind: 'project',
    id: 'project-1',
  })
})

test('accepts a session target without a retained separator', () => {
  assert.deepEqual(readChatTarget(['--session', 'session-1']), {
    kind: 'session',
    id: 'session-1',
  })
})
