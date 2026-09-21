import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentMaxTokensFromEnvironment,
  agentTraceModeFromEnvironment,
} from '../../src/cli/config.ts'

test('reads a per-model-invocation output token limit from the environment', () => {
  const previous = process.env.AGENT_MAX_TOKENS
  try {
    delete process.env.AGENT_MAX_TOKENS
    assert.equal(agentMaxTokensFromEnvironment(), undefined)

    process.env.AGENT_MAX_TOKENS = '16384'
    assert.equal(agentMaxTokensFromEnvironment(), 16384)

    process.env.AGENT_MAX_TOKENS = '0'
    assert.throws(agentMaxTokensFromEnvironment, /Invalid AGENT_MAX_TOKENS/)
  } finally {
    if (previous === undefined) delete process.env.AGENT_MAX_TOKENS
    else process.env.AGENT_MAX_TOKENS = previous
  }
})

test('defaults to compact traces and validates explicit trace modes', () => {
  const previous = process.env.AGENT_TRACE
  try {
    delete process.env.AGENT_TRACE
    assert.equal(agentTraceModeFromEnvironment(), 'compact')

    process.env.AGENT_TRACE = 'verbose'
    assert.equal(agentTraceModeFromEnvironment(), 'verbose')

    process.env.AGENT_TRACE = 'hidden'
    assert.throws(agentTraceModeFromEnvironment, /Invalid AGENT_TRACE/)
  } finally {
    if (previous === undefined) delete process.env.AGENT_TRACE
    else process.env.AGENT_TRACE = previous
  }
})
