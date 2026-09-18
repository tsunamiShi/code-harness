import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import mysql, { type RowDataPacket } from 'mysql2/promise'

import { ProjectCatalog, projectInstructions } from '../../src/projects/project.ts'
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
          type: 'completed',
          attempt: 1,
          httpStatus: 200,
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
                providerRequestId: 'provider-request-1',
                finishReason: 'tool_calls',
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
            }
          : {
              kind: 'final',
              content: '第一轮完成',
              metadata: {
                providerRequestId: 'provider-request-2',
                finishReason: 'stop',
                usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
              },
            }
      },
    }
    const search: Tool = {
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
    const [invocationRows] = await admin.query<(RowDataPacket & {
      status: string
      provider_name: string
      model_name: string
      input_tokens: number
      total_tokens: number
    })[]>(
      `SELECT status, provider_name, model_name, input_tokens, total_tokens
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
      },
      {
        status: 'completed',
        provider_name: 'integration-provider',
        model_name: 'integration-model',
        input_tokens: 20,
        total_tokens: 24,
      },
    ])
    const [attemptRows] = await admin.query<(RowDataPacket & {
      attempt_number: number
      status: string
      http_status: number
      provider_request_id: string
    })[]>(
      `SELECT a.attempt_number, a.status, a.http_status, a.provider_request_id
       FROM \`${database}\`.agent_model_attempts AS a
       INNER JOIN \`${database}\`.agent_model_invocations AS i ON i.id = a.invocation_id
       WHERE i.turn_id = ? ORDER BY i.step_number, a.attempt_number`,
      [snapshot?.turns[0]?.id],
    )
    assert.deepEqual(attemptRows.map(row => ({ ...row })), [
      {
        attempt_number: 1,
        status: 'completed',
        http_status: 200,
        provider_request_id: 'provider-request-1',
      },
      {
        attempt_number: 1,
        status: 'completed',
        http_status: 200,
        provider_request_id: 'provider-request-2',
      },
    ])

    await store.close()
    store = await MysqlAgentStore.connect(options)
    const restoredProject = await new ProjectCatalog(store).get(project.id)
    assert.deepEqual(restoredProject, updatedProject)
    let restoredMessages: readonly Message[] = []
    const resumed = await AgentSession.resume(sessionId, {
      model: {
        async generate(input) {
          restoredMessages = structuredClone(input.messages)
          return { kind: 'final', content: '第二轮完成' }
        },
      },
      tools: [search],
      store,
      project: restoredProject,
    })
    await resumed.send('第二轮')

    assert.deepEqual(restoredMessages, [
      { role: 'system', content: projectInstructions(restoredProject) },
      { role: 'user', content: '第一轮' },
      {
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', name: 'search', arguments: { query: 'agent' } },
          { id: 'call-2', name: 'search', arguments: { query: 'runtime' } },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: '测试结果' },
      { role: 'tool', toolCallId: 'call-2', content: '测试结果' },
      { role: 'assistant', content: '第一轮完成' },
      { role: 'user', content: '第二轮' },
    ])
  } finally {
    await store?.close()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
    await rm(attachedDirectory, { recursive: true, force: true })
  }
})
