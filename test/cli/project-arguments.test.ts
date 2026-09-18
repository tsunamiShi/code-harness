import assert from 'node:assert/strict'
import test from 'node:test'

import { readProjectCommand } from '../../src/cli/project-arguments.ts'

test('parses an Attached Root command', () => {
  assert.deepEqual(
    readProjectCommand(['attach', 'project-1', '--path', '/project/shared']),
    { kind: 'attach', projectId: 'project-1', path: '/project/shared' },
  )
})

test('rejects incomplete Attached Root commands', () => {
  assert.throws(
    () => readProjectCommand(['attach', 'project-1']),
    /pnpm project attach <project-id> --path <directory>/,
  )
})
