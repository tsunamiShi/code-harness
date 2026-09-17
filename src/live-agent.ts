import { runAgent } from './agent.ts'
import { QwenModel } from './qwen-model.ts'
import { currentTimeTool } from './tools/current-time.ts'

const apiKey = requiredEnvironment('DASHSCOPE_API_KEY')
const baseURL = requiredEnvironment('DASHSCOPE_BASE_URL')
const modelName = requiredEnvironment('DASHSCOPE_MODEL')
const prompt = process.argv.slice(2).join(' ')
  || '请告诉我上海现在的准确日期和时间。你必须调用工具获取，不能凭记忆回答。'

const answer = await runAgent({
  model: new QwenModel({ apiKey, baseURL, model: modelName }),
  tools: [currentTimeTool],
  prompt,
})

console.log(`\nFinal answer:\n${answer}`)

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
