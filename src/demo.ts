import { runAgent } from './agent.ts'
import type { Model, ModelOutput, Tool } from './types.ts'

class ScriptedResearchModel implements Model {
  private step = 0

  async generate(): Promise<ModelOutput> {
    this.step += 1

    if (this.step === 1) {
      return {
        kind: 'tool-call',
        call: {
          id: 'call-search',
          name: 'search',
          arguments: { query: 'Nvidia latest quarterly earnings' },
        },
      }
    }

    if (this.step === 2) {
      return {
        kind: 'tool-call',
        call: {
          id: 'call-fetch',
          name: 'fetch',
          arguments: { url: 'https://example.com/nvidia-earnings' },
        },
      }
    }

    return {
      kind: 'final',
      content: 'Nvidia 本季度收入继续增长；这是使用演示数据生成的结论。',
    }
  }
}

const tools: Tool[] = [
  {
    description: {
      name: 'search',
      description: 'Search the web.',
      parameters: { type: 'object' },
    },
    async execute(arguments_) {
      return `Search result for ${JSON.stringify(arguments_)}: https://example.com/nvidia-earnings`
    },
  },
  {
    description: {
      name: 'fetch',
      description: 'Read a web page.',
      parameters: { type: 'object' },
    },
    async execute(arguments_) {
      return `Fetched ${JSON.stringify(arguments_)}: revenue grew in this fictional fixture.`
    },
  },
]

const answer = await runAgent({
  model: new ScriptedResearchModel(),
  tools,
  prompt: '研究 Nvidia 最近一个季度的财报，并给我写一份分析。',
})

console.log(answer)
