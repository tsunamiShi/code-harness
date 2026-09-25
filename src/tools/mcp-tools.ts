import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool as McpToolDefinition,
  type Transport,
} from '@modelcontextprotocol/client'
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio'

import type { Tool, ToolEffect } from '../runtime/types.ts'

const CLIENT_INFO = { name: 'ai-agent', version: '0.1.0' } as const
const DEFAULT_TIMEOUT_MS = 60_000
const VERSION_PROBE_TIMEOUT_MS = 1_000
const MAX_RUNTIME_TOOL_NAME_LENGTH = 64

export type McpTransportKind = 'stdio' | 'http' | 'sse'

export interface McpServerSummary {
  name: string
  transport: McpTransportKind
  toolCount: number
}

/** Owns all MCP connections and the Runtime Tools discovered through them. */
export interface McpToolSet {
  readonly configPath: string
  readonly servers: readonly McpServerSummary[]
  readonly tools: readonly Tool[]
  close(): Promise<void>
}

export interface ConnectMcpToolsOptions {
  configPath: string
  workspaceFolder: string
  environment?: Readonly<Record<string, string | undefined>>
}

/** Connects every configured MCP server and exposes its discovered tools as Runtime Tools. */
export async function connectMcpTools(options: ConnectMcpToolsOptions): Promise<McpToolSet> {
  const environment = options.environment ?? process.env
  const configPath = resolve(options.configPath)
  const workspaceFolder = resolve(options.workspaceFolder)
  const config = await readMcpConfig(configPath, workspaceFolder, environment)
  const settled = await Promise.allSettled(
    config.servers.map(async server => await connectServer(server, environment)),
  )
  const connections = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])

  if (failures.length > 0) {
    const cleanupFailures = await closeConnections(connections)
    throw new AggregateError(
      [...failures, ...cleanupFailures],
      `Failed to connect ${failures.length} MCP server${failures.length === 1 ? '' : 's'} from ${configPath}`,
    )
  }

  const tools = connections.flatMap(connection => connection.tools)
  try {
    ensureUniqueToolNames(tools)
  } catch (error: unknown) {
    const cleanupFailures = await closeConnections(connections)
    throw new AggregateError(
      [error, ...cleanupFailures],
      `MCP tools from ${configPath} do not have unique Runtime names`,
    )
  }
  let closePromise: Promise<void> | undefined

  return {
    configPath,
    servers: connections.map(connection => connection.summary),
    tools,
    close() {
      closePromise ??= closeToolSet(connections)
      return closePromise
    },
  }
}

interface ParsedMcpConfig {
  servers: readonly ParsedServerConfig[]
}

type ParsedServerConfig = ParsedStdioServerConfig | ParsedHttpServerConfig

interface ParsedServerBase {
  name: string
  timeoutMs: number
}

interface ParsedStdioServerConfig extends ParsedServerBase {
  transport: 'stdio'
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | null>>
}

interface ParsedHttpServerConfig extends ParsedServerBase {
  transport: 'http' | 'sse'
  url: URL
  headers: Readonly<Record<string, string>>
}

interface McpConnection {
  summary: McpServerSummary
  tools: readonly Tool[]
  close(): Promise<void>
}

async function readMcpConfig(
  configPath: string,
  workspaceFolder: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ParsedMcpConfig> {
  let source: string
  try {
    source = await readFile(configPath, 'utf8')
  } catch (error: unknown) {
    throw new Error(`Cannot read MCP config: ${configPath}`, { cause: error })
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in MCP config: ${configPath}`, { cause: error })
  }

  const root = requireRecord(value, 'MCP config')
  if (root.mcpServers !== undefined && root.servers !== undefined) {
    throw new Error('MCP config must define either "mcpServers" or "servers", not both')
  }
  const rawServers = requireRecord(
    root.mcpServers ?? root.servers ?? {},
    'MCP config server map',
  )
  const expansionEnvironment = { ...environment, workspaceFolder }
  const configDirectory = dirname(configPath)
  const servers: ParsedServerConfig[] = []

  for (const [name, rawServer] of Object.entries(rawServers)) {
    if (name.trim().length === 0) throw new Error('MCP server name must not be empty')
    const server = requireRecord(rawServer, `MCP server "${name}"`)
    if (server.disabled !== undefined && typeof server.disabled !== 'boolean') {
      throw new Error(`${name}.disabled must be a boolean`)
    }
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
      throw new Error(`${name}.enabled must be a boolean`)
    }
    if (server.disabled === true || server.enabled === false) continue
    const timeoutMs = optionalPositiveInteger(server.timeoutMs, DEFAULT_TIMEOUT_MS, `${name}.timeoutMs`)
    const transport = readTransport(server, name)

    if (transport === 'stdio') {
      const command = expandVariables(
        requireNonEmptyString(server.command, `${name}.command`),
        expansionEnvironment,
        `${name}.command`,
      )
      const args = readStringArray(server.args, `${name}.args`).map((argument, index) =>
        expandVariables(argument, expansionEnvironment, `${name}.args[${index}]`),
      )
      const configuredCwd = server.cwd === undefined
        ? workspaceFolder
        : expandVariables(
            requireNonEmptyString(server.cwd, `${name}.cwd`),
            expansionEnvironment,
            `${name}.cwd`,
          )
      const cwd = isAbsolute(configuredCwd)
        ? configuredCwd
        : resolve(configDirectory, configuredCwd)
      const env = readEnvironment(server.env, name, expansionEnvironment)
      servers.push({ name, transport, command, args, cwd, env, timeoutMs })
      continue
    }

    const urlText = expandVariables(
      requireNonEmptyString(server.url, `${name}.url`),
      expansionEnvironment,
      `${name}.url`,
    )
    const url = readHttpUrl(urlText, `${name}.url`)
    const headers = readHeaders(server.headers, name, expansionEnvironment)
    servers.push({ name, transport, url, headers, timeoutMs })
  }

  return { servers }
}

function readTransport(server: Record<string, unknown>, name: string): McpTransportKind {
  if (server.command !== undefined && server.url !== undefined) {
    throw new Error(`MCP server "${name}" must not define both command and url`)
  }
  const explicit = server.type
  if (explicit === undefined) {
    if (typeof server.command === 'string') return 'stdio'
    if (typeof server.url === 'string') return 'http'
    throw new Error(`MCP server "${name}" must define either command or url`)
  }
  if (explicit === 'stdio' || explicit === 'sse') return explicit
  if (explicit === 'http' || explicit === 'streamable-http') return 'http'
  throw new Error(`Unsupported MCP transport for "${name}": ${String(explicit)}`)
}

function readEnvironment(
  value: unknown,
  serverName: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | null>> {
  if (value === undefined) return {}
  const raw = requireRecord(value, `${serverName}.env`)
  const result: Record<string, string | null> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (entry === null) {
      result[name] = null
      continue
    }
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new Error(`${serverName}.env.${name} must be a string, number, boolean, or null`)
    }
    result[name] = expandVariables(String(entry), environment, `${serverName}.env.${name}`)
  }
  return result
}

function readHeaders(
  value: unknown,
  serverName: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  const raw = requireRecord(value, `${serverName}.headers`)
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new Error(`${serverName}.headers.${name} must be a string, number, or boolean`)
    }
    result[name] = expandVariables(String(entry), environment, `${serverName}.headers.${name}`)
  }
  return result
}

function expandVariables(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = environment[name]
      if (resolved !== undefined && resolved.length > 0) return resolved
      if (fallback !== undefined) return fallback
      throw new Error(`Missing environment variable ${name} referenced by ${field}`)
    },
  )
}

async function connectServer(
  config: ParsedServerConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<McpConnection> {
  const client = new Client(CLIENT_INFO, {
    versionNegotiation: {
      mode: 'auto',
      probe: { timeoutMs: Math.min(config.timeoutMs, VERSION_PROBE_TIMEOUT_MS), maxRetries: 0 },
    },
    inputRequired: { autoFulfill: false },
  })
  const { transport, terminateSession } = createTransport(config, environment)
  let connected = false
  try {
    await client.connect(transport, {
      timeout: config.timeoutMs,
      maxTotalTimeout: config.timeoutMs,
    })
    connected = true
    const { tools: definitions } = await client.listTools(undefined, {
      timeout: config.timeoutMs,
      maxTotalTimeout: config.timeoutMs,
      cacheMode: 'refresh',
    })
    const tools = definitions.map(definition =>
      createRuntimeTool(config.name, definition, client, config.timeoutMs),
    )
    ensureUniqueToolNames(tools)
    return {
      summary: { name: config.name, transport: config.transport, toolCount: tools.length },
      tools,
      close: createConnectionCloser(client, terminateSession),
    }
  } catch (error: unknown) {
    if (connected) await client.close().catch(() => undefined)
    else await transport.close().catch(() => undefined)
    throw new Error(`MCP server "${config.name}" failed to connect or list tools`, { cause: error })
  }
}

function createTransport(
  config: ParsedServerConfig,
  environment: Readonly<Record<string, string | undefined>>,
): { transport: Transport; terminateSession?: () => Promise<void> } {
  if (config.transport === 'stdio') {
    const env: Record<string, string> = {}
    for (const name of DEFAULT_INHERITED_ENV_VARS) {
      const value = environment[name]
      if (value !== undefined) env[name] = value
    }
    for (const [name, value] of Object.entries(config.env)) {
      if (value === null) delete env[name]
      else env[name] = value
    }
    return {
      transport: new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        cwd: config.cwd,
        env,
        stderr: 'inherit',
      }),
    }
  }

  const requestInit = Object.keys(config.headers).length === 0
    ? undefined
    : { headers: config.headers }
  if (config.transport === 'http') {
    const transport = new StreamableHTTPClientTransport(
      config.url,
      requestInit === undefined ? undefined : { requestInit },
    )
    return {
      transport,
      terminateSession: async () => await transport.terminateSession(),
    }
  }

  const fetchWithHeaders = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(config.headers)) headers.set(name, value)
    return await fetch(input, { ...init, headers })
  }
  return {
    transport: new SSEClientTransport(config.url, {
      ...(requestInit === undefined ? {} : { requestInit }),
      eventSourceInit: { fetch: fetchWithHeaders },
    }),
  }
}

function createRuntimeTool(
  serverName: string,
  definition: McpToolDefinition,
  client: Client,
  timeoutMs: number,
): Tool {
  const runtimeName = runtimeToolName(serverName, definition.name)
  const description = definition.description?.trim()
    || definition.title?.trim()
    || `Call ${definition.name} on MCP server ${serverName}`
  const parameters = requireRecord(definition.inputSchema, `${serverName}.${definition.name}.inputSchema`)

  return {
    description: {
      name: runtimeName,
      description: `[MCP server: ${serverName}] ${description}`,
      parameters: structuredClone(parameters),
    },
    effect: toolEffect(definition),
    async execute(arguments_: unknown): Promise<string> {
      const argumentsObject = requireRecord(
        arguments_,
        `arguments for MCP tool ${serverName}.${definition.name}`,
      )
      const result = await client.callTool(
        { name: definition.name, arguments: argumentsObject },
        {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
          toolDefinition: definition,
        },
      )
      if (result.isError === true) {
        throw new Error(
          `MCP tool ${serverName}.${definition.name} reported an error: ${formatMcpResult(result)}`,
        )
      }
      return formatMcpResult(result)
    },
  }
}

function toolEffect(definition: McpToolDefinition): ToolEffect {
  return definition.annotations?.readOnlyHint === true ? 'observe' : 'execute'
}

function formatMcpResult(result: CallToolResult): string {
  if (
    result.structuredContent === undefined
    && result.content.length > 0
    && result.content.every(block => block.type === 'text')
  ) {
    return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  }
  return JSON.stringify({
    content: result.content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  })
}

function runtimeToolName(serverName: string, toolName: string): string {
  const readable = `mcp__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`
  if (
    readable.length <= MAX_RUNTIME_TOOL_NAME_LENGTH
    && serverName === sanitizeNamePart(serverName)
    && toolName === sanitizeNamePart(toolName)
  ) return readable

  const digest = createHash('sha256').update(`${serverName}\0${toolName}`).digest('hex').slice(0, 10)
  const available = MAX_RUNTIME_TOOL_NAME_LENGTH - digest.length - 2
  return `${readable.slice(0, available)}__${digest}`
}

function sanitizeNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_')
  return sanitized.length === 0 ? 'unnamed' : sanitized
}

function ensureUniqueToolNames(tools: readonly Tool[]): void {
  const names = new Set<string>()
  for (const tool of tools) {
    const name = tool.description.name
    if (names.has(name)) throw new Error(`Duplicate MCP Runtime tool name: ${name}`)
    names.add(name)
  }
}

function createConnectionCloser(
  client: Client,
  terminateSession: (() => Promise<void>) | undefined,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined
  return () => {
    closePromise ??= (async () => {
      const errors: unknown[] = []
      if (terminateSession !== undefined) {
        try {
          await terminateSession()
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      try {
        await client.close()
      } catch (error: unknown) {
        errors.push(error)
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to close MCP connection')
    })()
    return closePromise
  }
}

async function closeConnections(connections: readonly McpConnection[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(connections.map(async connection => await connection.close()))
  return settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
}

async function closeToolSet(connections: readonly McpConnection[]): Promise<void> {
  const failures = await closeConnections(connections)
  if (failures.length > 0) throw new AggregateError(failures, 'Failed to close MCP tool set')
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value as string[]
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value as number
}

function readHttpUrl(value: string, field: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new Error(`${field} must be a valid URL`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http or https`)
  }
  return url
}
