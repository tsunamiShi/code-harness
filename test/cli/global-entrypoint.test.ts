import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const entrypoint = fileURLToPath(new URL('../../bin/ai-agent.mjs', import.meta.url))

test('ai-agent help lists every supported command without starting the runtime', () => {
  const result = run('help')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /AI Agent CLI/)
  assert.match(result.stdout, /project create/)
  assert.match(result.stdout, /project list/)
  assert.match(result.stdout, /project show/)
  assert.match(result.stdout, /project attach/)
  assert.match(result.stdout, /help project create/)
})

test('ai-agent help provides detailed chat and project command topics', () => {
  const chat = run('help', 'chat')
  const create = run('help', 'project', 'create')
  const flag = run('project', 'attach', '--help')

  assert.equal(chat.status, 0)
  assert.match(chat.stdout, /current directory becomes the Project primary root/)
  assert.match(chat.stdout, /--mcp-config <path>/)
  assert.equal(create.status, 0)
  assert.match(create.stdout, /--primary <path>/)
  assert.match(create.stdout, /--root <path>/)
  assert.equal(flag.status, 0)
  assert.match(flag.stdout, /project attach <project-id> --path <directory>/)

  for (const topic of [
    ['project'],
    ['project', 'list'],
    ['project', 'show'],
    ['project', 'attach'],
  ]) {
    const result = run('help', ...topic)
    assert.equal(result.status, 0, `help topic failed: ${topic.join(' ')}`)
    assert.match(result.stdout, /Usage:/)
  }
})

test('ai-agent help rejects an unknown topic without opening the database', () => {
  const result = run('help', 'unknown')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown help topic: unknown/)
  assert.match(result.stderr, /ai-agent help/)
})

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [entrypoint, ...arguments_], {
    encoding: 'utf8',
  })
}
