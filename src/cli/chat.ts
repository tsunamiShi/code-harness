import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { OpenAICompatibleChatModel } from '../models/openai-compatible-chat-model.ts'
import { primaryRoot, ProjectCatalog } from '../projects/project.ts'
import { AgentSession } from '../runtime/agent-session.ts'
import { MysqlAgentStore } from '../storage/mysql-agent-store.ts'
import { createWorkspaceTools } from '../tools/workspace-tools.ts'
import { readChatTarget } from './chat-arguments.ts'
import { createConsoleTrace } from './console-trace.ts'
import {
  agentMaxStepsFromEnvironment,
  mysqlOptionsFromEnvironment,
  requiredEnvironment,
} from './config.ts'

const store = await MysqlAgentStore.connect(mysqlOptionsFromEnvironment())
const catalog = new ProjectCatalog(store)
const target = readChatTarget(process.argv.slice(2))
const project = target.kind === 'project'
  ? await catalog.get(target.id)
  : await projectForSession(target.id)
const sessionOptions = {
  model: new OpenAICompatibleChatModel({
    apiKey: requiredEnvironment('DASHSCOPE_API_KEY'),
    baseURL: requiredEnvironment('DASHSCOPE_BASE_URL'),
    model: requiredEnvironment('DASHSCOPE_MODEL'),
  }),
  tools: createWorkspaceTools(project, target.accessMode),
  store,
  project,
  accessMode: target.accessMode,
  maxSteps: agentMaxStepsFromEnvironment(),
  onEvent: createConsoleTrace({
    write: text => console.log(text),
    colors: stdout.isTTY && process.env.NO_COLOR === undefined,
  }),
}
const session = target.kind === 'session'
  ? await AgentSession.resume(target.id, sessionOptions)
  : await AgentSession.create(sessionOptions)
const terminal = createInterface({ input: stdin, output: stdout })

console.log(`Project: ${project.name}`)
console.log(`Working directory: ${primaryRoot(project).path}`)
console.log(`Filesystem access: ${target.accessMode}`)
console.log(`Session: ${session.id}`)
console.log('Enter /exit to quit. Resume later with: pnpm chat -- --session <session-id>')

try {
  while (true) {
    const prompt = (await terminal.question('\nYou> ')).trim()
    if (prompt === '/exit') break
    if (!prompt) continue

    try {
      await session.send(prompt)
    } catch (error: unknown) {
      console.error(`Agent error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  terminal.close()
  await store.close()
}

async function projectForSession(sessionId: string) {
  const snapshot = await store.loadSession(sessionId)
  if (!snapshot) throw new Error(`Unknown session: ${sessionId}`)
  if (!snapshot.projectId) {
    throw new Error(`Session ${sessionId} is not attached to a project`)
  }
  return await catalog.get(snapshot.projectId)
}
