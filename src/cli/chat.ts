import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { OpenAICompatibleResponsesModel } from '../models/openai-compatible-responses-model.ts'
import { OpenAICompatibleChatTextModel } from '../models/openai-compatible-chat-text-model.ts'
import { primaryRoot, ProjectCatalog } from '../projects/project.ts'
import { AgentSession, type AgentEvent } from '../runtime/agent-session.ts'
import { ModelRepeatLoopGuard, NoProgressLoopGuard } from '../runtime/loop-guard.ts'
import type { Tool } from '../runtime/types.ts'
import { MysqlAgentStore } from '../storage/mysql-agent-store.ts'
import { createCodeTools } from '../tools/code-tools.ts'
import { connectMcpTools, type McpToolSet } from '../tools/mcp-tools.ts'
import { readChatTarget } from './chat-arguments.ts'
import { createColor, supportsColor } from './colors.ts'
import { createConsoleTrace } from './console-trace.ts'
import { createMarkdownRenderer } from './markdown.ts'
import { createTraceModeShortcut } from './trace-mode-shortcut.ts'
import { createTurnElapsedDisplay } from './turn-elapsed.ts'
import {
  completeSlashCommand,
  selectProjectSession,
  slashCommandHelp,
} from './slash-commands.ts'
import {
  agentContextLimitsFromEnvironment,
  agentMcpConfigPathFromEnvironment,
  agentMaxTokensFromEnvironment,
  agentLoopGuardModelFromEnvironment,
  agentLoopGuardThresholdsFromEnvironment,
  agentNoProgressThresholdsFromEnvironment,
  agentTraceMaxResultCharsFromEnvironment,
  agentTraceModeFromEnvironment,
  agentWebFetchEnabledFromEnvironment,
  agentWebSearchFromEnvironment,
  mysqlOptionsFromEnvironment,
  requiredEnvironment,
} from './config.ts'

const store = await MysqlAgentStore.connect(mysqlOptionsFromEnvironment())
const catalog = new ProjectCatalog(store)
let codeTools: readonly Tool[] = []
let mcpToolSet: McpToolSet | undefined
try {
  const target = readChatTarget(process.argv.slice(2))
  const project = target.kind === 'project'
    ? await catalog.get(target.id)
    : target.kind === 'session'
      ? await projectForSession(target.id)
      : await catalog.getOrCreateForDirectory(target.path)
  const webFetch = agentWebFetchEnabledFromEnvironment(target.webFetch)
  const webSearch = agentWebSearchFromEnvironment(target.webSearch)
  codeTools = createCodeTools(project, target.accessMode, {
    webFetch,
    ...(webSearch === undefined ? {} : { webSearch }),
  })
  const mcpConfigPath = agentMcpConfigPathFromEnvironment(target.mcpConfigPath)
  if (mcpConfigPath !== undefined) {
    mcpToolSet = await connectMcpTools({
      configPath: mcpConfigPath,
      workspaceFolder: primaryRoot(project).path,
    })
  }
  const traceMode = agentTraceModeFromEnvironment()
  const traceMaxResultChars = agentTraceMaxResultCharsFromEnvironment()
  const loopGuardThresholds = agentLoopGuardThresholdsFromEnvironment()
  const noProgressThresholds = agentNoProgressThresholdsFromEnvironment()
  const maxTokens = agentMaxTokensFromEnvironment()
  const contextLimits = agentContextLimitsFromEnvironment()
  const apiKey = requiredEnvironment('DASHSCOPE_API_KEY')
  const baseURL = requiredEnvironment('DASHSCOPE_BASE_URL')
  const loopGuardModelName = agentLoopGuardModelFromEnvironment()
  const model = new OpenAICompatibleResponsesModel({
    apiKey,
    baseURL,
    model: requiredEnvironment('DASHSCOPE_MODEL'),
  })
  const loopGuardModel = new OpenAICompatibleChatTextModel({
    apiKey,
    baseURL,
    model: loopGuardModelName,
  })
  const colors = supportsColor(stdout)
  const color = createColor(colors)
  const trace = createConsoleTrace({
    write: text => console.log(text),
    writeFragment: text => stdout.write(text),
    mode: traceMode,
    maxToolResultChars: traceMaxResultChars,
    colors,
    renderMarkdown: createMarkdownRenderer({
      width: Math.max(40, (stdout.columns ?? 100) - 8),
      colors,
    }),
  })
  const elapsedDisplay = createTurnElapsedDisplay({
    enabled: stdout.isTTY === true,
    colors,
    write: text => stdout.write(text),
  })
  const sessionOptions = {
    model,
    loopGuards: [
      new ModelRepeatLoopGuard(loopGuardModel, { thresholds: loopGuardThresholds }),
      new NoProgressLoopGuard({ thresholds: noProgressThresholds }),
    ],
    tools: codeTools,
    searchableTools: mcpToolSet?.tools ?? [],
    store,
    project,
    accessMode: target.accessMode,
    webFetch,
    ...(webSearch === undefined ? {} : { webSearch: true }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextLimits === undefined ? {} : { contextLimits }),
    onEvent: (event: AgentEvent) => elapsedDisplay.handle(event, () => trace.handle(event)),
  }
  let session = target.kind === 'session'
    ? await AgentSession.resume(target.id, sessionOptions)
    : await AgentSession.create(sessionOptions)
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    completer: completeSlashCommand,
  })
  let waitingForPrompt = false
  const traceShortcut = createTraceModeShortcut({
    enabled: stdin.isTTY === true,
    input: stdin,
    onToggle: () => {
      const mode = trace.toggleMode()
      elapsedDisplay.interject(() => console.log(`${color.boldCyan('Trace mode:')} ${color.dim(mode)}`))
      if (waitingForPrompt) terminal.prompt(true)
    },
  })

  const banner = (label: string, value: string): void => {
    console.log(`${color.boldCyan(label)} ${color.dim(value)}`)
  }
  banner('Project:', project.name)
  banner('Working directory:', primaryRoot(project).path)
  banner('Filesystem access:', target.accessMode)
  banner(
    'MCP:',
    mcpToolSet === undefined
      ? 'disabled'
      : `${mcpToolSet.servers.length} server(s) · ${mcpToolSet.tools.length} searchable tool(s) · ${mcpToolSet.configPath}`,
  )
  banner(
    'WebFetch:',
    webFetch
      ? 'enabled (default ports, public hosts only)'
      : 'disabled (start without --no-web-fetch to enable)',
  )
  banner(
    'WebSearch:',
    webSearch === undefined
      ? 'disabled (set AGENT_WEB_SEARCH=true to enable)'
      : `enabled (${webSearch.model ?? 'qwen3.7-flash'} · ${webSearch.endpoint ?? 'dashscope.aliyuncs.com'})`,
  )
  banner(
    'Trace:',
    `${traceMode} · Ctrl+O toggles compact/verbose · Tool Result preview: ${traceMaxResultChars} chars`,
  )
  banner(
    'Loop Guard:',
    `exact repeats ${loopGuardThresholds.join('/')} via ${loopGuardModelName} · no progress ${noProgressThresholds.join('/')} steps`,
  )
  banner(
    'Context compaction:',
    contextLimits === undefined
      ? 'manual only'
      : `automatic at ${contextLimits.autoCompactTokenLimit} estimated tokens`,
  )
  banner('Session:', session.id)
  console.log(`Type ${color.cyan('/')} then Tab for commands. Resume later with: ${color.cyan('ai-agent --session <session-id>')}`)

  await recoverSession(session)

  try {
    while (true) {
      waitingForPrompt = true
      const prompt = (await terminal.question('\nYou> ')).trim()
      waitingForPrompt = false
      if (prompt === '/exit') break
      if (prompt === '/' || prompt === '/help') {
        console.log(slashCommandHelp(color))
        continue
      }
      if (prompt === '/resume') {
        const sessionId = await selectProjectSession({
          sessions: await store.listSessionsForProject(project.id),
          currentSessionId: session.id,
          ask: async question => await terminal.question(question),
          write: text => console.log(text),
          color,
        })
        if (sessionId === undefined) continue
        session = await AgentSession.resume(sessionId, sessionOptions)
        console.log(`${color.boldCyan('Session:')} ${color.dim(session.id)}`)
        await recoverSession(session)
        continue
      }
      if (prompt === '/retry') {
        try {
          await session.continueTurn()
        } catch (error: unknown) {
          console.error(`${color.boldRed('Agent recovery error:')} ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }
      if (prompt === '/compact') {
        try {
          const result = await session.compact()
          console.log(
            `${color.boldGreen('Context checkpoint')} ${color.dim(`${result.checkpointNumber} installed · estimated tokens ${result.estimatedTokensBefore} → ${result.estimatedTokensAfter}`)}`,
          )
        } catch (error: unknown) {
          console.error(`${color.boldRed('Context compaction error:')} ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }
      if (prompt.startsWith('/')) {
        console.error(`${color.boldRed('Unknown slash command:')} ${color.red(prompt)}`)
        console.log(slashCommandHelp(color))
        continue
      }
      if (!prompt) continue

      try {
        await session.send(prompt)
      } catch (error: unknown) {
        console.error(`${color.boldRed('Agent error:')} ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    waitingForPrompt = false
    traceShortcut.close()
    elapsedDisplay.close()
    terminal.close()
  }
} finally {
  try {
    await Promise.all([
      ...codeTools.map(async tool => await tool.close?.()),
      ...(mcpToolSet === undefined ? [] : [mcpToolSet.close()]),
    ])
  } finally {
    await store.close()
  }
}

async function projectForSession(sessionId: string) {
  const snapshot = await store.loadSession(sessionId)
  if (!snapshot) throw new Error(`Unknown session: ${sessionId}`)
  if (!snapshot.projectId) {
    throw new Error(`Session ${sessionId} is not attached to a project`)
  }
  return await catalog.get(snapshot.projectId)
}

async function recoverSession(session: AgentSession): Promise<void> {
  if (!session.hasRecoverableTurn()) return
  console.log('Recovering the unfinished Turn from its persisted Steps...')
  try {
    await session.continueTurn()
  } catch (error: unknown) {
    console.error(`Agent recovery error: ${error instanceof Error ? error.message : String(error)}`)
  }
}
