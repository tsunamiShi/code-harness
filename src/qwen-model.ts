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
      tools: input.tools.map(toProviderTool),
      parallel_tool_calls: false,
    });
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("Qwen returned no completion choice");

    const calls = message.tool_calls ?? [];
    if (calls.length > 1) {
      throw new Error(
        `Qwen returned ${calls.length} tool calls, but this runtime supports one per step`,
      );
    }
    const call = calls[0];
    if (call) {
      if (call.type !== "function") {
        throw new Error(`Unsupported Qwen tool call type: ${call.type}`);
      }
      return {
        kind: "tool-call",
        call: {
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
        },
      };
    }

    if (!message.content)
      throw new Error("Qwen returned neither a tool call nor text");
    return { kind: "final", content: message.content };
  }
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
  if (message.role === "user") return message;
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if ("toolCall" in message) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: message.toolCall.id,
          type: "function",
          function: {
            name: message.toolCall.name,
            arguments: JSON.stringify(message.toolCall.arguments),
          },
        },
      ],
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
