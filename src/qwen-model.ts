import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { Message, Model, ModelOutput, ToolDescription } from "./types.ts";

export interface QwenModelOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
}

/** Alibaba Model Studio adapter for the Agent runtime's Model interface. */
export class QwenModel implements Model {
  private readonly client: OpenAI;

  constructor(private readonly options: QwenModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 30_000,
      maxRetries: 1,
    });
  }

  async generate(input: {
    messages: readonly Message[];
    tools: readonly ToolDescription[];
  }): Promise<ModelOutput> {
    const completion = await this.client.chat.completions.create({
      model: this.options.model,
      messages: input.messages.map(toProviderMessage),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map(toProviderTool),
            parallel_tool_calls: true,
          }),
    });
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("Qwen returned no completion choice");

    const calls = message.tool_calls ?? [];
    const reasoningContent = readReasoningContent(message);
    const content = message.content ?? undefined;
    if (calls.length > 0) {
      return {
        kind: "tool-calls",
        calls: calls.map(call => {
          if (call.type !== "function") {
            throw new Error(`Unsupported Qwen tool call type: ${call.type}`);
          }
          return {
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          };
        }),
        ...(content === undefined ? {} : { content }),
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
      };
    }

    if (!message.content)
      throw new Error("Qwen returned neither a tool call nor text");
    return {
      kind: "final",
      content: message.content,
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
    };
  }
}

function readReasoningContent(message: object): string | undefined {
  const value = Reflect.get(message, "reasoning_content");
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toProviderTool(tool: ToolDescription): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toProviderMessage(message: Message): ChatCompletionMessageParam {
  if (message.role === "system") return message;
  if (message.role === "user") return message;
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if ("toolCalls" in message) {
    return {
      role: "assistant",
      content: null,
      tool_calls: message.toolCalls.map(toolCall => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        })),
    };
  }
  return message;
}

function parseArguments(arguments_: string): unknown {
  try {
    return JSON.parse(arguments_);
  } catch (error: unknown) {
    throw new Error(`Qwen returned invalid tool arguments: ${arguments_}`, {
      cause: error,
    });
  }
}
