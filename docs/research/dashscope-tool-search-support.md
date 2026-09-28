# 百炼是否支持 Tool Search

核查日期：2026-09-25（Asia/Shanghai）
范围：阿里云百炼 / DashScope 官方文档、OpenAI 官方文档、Anthropic 官方文档；未发送真实付费 API 请求。

## 结论

**截至核查日期，百炼的 OpenAI-compatible Responses API 没有公开支持 OpenAI 原生 `tool_search`。生产代码应按“不支持”处理。**

这不是说百炼不支持工具调用。百炼支持普通 `function`、若干平台托管工具以及 MCP；缺少的是“把大量工具标记为延迟加载，再由 Responses 服务端搜索并动态载入命中 Schema”的协议和响应事件。

因此当前可依赖的方案是客户端实现：本地维护完整工具目录，只向模型暴露 `ToolSearch`、`ExecuteTool` 和少量常驻工具；模型搜索得到名称和参数契约后，通过 `ExecuteTool` 间接执行真实工具。命中工具的 Schema 只通过 Tool Result 交给模型，不加入后续请求的 `tools` 字段。

## 三种能力不要混为一谈

| 能力 | OpenAI / Anthropic 原生含义 | 百炼公开支持状态 |
| --- | --- | --- |
| 普通 Function Calling | 请求中提供完整工具 Schema，模型输出调用名和参数，客户端执行 | **支持** |
| 托管工具 | Provider 执行网页搜索、代码解释器、文件搜索或连接 MCP 等 | **支持部分类型** |
| Tool Search | 先隐藏大部分工具 Schema，模型需要时搜索并加载少量工具 | **未公开支持** |

`web_search`、`file_search` 名字中虽然有 search，但它们搜索的是网页和知识库内容，不是工具定义。`mcp` 让百炼连接 MCP Server，也不等同于在一批 deferred function 中执行通用 Tool Search。

## 证据

### 1. OpenAI Responses 的原生 Tool Search

OpenAI 当前文档说明，Responses API 的 `tool_search` 只由 `gpt-5.4` 及之后模型支持。启用方式包括：

- 在 `tools` 中加入 `{ "type": "tool_search" }`；
- 对待延迟工具设置 `defer_loading: true`；
- Hosted 模式由 OpenAI 服务端搜索，请求响应中出现 `tool_search_call` 和 `tool_search_output`；
- Client-executed 模式由应用搜索，再返回带完整工具定义的 `tool_search_output`。

来源：[OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)

这是 OpenAI 自己的服务端能力。使用 OpenAI SDK 指向兼容 Base URL，只说明客户端请求格式相似，不代表兼容服务商实现了相同的服务端工具。

### 2. 百炼 OpenAI-compatible Responses 的公开契约不包含 Tool Search

百炼 Responses 文档在“兼容性说明与限制”中明确说明：接口只处理该文档列出的参数，未提及的 OpenAI 参数会被忽略。

该文档列出的 `tools` 类型为：

- `web_search`
- `web_extractor`
- `code_interpreter`
- `web_search_image`
- `image_search`
- `file_search`
- `mcp`
- 自定义 `function`

其中没有：

- `tool_search`
- `namespace`
- `defer_loading`
- `additional_tools`
- `tool_search_call`
- `tool_search_output`

它公开的流式事件和输出项类型也没有 `tool_search_call` / `tool_search_output`。

来源：[百炼 OpenAI兼容 Responses：创建响应](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)（核查时页面元数据更新时间：2026-09-22 01:02:05 CST）

因此准确结论不是“已经实测请求必然失败”，而是：**百炼官方契约没有声明支持，且其兼容性规则不保证未列出的 OpenAI 字段生效，不能用于生产依赖。**

### 3. 百炼官方明确给出的替代路径是客户端搜索

百炼 Kimi-K3 文档专门讨论了大量工具场景，并明确写明“API 层面没有专门的工具搜索接口”。它建议：

1. 客户端只暴露自定义 `search_tools` 和少量核心工具；
2. 应用后端自行搜索工具目录；
3. 把命中的完整工具声明动态插入后续消息；
4. 模型再调用新加载的工具。

这与客户端 Tool Search 的架构相同。不过百炼文档中的“在消息中动态加载工具”目前仅适用于 `kimi-k3` 的 Chat Completions；文档还注明 `kimi-k3` 暂不支持 OpenAI-compatible Responses。因此它不能证明 Qwen Responses 已支持 OpenAI 原生 `tool_search`。

来源：[百炼 Kimi：动态加载工具](https://help.aliyun.com/zh/model-studio/kimi-api)（核查时页面元数据更新时间：2026-09-22 01:01:56 CST）

### 4. 百炼 Anthropic-compatible Messages 也不等于 Anthropic 原生 Tool Search

Anthropic 原生 Tool Search 的协议是：

- 客户端仍发送全部工具定义；
- 对长尾工具设置 `defer_loading: true`；
- 服务端执行 `tool_search_tool_regex_20251119` 或 `tool_search_tool_bm25_20251119`；
- 返回 `server_tool_use`、`tool_search_tool_result` 和 `tool_reference`；
- Anthropic 服务端把引用展开为完整 Schema 后，Claude 再调用业务工具。

来源：[Anthropic Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

百炼虽然提供 Anthropic-compatible `/v1/messages`，但它的公开参数只覆盖普通 `name`、`description`、`input_schema` 工具定义和普通 `tool_use` / `tool_result`。文档没有声明 `defer_loading`、`tool_reference` 或 `tool_search_tool_regex/bm25`。百炼对 Anthropic `web_search` server tool 的支持也是另一项特定托管能力，不能推导出通用 Tool Search。

来源：[百炼 Anthropic兼容 Messages](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)（核查时页面元数据更新时间：2026-09-22 01:01:37 CST）、[百炼联网搜索](https://help.aliyun.com/zh/model-studio/web-search)

### 5. 百炼明确支持的相邻能力

- 自定义 `function`：模型返回 `function_call`，应用执行后回传 `function_call_output`。
- 平台托管工具：`web_search`、`web_extractor`、`code_interpreter`、图片搜索、知识检索。
- MCP：Responses 请求可以配置最多 10 个 SSE MCP Server，百炼执行 MCP 连接并返回 `mcp_call` 相关事件。

来源：[百炼 OpenAI兼容 Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)、[百炼 MCP](https://help.aliyun.com/zh/model-studio/mcp)

这些能力说明百炼可以“调用工具”，但不说明它能“搜索 deferred 工具定义”。

## 对当前 code-harness 的建议

继续采用 Provider-neutral 的客户端实现：

```text
本地完整 Tool Registry
  -> 向百炼只发送核心工具 + ToolSearch + ExecuteTool
  -> 模型调用人工权重 Tool Search
  -> 本地检索并返回 Top 5 名称、描述与输入 Schema
  -> 下一次 Responses 请求的 tools 保持不变
  -> 模型通过 ExecuteTool(tool_name, params) 间接调用
```

当前实现把 MCP 启动快照一次性建成本地索引，只提取 Tool 名称、Tool 描述、参数名称和参数描述，并用显式人工权重排序。`ToolSearch` 固定返回 Top 5，同时返回候选的完整输入 Schema，只决定哪些工具名可以在后续 Step 通过 `ExecuteTool` 调度，不改变 MCP 连接或调用协议。

这个实现有明确代价：百炼侧的模型只能在搜索后的 Tool Result 中看到命中工具的参数 Schema，不能获得 Provider 原生 `tool_reference` 那样的动态 Tool 定义。`ExecuteTool` 会先在客户端校验 `params`；失败作为 Tool Result 返回，模型可按契约修正后继续，同时 Model Invocation 的 `tools` 定义在 Session 内保持稳定。

不要向百炼发送 `{ "type": "tool_search" }` 和 `defer_loading: true` 后假设其具备 OpenAI 或 Anthropic 的服务端语义。若未来百炼官方文档新增以下任一项，再评估原生适配器：

- `tool_search` 工具类型；
- `defer_loading`；
- `tool_search_call` / `tool_search_output`；
- `tool_reference`；
- 明确声明兼容 OpenAI hosted/client tool search 或 Anthropic regex/BM25 tool search。

## 未知项与证据边界

- 本次未调用真实 API，因此没有验证传入未知 `tool_search` 类型时，网关会返回 400、忽略字段，还是存在未公开灰度行为。
- 官方文档只能证明“公开契约未支持”，不能证明服务端绝不存在未公开实现。
- 不应把某个 SDK 已定义相关 TypeScript/Python 类型，当成百炼服务端支持证据；SDK 类型来自上游 OpenAI/Anthropic 协议。
- 百炼功能会更新。上线前应重新检查 Responses、Anthropic-compatible Messages 和模型专页；若要做探测，应使用最小请求在测试业务空间执行，并记录原始 HTTP/SSE，而不是只看 SDK 是否接受参数。
