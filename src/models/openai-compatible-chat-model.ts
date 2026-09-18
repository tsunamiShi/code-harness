import { AsyncLocalStorage } from "node:async_hooks";

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
  Message,
  Model,
  ModelAttemptEvent,
  ModelOutput,
  ToolDescription,
} from "../runtime/types.ts";

export interface OpenAICompatibleChatModelOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

interface AttemptContext {
  nextAttempt: number;
  onAttempt?: (event: ModelAttemptEvent) => Promise<void>;
}

/** OpenAI-compatible Chat Completions adapter for the Runtime's Model interface. */
export class OpenAICompatibleChatModel implements Model {
  private readonly client: OpenAI;
  private readonly attemptContext = new AsyncLocalStorage<AttemptContext>();
  readonly descriptor;

  constructor(private readonly options: OpenAICompatibleChatModelOptions) {
    const requestTimeoutMs = options.timeoutMs ?? 30_000;
    const maxRetries = options.maxRetries ?? 1;
    const provider = new URL(options.baseURL).hostname;
    const baseFetch = options.fetch ?? globalThis.fetch;
    this.descriptor = {
      provider,
      model: options.model,
      protocol: "openai-chat-completions",
      requestTimeoutMs,
      maxRetries,
    };
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: requestTimeoutMs,
      maxRetries,
      fetch: async (input, init) => await this.observedFetch(baseFetch, input, init),
    });
  }

  async generate(input: {
    messages: readonly Message[];
    tools: readonly ToolDescription[];
    onAttempt?: (event: ModelAttemptEvent) => Promise<void>;
  }): Promise<ModelOutput> {
    const { data: completion, request_id: requestId } = await this.attemptContext.run(
      { nextAttempt: 0, ...(input.onAttempt === undefined ? {} : { onAttempt: input.onAttempt }) },
      async () => await this.client.chat.completions.create({
        model: this.options.model,
        messages: input.messages.map(toProviderMessage),
        ...(input.tools.length === 0
          ? {}
          : {
              tools: input.tools.map(toProviderTool),
              parallel_tool_calls: true,
            }),
      }).withResponse(),
    );
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("Model provider returned no completion choice");

    const metadata = {
      ...(requestId === null ? {} : { providerRequestId: requestId }),
      ...(completion.choices[0]?.finish_reason === undefined
        ? {}
        : { finishReason: completion.choices[0].finish_reason }),
      ...(completion.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: completion.usage.prompt_tokens,
              outputTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
              ...(completion.usage.prompt_tokens_details?.cached_tokens === undefined
                ? {}
                : { cachedInputTokens: completion.usage.prompt_tokens_details.cached_tokens }),
              ...(completion.usage.completion_tokens_details?.reasoning_tokens === undefined
                ? {}
                : { reasoningTokens: completion.usage.completion_tokens_details.reasoning_tokens }),
            },
          }),
    };
    const calls = message.tool_calls ?? [];
    const reasoningContent = readReasoningContent(message);
    const content = message.content ?? undefined;
    if (calls.length > 0) {
      return {
        kind: "tool-calls",
        calls: calls.map(call => {
          if (call.type !== "function") {
            throw new Error(`Unsupported model tool call type: ${call.type}`);
          }
          return {
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          };
        }),
        ...(content === undefined ? {} : { content }),
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
        metadata,
      };
    }

    if (!message.content)
      throw new Error("Model provider returned neither a tool call nor text");
    return {
      kind: "final",
      content: message.content,
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
      metadata,
    };
  }

  private async observedFetch(
    fetch_: typeof globalThis.fetch,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const context = this.attemptContext.getStore();
    if (!context?.onAttempt) return await fetch_(input, init);

    const attempt = context.nextAttempt + 1;
    context.nextAttempt = attempt;
    await context.onAttempt({ type: "started", attempt });

    let response: Response;
    try {
      response = await fetch_(input, init);
    } catch (error: unknown) {
      await context.onAttempt({
        type: "failed",
        attempt,
        errorName: errorName(error),
        errorMessage: errorMessage(error),
      });
      throw error;
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok) {
      await context.onAttempt({
        type: "completed",
        attempt,
        httpStatus: response.status,
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      });
    } else {
      await context.onAttempt({
        type: "failed",
        attempt,
        errorName: "HTTPError",
        errorMessage: `HTTP ${response.status}${response.statusText.length === 0 ? "" : ` ${response.statusText}`}`,
        httpStatus: response.status,
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      });
    }
    return response;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    throw new Error(`Model provider returned invalid tool arguments: ${arguments_}`, {
      cause: error,
    });
  }
}
