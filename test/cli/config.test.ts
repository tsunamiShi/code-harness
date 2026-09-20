import assert from 'node:assert/strict'
import test from 'node:test'

import { agentMaxTokensFromEnvironment } from '../../src/cli/config.ts'

test('reads a per-model-invocation output token limit from the environment', () => {
  const previous = process.env.AGENT_MAX_TOKENS
  try {
    delete process.env.AGENT_MAX_TOKENS
    assert.equal(agentMaxTokensFromEnvironment(), 4096)

    process.env.AGENT_MAX_TOKENS = '16384'
    assert.equal(agentMaxTokensFromEnvironment(), 16384)

    process.env.AGENT_MAX_TOKENS = '0'
    assert.throws(agentMaxTokensFromEnvironment, /Invalid AGENT_MAX_TOKENS/)
  } finally {
    if (previous === undefined) delete process.env.AGENT_MAX_TOKENS
    else process.env.AGENT_MAX_TOKENS = previous
  }
})
