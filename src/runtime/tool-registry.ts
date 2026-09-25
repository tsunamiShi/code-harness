import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'

import type { Message, Tool, ToolCall, ToolDescription } from './types.ts'

export const TOOL_SEARCH_NAME = 'ToolSearch'
export const TOOL_EXECUTE_NAME = 'ExecuteTool'

const LEGACY_TOOL_SEARCH_NAMES = new Set(['ToolSearchBM25', 'ToolSearchRegex'])
const SEARCH_RESULT_LIMIT = 5
const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'need', 'of', 'on', 'or', 'the', 'to', 'tool', 'tools', 'use',
  'using', 'want', 'with',
])

type ParameterValidator = (input: unknown) =>
  | { valid: true; data: Record<string, unknown>; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string }

export interface ToolRegistryOptions {
  tools: readonly Tool[]
  searchableTools?: readonly Tool[]
}

/** Owns the full Tool catalog behind stable search and execution facades. */
export class ToolRegistry {
  private readonly allToolsByName = new Map<string, Tool>()
  private readonly visibleNames = new Set<string>()
  private readonly discoveredNames = new Set<string>()
  private readonly pendingDiscoveredNames = new Set<string>()
  private readonly searchableTools: readonly Tool[]
  private readonly searchableToolsByName: ReadonlyMap<string, Tool>
  private readonly searchIndex: ToolSearchIndex
  private readonly schemaValidator = new AjvJsonSchemaValidator()
  private readonly parameterValidators = new Map<string, ParameterValidator>()

  constructor(options: ToolRegistryOptions) {
    this.searchableTools = [...(options.searchableTools ?? [])]
    this.searchableToolsByName = new Map(this.searchableTools.map(tool => [
      tool.description.name,
      tool,
    ]))
    this.searchIndex = new ToolSearchIndex(this.searchableTools)
    const toolSearch = this.searchableTools.length === 0 ? undefined : this.createToolSearch()
    const toolExecute = this.searchableTools.length === 0 ? undefined : this.createToolExecute()

    for (const tool of [
      ...options.tools,
      ...(toolSearch ? [toolSearch] : []),
      ...(toolExecute ? [toolExecute] : []),
      ...this.searchableTools,
    ]) {
      const { name } = tool.description
      if (this.allToolsByName.has(name)) throw new Error(`Duplicate tool name: ${name}`)
      this.allToolsByName.set(name, tool)
    }
    for (const tool of options.tools) this.visibleNames.add(tool.description.name)
    if (toolSearch) this.visibleNames.add(toolSearch.description.name)
    if (toolExecute) this.visibleNames.add(toolExecute.description.name)
  }

  /** Returns the current Model-visible Tool definitions in stable registration order. */
  descriptions(): readonly ToolDescription[] {
    return [...this.allToolsByName.values()]
      .filter(tool => this.visibleNames.has(tool.description.name))
      .map(tool => tool.description)
  }

  /** Resolves only model-visible Tools. Deferred Tools execute through ExecuteTool. */
  get(name: string): Tool | undefined {
    if (!this.visibleNames.has(name)) return undefined
    return this.allToolsByName.get(name)
  }

  /** Returns static metadata for trace reconstruction and Loop Guard classification. */
  catalogTool(name: string): Tool | undefined {
    return this.allToolsByName.get(name)
  }

  /** Resolves the underlying effect hidden behind ExecuteTool for Loop Guard accounting. */
  effectForCall(call: Pick<ToolCall, 'name' | 'arguments'>): Tool['effect'] {
    if (call.name !== TOOL_EXECUTE_NAME) {
      return this.catalogTool(call.name)?.effect ?? 'execute'
    }
    const toolName = isRecord(call.arguments) ? call.arguments.tool_name : undefined
    return typeof toolName === 'string'
      ? this.searchableToolsByName.get(toolName)?.effect ?? 'execute'
      : 'execute'
  }

  /** Publishes or discards Tool Search matches after the whole Tool Call Batch finishes. */
  finishToolCallBatch(publishDiscoveries = true): void {
    if (publishDiscoveries) {
      for (const name of this.pendingDiscoveredNames) this.discoveredNames.add(name)
    }
    this.pendingDiscoveredNames.clear()
  }

  /** Rehydrates Tool Search discoveries from durable Tool Results. */
  restore(messages: readonly Message[]): void {
    this.discoveredNames.clear()
    this.pendingDiscoveredNames.clear()
    const searchCalls = new Map<string, true>()
    for (const message of messages) {
      if (message.role === 'assistant' && 'toolCalls' in message) {
        for (const call of message.toolCalls) {
          if (isToolSearchName(call.name)) searchCalls.set(call.id, true)
        }
        continue
      }
      if (message.role !== 'tool' || !searchCalls.has(message.toolCallId)) continue
      searchCalls.delete(message.toolCallId)
      for (const name of restoredToolNames(message.content)) this.discover(name)
    }
  }

  private createToolSearch(): Tool {
    return {
      effect: 'observe',
      description: {
        name: TOOL_SEARCH_NAME,
        description: `Search deferred tools with manually weighted lexical matching. Search only tool names, descriptions, parameter names, and parameter descriptions. Returns at most ${SEARCH_RESULT_LIMIT} candidates with their input_schema contracts; call one in a later model step through ${TOOL_EXECUTE_NAME}. Use "select:<exact_tool_name>" when the name is already known, and prefix essential terms with +.`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Capability terms, optionally with +required terms, or select:<exact_tool_name>.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      execute: async arguments_ => this.search(arguments_),
    }
  }

  private createToolExecute(): Tool {
    return {
      effect: 'execute',
      description: {
        name: TOOL_EXECUTE_NAME,
        description: `Execute one deferred tool discovered by ${TOOL_SEARCH_NAME} in an earlier model step. Copy the exact tool_name and construct params from that search result's input_schema. The Runtime validates params against the target contract before dispatching the real tool.`,
        parameters: {
          type: 'object',
          properties: {
            tool_name: {
              type: 'string',
              description: `Exact deferred tool name returned by ${TOOL_SEARCH_NAME}.`,
            },
            params: {
              type: 'object',
              description: `Arguments conforming to the selected tool's input_schema returned by ${TOOL_SEARCH_NAME}.`,
              additionalProperties: true,
            },
          },
          required: ['tool_name', 'params'],
          additionalProperties: false,
        },
      },
      execute: async arguments_ => await this.executeDeferred(arguments_),
    }
  }

  private search(arguments_: unknown): string {
    const query = parseSearchQuery(arguments_)
    const matches = this.searchIndex.search(query).slice(0, SEARCH_RESULT_LIMIT)
    for (const match of matches) this.pendingDiscoveredNames.add(match.tool.description.name)

    return JSON.stringify({
      query,
      matches: matches.map(match => match.tool.description.name),
      tools: matches.map(match => ({
        name: match.tool.description.name,
        description: match.tool.description.description,
        input_schema: match.tool.description.parameters,
      })),
      ...(matches.length === 0
        ? { message: 'No matching tools found. Try fewer terms, +required terms, or an exact tool/server name.' }
        : { message: `Use ${TOOL_EXECUTE_NAME} in a later model step with params that satisfy input_schema.` }),
    })
  }

  private async executeDeferred(arguments_: unknown): Promise<string> {
    const { toolName, params } = parseExecuteArguments(arguments_)
    const tool = this.searchableToolsByName.get(toolName)
    if (!tool) throw new Error(`${TOOL_EXECUTE_NAME} unknown deferred tool: ${toolName}`)
    if (!this.discoveredNames.has(toolName)) {
      throw new Error(`${TOOL_EXECUTE_NAME} tool "${toolName}" must be discovered by ${TOOL_SEARCH_NAME} in an earlier model step`)
    }

    const validation = this.validateParameters(tool, params)
    if (!validation.valid) {
      throw new Error(
        `${TOOL_EXECUTE_NAME} invalid parameters for "${toolName}": ${validation.errorMessage}`,
      )
    }
    return await tool.execute(validation.data)
  }

  private validateParameters(
    tool: Tool,
    params: Record<string, unknown>,
  ): ReturnType<ParameterValidator> {
    let validator = this.parameterValidators.get(tool.description.name)
    if (!validator) {
      try {
        validator = this.schemaValidator.getValidator<Record<string, unknown>>(
          tool.description.parameters as never,
        )
      } catch (error) {
        throw invalidContractError(tool.description.name, error)
      }
      this.parameterValidators.set(tool.description.name, validator)
    }
    try {
      return validator(params)
    } catch (error) {
      throw invalidContractError(tool.description.name, error)
    }
  }

  private discover(name: string): void {
    if (this.searchableToolsByName.has(name)) this.discoveredNames.add(name)
  }
}

interface RankedTool {
  tool: Tool
  score: number
  index: number
}

interface IndexedTool {
  tool: Tool
  index: number
  normalizedName: string
  nameParts: readonly string[]
  descriptionTerms: ReadonlySet<string>
  parameterNameParts: readonly string[]
  parameterDescriptionTerms: ReadonlySet<string>
}

class ToolSearchIndex {
  private readonly documents: readonly IndexedTool[]

  constructor(tools: readonly Tool[]) {
    this.documents = tools.map((tool, index) => indexTool(tool, index))
  }

  search(query: string): RankedTool[] {
    const selected = /^select:(.+)$/iu.exec(query)
    if (selected) return this.selectTools(selected[1] ?? '')

    const exact = this.documents.find(document => document.normalizedName === normalize(query))
    if (exact) return [{ tool: exact.tool, score: Number.MAX_SAFE_INTEGER, index: exact.index }]

    const { required, scoring } = parseQueryTerms(query)
    if (scoring.length === 0) return []
    return this.documents
      .filter(document => required.every(term => matchesTerm(document, term)))
      .map(document => ({
        tool: document.tool,
        index: document.index,
        score: scoreDocument(document, scoring),
      }))
      .filter(match => match.score > 0)
      .sort(compareRankedTools)
  }

  private selectTools(value: string): RankedTool[] {
    const requested = value.split(',').map(name => normalize(name.trim())).filter(Boolean)
    const found: RankedTool[] = []
    for (const name of requested) {
      const document = this.documents.find(candidate => candidate.normalizedName === name)
      if (!document || found.some(match => match.tool === document.tool)) continue
      found.push({ tool: document.tool, score: Number.MAX_SAFE_INTEGER, index: document.index })
      if (found.length === SEARCH_RESULT_LIMIT) break
    }
    return found
  }
}

function indexTool(tool: Tool, index: number): IndexedTool {
  const parameterMetadata = extractParameterMetadata(tool.description.parameters)
  return {
    tool,
    index,
    normalizedName: normalize(tool.description.name),
    nameParts: splitName(tool.description.name),
    descriptionTerms: new Set(tokenize(tool.description.description)),
    parameterNameParts: parameterMetadata.names.flatMap(splitName),
    parameterDescriptionTerms: new Set(parameterMetadata.descriptions.flatMap(tokenize)),
  }
}

function scoreDocument(document: IndexedTool, terms: readonly string[]): number {
  let score = 0
  for (const term of terms) {
    const exactNamePart = document.nameParts.includes(term)
    const partialNamePart = !exactNamePart
      && document.nameParts.some(part => part.includes(term))
    if (exactNamePart) score += 12
    else if (partialNamePart) score += 6
    else if (document.normalizedName.includes(term)) score += 3

    const exactParameterName = document.parameterNameParts.includes(term)
    const partialParameterName = !exactParameterName
      && document.parameterNameParts.some(part => part.includes(term))
    if (exactParameterName) score += 4
    else if (partialParameterName) score += 2

    if (document.descriptionTerms.has(term)) score += 2
    if (document.parameterDescriptionTerms.has(term)) score += 1
  }
  return score
}

function matchesTerm(document: IndexedTool, term: string): boolean {
  return document.nameParts.some(part => part.includes(term))
    || document.normalizedName.includes(term)
    || document.descriptionTerms.has(term)
    || document.parameterNameParts.some(part => part.includes(term))
    || document.parameterDescriptionTerms.has(term)
}

function parseQueryTerms(query: string): { required: string[]; scoring: string[] } {
  const required: string[] = []
  const optional: string[] = []
  for (const rawPart of query.split(/\s+/u)) {
    const isRequired = rawPart.startsWith('+') && rawPart.length > 1
    const terms = tokenize(isRequired ? rawPart.slice(1) : rawPart)
      .filter(term => !QUERY_STOP_WORDS.has(term))
    if (isRequired) required.push(...terms)
    else optional.push(...terms)
  }
  return { required: [...new Set(required)], scoring: [...new Set([...required, ...optional])] }
}

function extractParameterMetadata(parameters: Record<string, unknown>): {
  names: string[]
  descriptions: string[]
} {
  const names: string[] = []
  const descriptions: string[] = []
  const visited = new Set<object>()

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isRecord(value) || visited.has(value)) return
    visited.add(value)

    if (isRecord(value.properties)) {
      for (const [name, schema] of Object.entries(value.properties)) {
        names.push(name)
        if (isRecord(schema) && typeof schema.description === 'string') {
          descriptions.push(schema.description)
        }
        visit(schema)
      }
    }
    for (const key of [
      'items', 'contains', 'additionalProperties', 'not', 'if', 'then', 'else',
      'allOf', 'anyOf', 'oneOf', 'prefixItems',
    ]) {
      visit(value[key])
    }
    for (const key of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
      const schemas = value[key]
      if (!isRecord(schemas)) continue
      for (const schema of Object.values(schemas)) visit(schema)
    }
  }

  visit(parameters)
  return { names, descriptions }
}

function splitName(value: string): string[] {
  const withoutMcpPrefix = value.replace(/^mcp__/iu, '')
  return tokenize(
    withoutMcpPrefix
      .replace(/__/gu, ' ')
      .replace(/[_-]/gu, ' ')
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2'),
  )
}

function tokenize(value: string): string[] {
  const camelCaseSeparated = value.normalize('NFKC').replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
  const segments = normalize(camelCaseSeparated).match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []
  return segments.flatMap(segment => {
    if (!/^\p{Script=Han}+$/u.test(segment)) return [segment]
    const characters = [...segment]
    if (characters.length < 2) return characters
    return [segment, ...characters.slice(0, -1).map((character, index) => character + characters[index + 1])]
  })
}

function compareRankedTools(left: RankedTool, right: RankedTool): number {
  return right.score - left.score || left.index - right.index
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function parseSearchQuery(arguments_: unknown): string {
  if (!isRecord(arguments_)) throw new Error(`${TOOL_SEARCH_NAME} arguments must be an object`)
  const query = arguments_.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error(`${TOOL_SEARCH_NAME} query must be a non-empty string`)
  }
  return query.trim()
}

function parseExecuteArguments(arguments_: unknown): { toolName: string; params: Record<string, unknown> } {
  if (!isRecord(arguments_)) throw new Error(`${TOOL_EXECUTE_NAME} arguments must be an object`)
  const toolName = arguments_.tool_name
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    throw new Error(`${TOOL_EXECUTE_NAME} tool_name must be a non-empty string`)
  }
  const params = arguments_.params
  if (!isRecord(params)) throw new Error(`${TOOL_EXECUTE_NAME} params must be an object`)
  return { toolName: toolName.trim(), params }
}

function invalidContractError(toolName: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`${TOOL_EXECUTE_NAME} invalid parameter contract for "${toolName}": ${detail}`)
}

function restoredToolNames(content: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return []
    const names = Array.isArray(parsed.matches)
      ? parsed.matches
      : Array.isArray(parsed.activated)
        ? parsed.activated
        : []
    return names.filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}

function isToolSearchName(name: string): boolean {
  return name === TOOL_SEARCH_NAME || LEGACY_TOOL_SEARCH_NAMES.has(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
