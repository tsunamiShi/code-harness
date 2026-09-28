import type { MysqlAgentStoreOptions } from '../storage/mysql-agent-store.ts'
import type { ContextLimits } from '../runtime/context-manager.ts'

export type AgentTraceMode = 'compact' | 'verbose'

const DEFAULT_AGENT_TRACE_MAX_RESULT_CHARS = 800
const DEFAULT_AGENT_LOOP_GUARD_THRESHOLDS = [3, 5, 8] as const
const DEFAULT_AGENT_NO_PROGRESS_THRESHOLDS = [12, 24] as const
const DEFAULT_AGENT_LOOP_GUARD_MODEL = 'ZHIPU/GLM-5.3-Flash'
const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'glm-5.3': 1_048_576,
  'zhipu/glm-5.3': 1_048_576,
}

export function mysqlOptionsFromEnvironment(): MysqlAgentStoreOptions {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: readPort(process.env.MYSQL_PORT ?? '3306'),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'code_harness',
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

export function agentContextLimitsFromEnvironment(): ContextLimits | undefined {
  const configuredContextWindowTokens = readOptionalPositiveInteger(
    process.env.AGENT_CONTEXT_WINDOW_TOKENS,
    'AGENT_CONTEXT_WINDOW_TOKENS',
  )
  const contextWindowTokens = configuredContextWindowTokens
    ?? contextWindowForModel(process.env.DASHSCOPE_MODEL)
  const configuredLimit = readOptionalPositiveInteger(
    process.env.AGENT_AUTO_COMPACT_TOKEN_LIMIT,
    'AGENT_AUTO_COMPACT_TOKEN_LIMIT',
  )
  if (contextWindowTokens === undefined && configuredLimit === undefined) return undefined

  const maximum = contextWindowTokens === undefined
    ? undefined
    : Math.floor(contextWindowTokens * 0.9)
  if (maximum !== undefined && maximum < 1) {
    throw new Error(`Invalid AGENT_CONTEXT_WINDOW_TOKENS: ${contextWindowTokens}`)
  }
  if (configuredLimit !== undefined && maximum !== undefined && configuredLimit > maximum) {
    throw new Error(
      `Invalid AGENT_AUTO_COMPACT_TOKEN_LIMIT: ${configuredLimit} exceeds 90% of AGENT_CONTEXT_WINDOW_TOKENS`,
    )
  }
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(configuredLimit === undefined
      ? maximum === undefined ? {} : { autoCompactTokenLimit: maximum }
      : { autoCompactTokenLimit: configuredLimit }),
  }
}

function contextWindowForModel(model: string | undefined): number | undefined {
  if (model === undefined) return undefined
  return KNOWN_CONTEXT_WINDOWS[model.trim().toLowerCase()]
}

export function agentMcpConfigPathFromEnvironment(cliValue?: string): string | undefined {
  const value = cliValue ?? process.env.AGENT_MCP_CONFIG
  if (value === undefined) return undefined
  if (value.trim().length === 0) throw new Error('Invalid AGENT_MCP_CONFIG: path must not be empty')
  return value
}

/** WebFetch ships enabled; the CLI flag and AGENT_WEB_FETCH=false are explicit opt-outs. */
export function agentWebFetchEnabledFromEnvironment(cliValue?: boolean): boolean {
  if (cliValue !== undefined) return cliValue
  const value = process.env.AGENT_WEB_FETCH
  if (value === undefined) return true
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Invalid AGENT_WEB_FETCH: ${value} (expected true or false)`)
  }
  return value === 'true'
}

export interface WebSearchConfiguration {
  apiKey: string
  endpoint?: string
  model?: string
}

/**
 * WebSearch is opt-in: AGENT_WEB_SEARCH=true activates it, and the CLI flag wins
 * over the environment. A key alone does not enable paid web searches.
 */
export function agentWebSearchFromEnvironment(cliValue?: boolean): WebSearchConfiguration | undefined {
  if (cliValue === false) return undefined
  const value = process.env.AGENT_WEB_SEARCH
  if (value !== undefined && value !== 'true' && value !== 'false') {
    throw new Error(`Invalid AGENT_WEB_SEARCH: ${value} (expected true or false)`)
  }
  const enabled = cliValue === true || value === 'true'
  if (!enabled) return undefined
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) throw new Error('AGENT_WEB_SEARCH=true requires DASHSCOPE_API_KEY')
  const endpoint = process.env.AGENT_WEB_SEARCH_ENDPOINT
  const model = process.env.AGENT_WEB_SEARCH_MODEL
  return {
    apiKey,
    ...(endpoint === undefined || endpoint.trim().length === 0 ? {} : { endpoint }),
    ...(model === undefined || model.trim().length === 0 ? {} : { model }),
  }
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
  return readThresholds(value, 'AGENT_LOOP_GUARD_THRESHOLDS')
}

export function agentNoProgressThresholdsFromEnvironment(): readonly number[] {
  const value = process.env.AGENT_NO_PROGRESS_THRESHOLDS
  if (value === undefined) return DEFAULT_AGENT_NO_PROGRESS_THRESHOLDS
  return readThresholds(value, 'AGENT_NO_PROGRESS_THRESHOLDS')
}

function readThresholds(value: string, name: string): readonly number[] {
  const thresholds = value.split(',').map(part => Number(part.trim()))
  if (
    thresholds.length === 0
    || thresholds.some(threshold => !Number.isSafeInteger(threshold) || threshold < 2)
    || new Set(thresholds).size !== thresholds.length
  ) {
    throw new Error(`Invalid ${name}: ${value}`)
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

function readOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${name}: ${value}`)
  return number
}
