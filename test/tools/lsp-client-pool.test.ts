import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LspClientPool,
  type PooledLspClient,
} from '../../src/tools/lsp-client-pool.ts'

test('reuses one healthy LSP client for repeated queries in the same workspace', async () => {
  const created: FakeClient[] = []
  const pool = new LspClientPool<string, string>(() => {
    const client = new FakeClient()
    created.push(client)
    return client
  })

  assert.equal(await pool.query('/workspace::vue', 'definition'), 'definition')
  assert.equal(await pool.query('/workspace::vue', 'hover'), 'hover')
  assert.equal(created.length, 1)

  await pool.close()
  assert.equal(created[0]?.closeCount, 1)
  await assert.rejects(pool.query('/workspace::vue', 'hover'), /pool is closed/)
})

test('evicts the least recently used client when the workspace limit is reached', async () => {
  const clients = new Map<string, FakeClient>()
  const pool = new LspClientPool<string, string>(key => {
    const client = new FakeClient()
    clients.set(key, client)
    return client
  }, 2)

  await pool.query('a', 'a1')
  await pool.query('b', 'b1')
  await pool.query('a', 'a2')
  await pool.query('c', 'c1')

  assert.equal(clients.get('a')?.closeCount, 0)
  assert.equal(clients.get('b')?.closeCount, 1)
  assert.equal(clients.get('c')?.closeCount, 0)
  await pool.close()
})

test('recreates one unhealthy LSP client and retries a read-only query once', async () => {
  const created: FakeClient[] = []
  const pool = new LspClientPool<string, string>(() => {
    const client = new FakeClient(created.length === 0)
    created.push(client)
    return client
  })

  assert.equal(await pool.query('workspace', 'definition'), 'definition')
  assert.equal(created.length, 2)
  assert.equal(created[0]?.closeCount, 1)
  await pool.close()
})

class FakeClient implements PooledLspClient<string, string> {
  healthy = true
  closeCount = 0

  constructor(private readonly failOnce = false) {}

  async query(input: string): Promise<string> {
    if (this.failOnce) {
      this.healthy = false
      throw new Error('process exited')
    }
    return input
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}
