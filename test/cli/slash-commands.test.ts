import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentSessionSummary } from '../../src/runtime/session-store.ts'
import {
  completeSlashCommand,
  selectProjectSession,
  slashCommandHelp,
} from '../../src/cli/slash-commands.ts'

test('completes slash command names and shows every command', () => {
  assert.deepEqual(completeSlashCommand('/r'), [['/resume', '/retry'], '/r'])
  assert.deepEqual(completeSlashCommand('hello'), [[], 'hello'])
  assert.match(slashCommandHelp(), /\/resume/)
  assert.match(slashCommandHelp(), /\/retry/)
  assert.match(slashCommandHelp(), /\/help/)
  assert.match(slashCommandHelp(), /\/exit/)
})

test('selects a Session from the current Project and excludes the current Session', async () => {
  const output: string[] = []
  const selected = await selectProjectSession({
    sessions: [
      session('current', 0),
      session('newer', 2, 'second prompt', 'completed'),
      session('older', 1, 'first prompt', 'failed'),
    ],
    currentSessionId: 'current',
    ask: async () => '2',
    write: text => output.push(text),
  })

  assert.equal(selected, 'older')
  assert.doesNotMatch(output.join('\n'), /\. current ·/)
  assert.match(output.join('\n'), /newer.*2 Turns.*completed.*second prompt/)
  assert.match(output.join('\n'), /older.*1 Turn.*failed.*first prompt/)
})

test('cancels or rejects Session selection without switching', async () => {
  const output: string[] = []
  assert.equal(await selectProjectSession({
    sessions: [session('current', 0)],
    currentSessionId: 'current',
    ask: async () => assert.fail('selection prompt should not open'),
    write: text => output.push(text),
  }), undefined)
  assert.match(output[0] ?? '', /No other Sessions/)

  assert.equal(await selectProjectSession({
    sessions: [session('candidate', 1)],
    currentSessionId: 'current',
    ask: async () => 'invalid',
    write: text => output.push(text),
  }), undefined)
  assert.match(output.at(-1) ?? '', /Invalid Session selection/)
})

function session(
  id: string,
  turnCount: number,
  lastPrompt?: string,
  lastTurnStatus?: AgentSessionSummary['lastTurnStatus'],
): AgentSessionSummary {
  return {
    id,
    turnCount,
    ...(lastPrompt === undefined ? {} : { lastPrompt }),
    ...(lastTurnStatus === undefined ? {} : { lastTurnStatus }),
    updatedAt: new Date('2026-09-26T03:00:00.000Z'),
  }
}
