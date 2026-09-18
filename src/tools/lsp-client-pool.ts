const DEFAULT_MAX_CLIENTS = 4

/** A reusable language client whose process health can be observed after failures. */
export interface PooledLspClient<Input, Output> {
  readonly healthy: boolean
  query(input: Input): Promise<Output>
  close(): Promise<void>
}

/** Reuses language clients by project and bounds retained child processes with LRU eviction. */
export class LspClientPool<Input, Output> {
  private readonly clients = new Map<string, PooledLspClient<Input, Output>>()
  private closed = false

  constructor(
    private readonly createClient: (key: string, input: Input) => PooledLspClient<Input, Output>,
    private readonly maxClients = DEFAULT_MAX_CLIENTS,
  ) {
    if (!Number.isInteger(maxClients) || maxClients < 1) {
      throw new Error('LSP client pool requires a positive integer limit')
    }
  }

  async query(key: string, input: Input): Promise<Output> {
    if (this.closed) throw new Error('LSP client pool is closed')
    let client = await this.clientFor(key, input)
    try {
      return await client.query(input)
    } catch (error: unknown) {
      if (client.healthy) throw error
      this.clients.delete(key)
      await client.close()
      client = await this.clientFor(key, input)
      return await client.query(input)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map(async client => await client.close()))
  }

  private async clientFor(key: string, input: Input): Promise<PooledLspClient<Input, Output>> {
    const existing = this.clients.get(key)
    if (existing) {
      this.clients.delete(key)
      this.clients.set(key, existing)
      return existing
    }
    if (this.clients.size >= this.maxClients) {
      const oldestKey = this.clients.keys().next().value as string | undefined
      if (oldestKey !== undefined) {
        const oldest = this.clients.get(oldestKey)
        this.clients.delete(oldestKey)
        await oldest?.close()
      }
    }
    const client = this.createClient(key, input)
    this.clients.set(key, client)
    return client
  }
}
