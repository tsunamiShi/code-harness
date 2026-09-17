import type { MysqlAgentStoreOptions } from './mysql-agent-store.ts'

const DEFAULT_AGENT_MAX_STEPS = 50

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

export function agentMaxStepsFromEnvironment(): number {
  const value = process.env.AGENT_MAX_STEPS
  if (value === undefined) return DEFAULT_AGENT_MAX_STEPS
  const maxSteps = Number(value)
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 500) {
    throw new Error(`Invalid AGENT_MAX_STEPS: ${value}`)
  }
  return maxSteps
}

function readPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MYSQL_PORT: ${value}`)
  }
  return port
}
