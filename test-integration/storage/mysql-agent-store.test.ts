import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import mysql, { type RowDataPacket } from 'mysql2/promise'

import { ProjectCatalog } from '../../src/projects/project.ts'
import { AgentSession } from '../../src/runtime/agent-session.ts'
import type { Message, Model, Tool } from '../../src/runtime/types.ts'
import {
  MysqlAgentStore,
  type MysqlAgentStoreOptions,
} from '../../src/storage/mysql-agent-store.ts'

test('persists and restores a tool-using conversation in MySQL', async () => {
  const database = `ai_agent_test_${randomUUID().replaceAll('-', '')}`
  const connection = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? '3306'),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
  }
  const admin = await mysql.createConnection(connection)
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  )

  const options: MysqlAgentStoreOptions = { ...connection, database }
  let store: MysqlAgentStore | undefined
  const attachedDirectory = await mkdtemp(join(tmpdir(), 'ai-agent-attached-'))
  try {
    store = await MysqlAgentStore.connect(options)
    const project = await new ProjectCatalog(store).create({
      name: 'integration-project',
      primaryPath: process.cwd(),
      additionalPaths: ['..'],
    })
    const updatedProject = await new ProjectCatalog(store).attach(project.id, attachedDirectory)
    assert.deepEqual(updatedProject.roots.at(-1), {
      path: await realpath(attachedDirectory),
      role: 'attached',
    })
    let request = 0
    const model: Model = {
      descriptor: {
        provider: 'integration-provider',
        model: 'integration-model',
        protocol: 'test',
        requestTimeoutMs: 1_000,
        maxRetries: 1,
      },
      async generate(input) {
        request += 1
        await input.onAttempt?.({ type: 'started', attempt: 1 })
        await input.onAttempt?.({
          type: 'headers-received',
          attempt: 1,
          httpStatus: 200,
          durationMs: 12,
          providerRequestId: `provider-request-${request}`,
        })
        await input.onAttempt?.({
          type: 'first-event',
          attempt: 1,
          eventType: 'response.created',
          durationMs: 14,
        })
        await input.onAttempt?.({
          type: 'completed',
          attempt: 1,
          httpStatus: 200,
          durationMs: 25,
          eventCount: 8,
          providerRequestId: `provider-request-${request}`,
        })
        return request === 1
          ? {
              kind: 'tool-calls',
              calls: [
                { id: 'call-1', name: 'search', arguments: { query: 'agent' } },
                { id: 'call-2', name: 'search', arguments: { query: 'runtime' } },
              ],
              metadata: {
                providerResponseId: 'response-1',
                providerRequestId: 'provider-request-1',
                finishReason: 'tool_calls',
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
            }
          : {
              kind: 'final',
              content: '第一轮完成',
              metadata: {
                providerResponseId: 'response-2',
                providerRequestId: 'provider-request-2',
                finishReason: 'stop',
                usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
              },
            }
      },
    }
    const search: Tool = {
      effect: 'observe',
      parallelSafe: true,
      description: {
        name: 'search',
        description: 'Search test data.',
        parameters: { type: 'object' },
      },
      async execute() {
        return '测试结果'
      },
    }
    const first = await AgentSession.create({
      model,
      tools: [search],
      store,
      project: updatedProject,
    })
    await first.send('第一轮')
    const sessionId = first.id
    const snapshot = await store.loadSession(sessionId)
    assert.equal(snapshot?.projectId, project.id)
    assert.equal(snapshot?.turns.length, 1)
    assert.equal(snapshot?.turns[0]?.steps.length, 2)
    assert.equal(snapshot?.turns[0]?.status, 'completed')
    const toolStep = snapshot?.turns[0]?.steps[0]
    assert.equal(toolStep?.output.kind, 'tool-calls')
    if (toolStep?.output.kind === 'tool-calls') {
      assert.equal(toolStep.output.executions.length, 2)
    }
    assert.equal(toolStep?.providerResponseId, 'response-1')
    assert.equal(snapshot?.turns[0]?.steps[1]?.providerResponseId, 'response-2')
    const [invocationRows] = await admin.query<(RowDataPacket & {
      status: string
      provider_name: string
      model_name: string
      input_tokens: number
      total_tokens: number
      max_tokens: number | null
    })[]>(
      `SELECT status, provider_name, model_name, input_tokens, total_tokens, max_tokens
       FROM \`${database}\`.agent_model_invocations
       WHERE turn_id = ? ORDER BY step_number`,
      [snapshot?.turns[0]?.id],
    )
    assert.deepEqual(invocationRows.map(row => ({ ...row })), [
      {
        status: 'completed',
        provider_name: 'integration-provider',
        model_name: 'integration-model',
        input_tokens: 10,
        total_tokens: 15,
        max_tokens: null,
      },
      {
        status: 'completed',
        provider_name: 'integration-provider',
        model_name: 'integration-model',
        input_tokens: 20,
        total_tokens: 24,
        max_tokens: null,
      },
    ])
    const [attemptRows] = await admin.query<(RowDataPacket & {
      attempt_number: number
      status: string
      phase: string
      http_status: number
      provider_request_id: string
      headers_latency_ms: number
      first_event_latency_ms: number
      first_event_type: string
      duration_ms: number
      event_count: number
    })[]>(
      `SELECT a.attempt_number, a.status, a.phase, a.http_status, a.provider_request_id,
              a.headers_latency_ms, a.first_event_latency_ms, a.first_event_type,
              a.duration_ms, a.event_count
       FROM \`${database}\`.agent_model_attempts AS a
       INNER JOIN \`${database}\`.agent_model_invocations AS i ON i.id = a.invocation_id
       WHERE i.turn_id = ? ORDER BY i.step_number, a.attempt_number`,
      [snapshot?.turns[0]?.id],
    )
    assert.deepEqual(attemptRows.map(row => ({ ...row })), [
      {
        attempt_number: 1,
        status: 'completed',
        phase: 'completed',
        http_status: 200,
        provider_request_id: 'provider-request-1',
        headers_latency_ms: 12,
        first_event_latency_ms: 14,
        first_event_type: 'response.created',
        duration_ms: 25,
        event_count: 8,
      },
      {
        attempt_number: 1,
        status: 'completed',
        phase: 'completed',
        http_status: 200,
        provider_request_id: 'provider-request-2',
        headers_latency_ms: 12,
        first_event_latency_ms: 14,
        first_event_type: 'response.created',
        duration_ms: 25,
        event_count: 8,
      },
    ])

    const failedTransport = await AgentSession.create({
      model: {
        async generate(input) {
          await input.onAttempt?.({ type: 'started', attempt: 1 })
          await input.onAttempt?.({
            type: 'failed',
            attempt: 1,
            phase: 'requesting',
            durationMs: 300_000,
            eventCount: 0,
            errorName: 'TypeError',
            errorMessage: 'fetch failed',
            causeName: 'HeadersTimeoutError',
            causeCode: 'UND_ERR_HEADERS_TIMEOUT',
            causeMessage: 'Headers Timeout Error',
          })
          throw new Error('provider unavailable')
        },
      },
      tools: [],
      store,
      project: updatedProject,
    })
    await assert.rejects(failedTransport.send('capture transport failure'), /provider unavailable/)
    const failedSnapshot = await store.loadSession(failedTransport.id)
    const [failedAttemptRows] = await admin.query<(RowDataPacket & {
      status: string
      phase: string
      failure_phase: string
      duration_ms: number
      event_count: number
      error_cause_name: string
      error_cause_code: string
      error_cause_message: string
    })[]>(
      `SELECT a.status, a.phase, a.failure_phase, a.duration_ms, a.event_count,
              a.error_cause_name, a.error_cause_code, a.error_cause_message
       FROM \`${database}\`.agent_model_attempts AS a
       INNER JOIN \`${database}\`.agent_model_invocations AS i ON i.id = a.invocation_id
       WHERE i.turn_id = ?`,
      [failedSnapshot?.turns[0]?.id],
    )
    assert.deepEqual(failedAttemptRows.map(row => ({ ...row })), [{
      status: 'failed',
      phase: 'failed',
      failure_phase: 'requesting',
      duration_ms: 300_000,
      event_count: 0,
      error_cause_name: 'HeadersTimeoutError',
      error_cause_code: 'UND_ERR_HEADERS_TIMEOUT',
      error_cause_message: 'Headers Timeout Error',
    }])

    await store.close()
    store = await MysqlAgentStore.connect(options)
    const restoredProject = await new ProjectCatalog(store).get(project.id)
    assert.deepEqual(restoredProject, updatedProject)
    let restoredMessages: readonly Message[] = []
    let restoredResponseId: string | undefined
    const resumed = await AgentSession.resume(sessionId, {
      model: {
        async generate(input) {
          restoredMessages = structuredClone(input.messages)
          restoredResponseId = input.previousResponseId
          return { kind: 'final', content: '第二轮完成' }
        },
      },
      tools: [search],
      store,
      project: restoredProject,
    })
    await resumed.send('第二轮')

    assert.equal(restoredResponseId, 'response-2')
    assert.deepEqual(restoredMessages, [
      { role: 'user', content: '第二轮' },
    ])

    let recoveryRequest = 0
    const interrupted = await AgentSession.create({
      model: {
        async generate() {
          recoveryRequest += 1
          if (recoveryRequest === 1) {
            return {
              kind: 'tool-calls',
              calls: [{ id: 'recovery-search', name: 'search', arguments: { query: 'saved' } }],
            }
          }
          throw new Error('provider disconnected')
        },
      },
      tools: [search],
      store,
      project: restoredProject,
      maxTokens: 2048,
    })
    await assert.rejects(interrupted.send('recover this Turn'), /provider disconnected/)
    const interruptedId = interrupted.id

    await store.close()
    store = await MysqlAgentStore.connect(options)
    let recoveryMessages: readonly Message[] = []
    const recovered = await AgentSession.resume(interruptedId, {
      model: {
        async generate(input) {
          recoveryMessages = structuredClone(input.messages)
          return { kind: 'final', content: 'recovered result' }
        },
      },
      tools: [search],
      store,
      project: restoredProject,
      maxTokens: 2048,
    })
    assert.equal(await recovered.continueTurn(), 'recovered result')
    assert.deepEqual(recoveryMessages.slice(1), [
      { role: 'user', content: 'recover this Turn' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'recovery-search', name: 'search', arguments: { query: 'saved' } }],
      },
      { role: 'tool', toolCallId: 'recovery-search', content: '测试结果' },
    ])

    const recoveredSnapshot = await store.loadSession(interruptedId)
    assert.equal(recoveredSnapshot?.turns[0]?.status, 'completed')
    const [recoveryInvocations] = await admin.query<(RowDataPacket & {
      step_number: number
      invocation_number: number
      status: string
      max_tokens: number
    })[]>(
      `SELECT step_number, invocation_number, status, max_tokens
       FROM \`${database}\`.agent_model_invocations
       WHERE turn_id = ? ORDER BY step_number, invocation_number`,
      [recoveredSnapshot?.turns[0]?.id],
    )
    assert.deepEqual(recoveryInvocations.map(row => ({ ...row })), [
      { step_number: 1, invocation_number: 1, status: 'completed', max_tokens: 2048 },
      { step_number: 2, invocation_number: 1, status: 'failed', max_tokens: 2048 },
      { step_number: 2, invocation_number: 2, status: 'completed', max_tokens: 2048 },
    ])

    let guardedRequests = 0
    const guarded = await AgentSession.create({
      model: {
        async generate(input) {
          guardedRequests += 1
          if (guardedRequests <= 3) {
            return {
              kind: 'tool-calls',
              calls: [{ id: `guard-search-${guardedRequests}`, name: 'search', arguments: { query: 'same' } }],
            }
          }
          assert.equal(input.tools.length, 1)
          assert.equal(input.messages.some(message =>
            message.role === 'user'
            && message.content.includes('Loop Guard reminder')
            && message.content.includes('existing result')
          ), true)
          return { kind: 'final', content: 'guarded result' }
        },
      },
      tools: [search],
      store,
      project: restoredProject,
      loopGuards: [{
        async review(input) {
          if (input.steps.length !== 3) return undefined
          return {
            kind: 'exact-repeat',
            metric: 3,
            summary: 'search × 3',
            content: 'Loop Guard reminder: inspect the existing result.',
          }
        },
      }],
    })
    assert.equal(await guarded.send('Can this be answered?'), 'guarded result')
    const guardedSnapshot = await store.loadSession(guarded.id)
    assert.deepEqual(guardedSnapshot?.turns[0]?.loopGuardReminders, [{
      reminderNumber: 1,
      afterStep: 3,
      kind: 'exact-repeat',
      metric: 3,
      summary: 'search × 3',
      content: 'Loop Guard reminder: inspect the existing result.',
    }])
    const [guardRows] = await admin.query<(RowDataPacket & {
      reminder_number: number
      after_step: number
      reminder_kind: string
      metric: number
      summary: string
      content: string
    })[]>(
      `SELECT reminder_number, after_step, reminder_kind, metric, summary, content
       FROM \`${database}\`.agent_loop_guard_reminders
       WHERE turn_id = ?`,
      [guardedSnapshot?.turns[0]?.id],
    )
    assert.deepEqual(guardRows.map(row => ({ ...row })), [{
      reminder_number: 1,
      after_step: 3,
      reminder_kind: 'exact-repeat',
      metric: 3,
      summary: 'search × 3',
      content: 'Loop Guard reminder: inspect the existing result.',
    }])
  } finally {
    await store?.close()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
    await rm(attachedDirectory, { recursive: true, force: true })
  }
})
