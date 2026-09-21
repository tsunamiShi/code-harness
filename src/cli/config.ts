import type { MysqlAgentStoreOptions } from '../storage/mysql-agent-store.ts'

export type AgentTraceMode = 'compact' | 'verbose'

const DEFAULT_AGENT_TRACE_MAX_RESULT_CHARS = 800
const DEFAULT_AGENT_LOOP_GUARD_THRESHOLDS = [3, 5, 8] as const
const DEFAULT_AGENT_LOOP_GUARD_MODEL = 'ZHIPU/GLM-5.3-Flash'

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

export function agentTraceMaxResultCharsFromEnvironment(): number {
  const value = process.env.AGENT_TRACE_MAX_RESULT_CHARS
  if (value === undefined) return DEFAULT_AGENT_TRACE_MAX_RESULT_CHARS
  const maxChars = Number(value)
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error(`Invalid AGENT_TRACE_MAX_RESULT_CHARS: ${value}`)
  }
  return maxChars
}

export function agentLoopGuardThresholdsFromEnvironment(): readonly number[] {
  const value = process.env.AGENT_LOOP_GUARD_THRESHOLDS
  if (value === undefined) return DEFAULT_AGENT_LOOP_GUARD_THRESHOLDS
  const thresholds = value.split(',').map(part => Number(part.trim()))
  if (
    thresholds.length === 0
    || thresholds.some(threshold => !Number.isSafeInteger(threshold) || threshold < 2)
    || new Set(thresholds).size !== thresholds.length
  ) {
    throw new Error(`Invalid AGENT_LOOP_GUARD_THRESHOLDS: ${value}`)
  }
  return thresholds.sort((left, right) => left - right)
}

export function agentLoopGuardModelFromEnvironment(): string {
  return process.env.DASHSCOPE_GUARD_MODEL ?? DEFAULT_AGENT_LOOP_GUARD_MODEL
}

function readPort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MYSQL_PORT: ${value}`)
  }
  return port
}
