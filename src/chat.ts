import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { AgentSession } from './agent.ts'
import { QwenModel } from './qwen-model.ts'
import { currentTimeTool } from './tools/current-time.ts'

const session = new AgentSession({
  model: new QwenModel({
    apiKey: requiredEnvironment('DASHSCOPE_API_KEY'),
    baseURL: requiredEnvironment('DASHSCOPE_BASE_URL'),
    model: requiredEnvironment('DASHSCOPE_MODEL'),
  }),
  tools: [currentTimeTool],
})
const terminal = createInterface({ input: stdin, output: stdout })

console.log('Multi-turn Agent ready. Enter /exit to quit.')

try {
  while (true) {
    const prompt = (await terminal.question('\nYou> ')).trim()
    if (prompt === '/exit') break
    if (!prompt) continue

    try {
      const answer = await session.send(prompt)
      console.log(`Agent> ${answer}`)
    } catch (error: unknown) {
      console.error(`Agent error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  terminal.close()
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
