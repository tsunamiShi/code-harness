import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions'

import type { Message, Model, ModelOutput } from '../runtime/types.ts'

export interface OpenAICompatibleChatTextModelOptions {
  apiKey: string
  baseURL: string
  model: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

/** OpenAI-compatible Chat Completions adapter for independent tool-free text requests. */
export class OpenAICompatibleChatTextModel implements Model {
  private readonly client: OpenAI
  readonly descriptor

  constructor(private readonly options: OpenAICompatibleChatTextModelOptions) {
    const maxRetries = options.maxRetries ?? 1
    this.descriptor = {
      provider: new URL(options.baseURL).hostname,
      model: options.model,
      protocol: 'openai-chat',
      ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
      maxRetries,
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      maxRetries,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }

  async generate(input: Parameters<Model['generate']>[0]): Promise<ModelOutput> {
    if (input.tools.length > 0) {
      throw new Error('OpenAICompatibleChatTextModel does not accept Tools')
    }
    const completion = await this.client.chat.completions.create({
      model: this.options.model,
      messages: input.messages.map(toChatMessage),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    })
    const choice = completion.choices[0]
    if (choice === undefined) throw new Error('Model provider returned no completion choice')
    if (choice.message.tool_calls !== undefined && choice.message.tool_calls.length > 0) {
      throw new Error('Model provider returned Tool Calls for a tool-free request')
    }
    const content = choice.message.content
    if (content === null || content.trim().length === 0) {
      throw new Error('Model provider returned no output text')
    }
    return {
      kind: 'final',
      content,
      metadata: {
        providerResponseId: completion.id,
        finishReason: choice.finish_reason,
        ...(completion.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: completion.usage.prompt_tokens,
                outputTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              },
            }),
      },
    }
  }
}

function toChatMessage(message: Message): ChatCompletionMessageParam {
  if (message.role === 'system' || message.role === 'user') return message
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if ('toolCalls' in message) {
    throw new Error('OpenAICompatibleChatTextModel does not accept Tool Call history')
  }
  return message
}
