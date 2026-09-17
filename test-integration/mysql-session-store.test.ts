import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import mysql from 'mysql2/promise'

import { AgentSession } from '../src/agent.ts'
import { MysqlAgentStore, type MysqlAgentStoreOptions } from '../src/mysql-agent-store.ts'
import { ProjectCatalog, projectInstructions } from '../src/project.ts'
import type { Message, Model, Tool } from '../src/types.ts'

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
  try {
    store = await MysqlAgentStore.connect(options)
    const project = await new ProjectCatalog(store).create({
      name: 'integration-project',
      primaryPath: process.cwd(),
      additionalPaths: ['..'],
    })
    let request = 0
    const model: Model = {
      async generate() {
        request += 1
        return request === 1
          ? {
              kind: 'tool-call',
              call: { id: 'call-1', name: 'search', arguments: { query: 'agent' } },
            }
          : { kind: 'final', content: '第一轮完成' }
      },
    }
    const search: Tool = {
      description: {
        name: 'search',
        description: 'Search test data.',
        parameters: { type: 'object' },
      },
      async execute() {
        return '测试结果'
      },
    }
    const first = await AgentSession.create({ model, tools: [search], store, project })
    await first.send('第一轮')
    const sessionId = first.id
    const snapshot = await store.loadSession(sessionId)
    assert.equal(snapshot?.projectId, project.id)
    assert.equal(snapshot?.turns.length, 1)
    assert.equal(snapshot?.turns[0]?.steps.length, 2)
    assert.equal(snapshot?.turns[0]?.status, 'completed')

    await store.close()
    store = await MysqlAgentStore.connect(options)
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
      project,
    })
    await resumed.send('第二轮')

    assert.deepEqual(restoredMessages, [
      { role: 'system', content: projectInstructions(project) },
      { role: 'user', content: '第一轮' },
      {
        role: 'assistant',
        toolCall: { id: 'call-1', name: 'search', arguments: { query: 'agent' } },
      },
      { role: 'tool', toolCallId: 'call-1', content: '测试结果' },
      { role: 'assistant', content: '第一轮完成' },
      { role: 'user', content: '第二轮' },
    ])
  } finally {
    await store?.close()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
  }
})
