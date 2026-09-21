import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { OpenAICompatibleResponsesModel } from '../models/openai-compatible-responses-model.ts'
import { OpenAICompatibleChatTextModel } from '../models/openai-compatible-chat-text-model.ts'
import { primaryRoot, ProjectCatalog } from '../projects/project.ts'
import { AgentSession } from '../runtime/agent-session.ts'
import { ModelLoopGuard } from '../runtime/loop-guard.ts'
import { MysqlAgentStore } from '../storage/mysql-agent-store.ts'
import { createCodeTools } from '../tools/code-tools.ts'
import { readChatTarget } from './chat-arguments.ts'
import { createConsoleTrace } from './console-trace.ts'
import { createMarkdownRenderer } from './markdown.ts'
import {
  agentMaxTokensFromEnvironment,
  agentLoopGuardModelFromEnvironment,
  agentLoopGuardThresholdsFromEnvironment,
  agentTraceMaxResultCharsFromEnvironment,
  agentTraceModeFromEnvironment,
  mysqlOptionsFromEnvironment,
  requiredEnvironment,
} from './config.ts'

const store = await MysqlAgentStore.connect(mysqlOptionsFromEnvironment())
const catalog = new ProjectCatalog(store)
const target = readChatTarget(process.argv.slice(2))
const project = target.kind === 'project'
  ? await catalog.get(target.id)
  : await projectForSession(target.id)
const tools = createCodeTools(project, target.accessMode)
const traceMode = agentTraceModeFromEnvironment()
const traceMaxResultChars = agentTraceMaxResultCharsFromEnvironment()
const loopGuardThresholds = agentLoopGuardThresholdsFromEnvironment()
const maxTokens = agentMaxTokensFromEnvironment()
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
const sessionOptions = {
  model,
  loopGuard: new ModelLoopGuard(loopGuardModel, { thresholds: loopGuardThresholds }),
  tools,
  store,
  project,
  accessMode: target.accessMode,
  ...(maxTokens === undefined ? {} : { maxTokens }),
  onEvent: createConsoleTrace({
    write: text => console.log(text),
    mode: traceMode,
    maxToolResultChars: traceMaxResultChars,
    colors: stdout.isTTY && process.env.NO_COLOR === undefined,
    renderMarkdown: createMarkdownRenderer({
      width: Math.max(40, (stdout.columns ?? 100) - 8),
    }),
  }),
}
const session = target.kind === 'session'
  ? await AgentSession.resume(target.id, sessionOptions)
  : await AgentSession.create(sessionOptions)
const terminal = createInterface({ input: stdin, output: stdout })

console.log(`Project: ${project.name}`)
console.log(`Working directory: ${primaryRoot(project).path}`)
console.log(`Filesystem access: ${target.accessMode}`)
console.log(`Trace: ${traceMode} · Tool Result preview: ${traceMaxResultChars} chars`)
console.log(`Loop Guard: ${loopGuardModelName} reminder at exact repeats ${loopGuardThresholds.join('/')}`)
console.log(`Session: ${session.id}`)
console.log('Enter /exit to quit or /retry to continue a failed Turn. Resume later with: pnpm chat -- --session <session-id>')

if (session.hasRecoverableTurn()) {
  console.log('Recovering the unfinished Turn from its persisted Steps...')
  try {
    await session.continueTurn()
  } catch (error: unknown) {
    console.error(`Agent recovery error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  while (true) {
    const prompt = (await terminal.question('\nYou> ')).trim()
    if (prompt === '/exit') break
    if (prompt === '/retry') {
      try {
        await session.continueTurn()
      } catch (error: unknown) {
        console.error(`Agent recovery error: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (!prompt) continue

    try {
      await session.send(prompt)
    } catch (error: unknown) {
      console.error(`Agent error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  terminal.close()
  try {
    await Promise.all(tools.map(async tool => await tool.close?.()))
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
