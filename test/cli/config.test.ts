import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentMcpConfigPathFromEnvironment,
  agentMaxTokensFromEnvironment,
  agentLoopGuardModelFromEnvironment,
  agentLoopGuardThresholdsFromEnvironment,
  agentNoProgressThresholdsFromEnvironment,
  agentTraceMaxResultCharsFromEnvironment,
  agentTraceModeFromEnvironment,
} from '../../src/cli/config.ts'

test('uses an explicit MCP config before the environment fallback', () => {
  const previous = process.env.AGENT_MCP_CONFIG
  try {
    process.env.AGENT_MCP_CONFIG = '/environment/.mcp.json'
    assert.equal(agentMcpConfigPathFromEnvironment('/cli/.mcp.json'), '/cli/.mcp.json')
    assert.equal(agentMcpConfigPathFromEnvironment(), '/environment/.mcp.json')

    process.env.AGENT_MCP_CONFIG = ''
    assert.throws(agentMcpConfigPathFromEnvironment, /Invalid AGENT_MCP_CONFIG/)
  } finally {
    if (previous === undefined) delete process.env.AGENT_MCP_CONFIG
    else process.env.AGENT_MCP_CONFIG = previous
  }
})

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

test('configures Loop Guard repeat thresholds and its independent model', () => {
  const previousThresholds = process.env.AGENT_LOOP_GUARD_THRESHOLDS
  const previousModel = process.env.DASHSCOPE_GUARD_MODEL
  try {
    delete process.env.AGENT_LOOP_GUARD_THRESHOLDS
    delete process.env.DASHSCOPE_GUARD_MODEL
    assert.deepEqual(agentLoopGuardThresholdsFromEnvironment(), [3, 5, 8])
    assert.equal(agentLoopGuardModelFromEnvironment(), 'ZHIPU/GLM-5.3-Flash')

    process.env.AGENT_LOOP_GUARD_THRESHOLDS = '8, 3, 5'
    process.env.DASHSCOPE_GUARD_MODEL = 'guard-model'
    assert.deepEqual(agentLoopGuardThresholdsFromEnvironment(), [3, 5, 8])
    assert.equal(agentLoopGuardModelFromEnvironment(), 'guard-model')

    process.env.AGENT_LOOP_GUARD_THRESHOLDS = '1,3'
    assert.throws(
      agentLoopGuardThresholdsFromEnvironment,
      /Invalid AGENT_LOOP_GUARD_THRESHOLDS/,
    )
  } finally {
    if (previousThresholds === undefined) delete process.env.AGENT_LOOP_GUARD_THRESHOLDS
    else process.env.AGENT_LOOP_GUARD_THRESHOLDS = previousThresholds
    if (previousModel === undefined) delete process.env.DASHSCOPE_GUARD_MODEL
    else process.env.DASHSCOPE_GUARD_MODEL = previousModel
  }
})

test('configures deterministic no-progress reminder thresholds', () => {
  const previous = process.env.AGENT_NO_PROGRESS_THRESHOLDS
  try {
    delete process.env.AGENT_NO_PROGRESS_THRESHOLDS
    assert.deepEqual(agentNoProgressThresholdsFromEnvironment(), [12, 24])

    process.env.AGENT_NO_PROGRESS_THRESHOLDS = '24, 12'
    assert.deepEqual(agentNoProgressThresholdsFromEnvironment(), [12, 24])

    process.env.AGENT_NO_PROGRESS_THRESHOLDS = '0,12'
    assert.throws(
      agentNoProgressThresholdsFromEnvironment,
      /Invalid AGENT_NO_PROGRESS_THRESHOLDS/,
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_NO_PROGRESS_THRESHOLDS
    else process.env.AGENT_NO_PROGRESS_THRESHOLDS = previous
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

test('limits the displayed Tool Result preview independently of stored content', () => {
  const previous = process.env.AGENT_TRACE_MAX_RESULT_CHARS
  try {
    delete process.env.AGENT_TRACE_MAX_RESULT_CHARS
    assert.equal(agentTraceMaxResultCharsFromEnvironment(), 800)

    process.env.AGENT_TRACE_MAX_RESULT_CHARS = '1200'
    assert.equal(agentTraceMaxResultCharsFromEnvironment(), 1200)

    process.env.AGENT_TRACE_MAX_RESULT_CHARS = '0'
    assert.throws(
      agentTraceMaxResultCharsFromEnvironment,
      /Invalid AGENT_TRACE_MAX_RESULT_CHARS/,
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_TRACE_MAX_RESULT_CHARS
    else process.env.AGENT_TRACE_MAX_RESULT_CHARS = previous
  }
})
