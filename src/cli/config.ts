import type { MysqlAgentStoreOptions } from '../storage/mysql-agent-store.ts'

export type AgentTraceMode = 'compact' | 'verbose'

export function mysqlOptionsFromEnvironment(): MysqlAgentStoreOptions {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: readPort(process.env.MYSQL_PORT ?? '3306'),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'ai_agent',
  }
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function agentMaxTokensFromEnvironment(): number | undefined {
  const value = process.env.AGENT_MAX_TOKENS
  if (value === undefined) return undefined
  const maxTokens = Number(value)
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`Invalid AGENT_MAX_TOKENS: ${value}`)
  }
  return maxTokens
}

export function agentTraceModeFromEnvironment(): AgentTraceMode {
  const value = process.env.AGENT_TRACE ?? 'compact'
  if (value !== 'compact' && value !== 'verbose') {
    throw new Error(`Invalid AGENT_TRACE: ${value}`)
  }
  return value
}

function readPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MYSQL_PORT: ${value}`)
  }
  return port
}
