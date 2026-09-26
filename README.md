# AI Agent

这是一个从最小 Agent Loop 演进为可部署 Code Agent 的 TypeScript 项目。当前版本支持真实模型、内置与 MCP 工具调用、多轮对话、Multi-root Project、受 Project Root 约束的代码探索和精确文件修改，以及 MySQL 持久化、恢复和长对话上下文压缩。

## 当前运行模型

```text
Project
  ├─ Primary Root（默认工作目录）
  ├─ Attached Root
  └─ Session（可恢复的连续对话）
       └─ Turn（一次用户输入到最终答案或失败）
            └─ Step（一次模型推理，以及可选的一组工具执行）
```

`ProjectCatalog` 管理本地目录选择，`AgentSession` 控制 Agent Loop，`ContextManager` 维护模型上下文预算和 checkpoint，`Model` 适配模型供应商，`Tool` 暴露外部能力，存储接口隔离持久化实现。正式 CLI 使用 `MysqlAgentStore`；一次性调用和单元测试可使用内存 Adapter。

数据库保留完成和失败的 Turn/Step，并单独记录每次 Model Invocation 及其 Provider Attempts。发送给模型的 `messages` 来自已完成 Turn，以及最后一个可恢复 Turn 中已经持久化的 Steps；遥测记录不会进入模型上下文。

## Source layout

```text
src/
├─ runtime/   AgentSession、Agent Loop、Model/Tool/Message 类型和 SessionStore 接口
├─ models/    模型协议 Adapter
├─ tools/     Runtime 可执行的 Tool 实现
├─ projects/  Project、Project Root 和 ProjectCatalog
├─ storage/   内存与 MySQL 持久化 Adapter
└─ cli/       命令入口、参数解析、环境配置和终端输出
```

`models/openai-compatible-responses-model.ts` 按协议而不是模型品牌命名。它通过 OpenAI-compatible Responses API 连接当前 `.env` 配置的主模型，因此可以使用百炼提供的兼容模型，而不需要为每个模型复制一个 Adapter。Adapter 使用 SDK 的原始 SSE 解码流，并从终止事件读取完整 Response，对 Runtime 仍返回一次完整模型决策；这避免让供应商的中间 reasoning 事件顺序受 SDK Response 累积器的额外约束。第一次请求发送 Project System Message 和用户输入；Runtime 持久化每个完成 Step 的 Provider Response ID，后续请求通过 `previous_response_id` 只发送新增的用户输入或 `function_call_output`，不重复发送 System Message，也不重放完整历史。Loop Guard 单独使用 `openai-compatible-chat-text-model.ts`，因为 `ZHIPU/GLM-5.3-Flash` 当前走 Chat Completions，并且 Guard 不需要 Tool Calling。

## Filesystem Tools

CLI 在 Scoped 模式暴露六个代码工具：

- `Glob`：按相对路径模式定位候选文件。
- `Grep`：使用正则表达式定位匹配行。
- `Read`：读取一个 UTF-8 文本文件的指定行范围。
- `Edit`：在已有 UTF-8 文件中精确替换唯一一处文本。
- `Write`：创建一个此前不存在的 UTF-8 文件。
- `LSP`：查询 Vue/TypeScript/JavaScript 的源码定义、引用和 Hover 类型信息。

前五个 Filesystem Tools 统一接收绝对 `path`，不向模型暴露 Root 选择参数。Runtime 根据规范化后的绝对路径识别所属 Primary 或 Attached Root，并检查符号链接的真实目标。Glob、Grep 和 LSP 返回的文件路径同样是绝对路径，可以直接传给 Read、Edit 或后续查询。结果包含固定上限和截断标记，Tool Error 会写入 Step 并返回模型修正，而不是直接结束 Turn。

`Edit` 要求 `oldText` 在不超过 2 MB 的目标文件中恰好出现一次，单个 `oldText` 或 `newText` 最多 64,000 字符。它先写入同目录临时文件、复查原文件未变化，再原子替换目标并返回修改行范围和修改前后的 SHA-256。`Edit` 不支持创建文件。

`Write` 接收最多 64,000 字符的完整内容，只创建新文件，不覆盖任何已有文件或符号链接，也不自动创建父目录。它先完成同目录临时文件，再以排他方式发布目标，并返回字符数、字节数和 SHA-256，而不重复返回完整内容。

`LSP` 当前支持 `definition / references / hover`，并按文件类型选择语言服务：TypeScript/JavaScript 使用 `typescript-language-server`，Vue SFC 使用 `@vue/language-server` 与 `@vue/typescript-plugin` 组成的复合适配器。Vue Language Server 负责 SFC 文档服务及其自定义协议，Vue TypeScript Plugin 通过 `tsserver` 提供 `<script>` 内的 TypeScript 语义。这个差异被封装在同一个模型可见工具后面，避免为每种语言增加一套工具。

模型统一使用从 1 开始的行列号，Runtime 将不同协议结果归一化为绝对路径，并过滤 Language Server Root 之外的位置。同一个 CLI 进程按 Runtime 推导出的 Project Root 和语言 Provider 复用 Language Server；Full Access 路径不属于 Project 时，Runtime 向上寻找最近的 TypeScript、JavaScript、Package 或 Git 项目标记。查询前通过 `didOpen / didChange` 同步当前文件，单个客户端内串行执行协议请求。客户端池最多保留四组进程，使用 LRU 回收较旧的 Root；CLI 退出时通过 Tool 的 `close()` 生命周期钩子关闭全部子进程。进程意外退出后，下一次只读查询会重建客户端并重试一次。

## MCP Tools

CLI 可以把 MCP Server 的工具发现并适配到同一个 Runtime Tool Registry。当前支持 stdio、Streamable HTTP 和显式 legacy SSE transport；兼容 portable `.mcp.json` 的 `mcpServers`，也兼容 VS Code `mcp.json` 的 `servers`。MCP 必须通过 `--mcp-config` 或 `AGENT_MCP_CONFIG` 显式启用，CLI 不会因为 Project 内存在 `.mcp.json` 就自动执行其中的本地命令。

内置代码工具始终直接暴露给模型；MCP 工具完成启动时发现后作为 Searchable Tools 留在 Runtime Catalog 中，模型只额外看到常驻的 `ToolSearch` 和 `ExecuteTool`。模型先搜索，再在后续 Step 用 `ExecuteTool` 的 `tool_name` 和 `params` 调用命中工具。真实 MCP 工具不会加入 Model Invocation 的 `tools` 字段，因此整个 Session 的模型可见工具列表保持稳定。即使模型猜中 MCP 工具名或在搜索的同一批次尝试执行，也不能绕过发现门禁；发现状态会在后续 Turn 中保留，并可从已持久化的 Tool Result 重建。

`ToolSearch` 使用与 CCB keyword search 同类的人工权重：Tool 名称精确词段、部分词段和名称回退分别加 12、6、3 分，参数名称精确和部分命中加 4、2 分，Tool 描述和参数描述命中加 2、1 分；同分时保持注册顺序。索引只包含 Tool 名称、Tool 描述、参数名称和参数描述，不用参数类型、枚举、默认值或其余 JSON Schema 内容参与检索。英文按单词切分并识别 camelCase，中文额外生成二元词组；`+term` 要求候选必须命中该词，`select:<exact_tool_name>` 直接选择已知名称。

`ToolSearch` 只接收 `query` 并固定返回最多五个结果；输出 JSON 同时包含精确工具名数组 `matches` 和每个候选的 `name`、`description`、`input_schema`。参数契约只出现在 Tool Result 中，不会动态修改后续请求的 `tools` 字段。`ExecuteTool` 只允许执行更早 Step 已搜索命中的名称，并在调用真实适配器前用 MCP SDK 的 JSON Schema Validator 校验 `params`。校验失败只阻止当前底层调用：错误作为失败 Tool Result 返回模型，Agent Loop 继续，模型可以按契约修正参数后再次执行。它不发起额外模型请求、不使用向量数据库，也不重新连接 MCP Server。没有配置 MCP 或 Server 未发现工具时，这两个常驻工具都不会暴露。

搜索返回的名称是 `mcp__<server>__<tool>`。只有通过目标 JSON Schema 的 `ExecuteTool.params` 才会交给对应 MCP Tool；MCP Server 仍保留最终的业务校验权。纯文本结果直接返回文本，包含 structured content、图片、音频或资源的结果保留为 JSON。`isError`、参数校验错误、协议错误、transport 错误和超时都会作为失败 Tool Result 持久化并反馈给模型，而不是直接结束 Agent Loop。CLI 退出时会终止远程 session，并关闭全部 client 和 stdio 子进程。

示例 portable 配置：

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "cwd": "${workspaceFolder}",
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "timeoutMs": 60000
    },
    "remote-tools": {
      "type": "http",
      "url": "${MCP_BASE_URL:-https://example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

`type` 可省略：包含 `command` 时推断为 stdio，包含 `url` 时推断为 Streamable HTTP。变量支持 `${VAR}`、`${VAR:-default}` 和 `${workspaceFolder}`；缺失且没有默认值的变量会在任何 Server 启动前使配置失败。`disabled: true` 或 `enabled: false` 可跳过一个条目。不要把令牌直接提交到配置文件。

Full Access 模式额外暴露 `Bash`。它要求一个绝对 `cwd`，返回退出码、信号、stdout、stderr、超时和截断信息；非零退出属于可供模型修正的执行结果。当前默认超时 30 秒、最大 120 秒，stdout/stderr 各最多返回 64,000 字符。

模型可以在同一个 Step 返回多个 Tool Calls。`Read / Glob / Grep` 声明为 parallel-safe，因此同批调用会并行执行并按模型给出的顺序写回结果。Agent Loop 不限制 Step 数量；`AGENT_MAX_TOKENS` 是可选的单次 Model Invocation 输出上限，未配置时不发送 `max_output_tokens`，由 Provider 和 Model 决定默认值。显式配置的上限不累计整个 Turn 的消耗。供应商以 `status=incomplete` 和 `reason=max_output_tokens` 截断响应时，Runtime 将本次调用视为失败，不把不完整文本误判成最终答案。

Loop Guard 在每个完成的 Tool Step 后运行两个可组合 Policy。精确重复 Policy 观察工具名相同且参数规范化后完全相同的连续 Tool Calls，默认在第 3、5、8 次重复时使用独立的 `ZHIPU/GLM-5.3-Flash` 判断是否需要提醒；`AGENT_LOOP_GUARD_THRESHOLDS` 调整阈值，`DASHSCOPE_GUARD_MODEL` 覆盖模型。无进展 Policy 按 Step 统计连续没有成功 `Edit / Write` 的执行，默认在第 12、24 个 Step 直接生成固定提醒，`AGENT_NO_PROGRESS_THRESHOLDS` 调整阈值，不产生额外模型请求。Bash 属于副作用不透明的 `execute` Tool，不被当作明确文件进展。两种提醒都作为普通 User Message 加入上下文，不修改 System Prompt、不撤掉 Tools、不终止 Turn。

Turn 中每个完成的 Tool Call 都会立即持久化。模型请求或进程异常后，Session 保留同一个 Turn 的用户输入、已完成 Tool Calls 和 Tool Results；使用 `--session` 重连时 CLI 自动继续该 Turn，失败后也可输入 `/retry` 再试。进程退出时仍处于 running 且结果尚未持久化的 Tool Call 不会被自动重放，因为 `Edit` 或 `Bash` 可能已经产生副作用；恢复过程会为它写入“结果未知”的 Tool Error，让模型检查当前状态后继续。

## Context Checkpoints

Runtime 会把完整执行历史与模型可见上下文分开保存。Context Compaction 只用一个持久化 Context Checkpoint 替换截至某个已完成 Step 的模型可见前缀；原始 Turn、Step、Tool Call、Tool Result、Loop Guard Reminder、Model Invocation 和 Provider Attempt 均不会被删除。Session 恢复、Provider continuation 丢失后的重放，以及进程重启都会使用同一份 `checkpoint replacement + durable tail` 投影。

自动压缩默认关闭。配置 `AGENT_CONTEXT_WINDOW_TOKENS` 后，Runtime 默认在本地估算或最近 Provider `input_tokens` 达到上下文窗口的 90% 时，于下一次普通模型调用前压缩。也可以用 `AGENT_AUTO_COMPACT_TOKEN_LIMIT` 设置更低的正整数阈值；当同时配置上下文窗口时，该值不能超过窗口的 90%。例如：

```dotenv
AGENT_CONTEXT_WINDOW_TOKENS=131072
AGENT_AUTO_COMPACT_TOKEN_LIMIT=117964
```

交互式 CLI 可输入 `/compact` 手动创建 checkpoint。它要求最新 checkpoint 之后至少存在一个已完成 Step；摘要请求使用同一个主模型，但不携带 Tools 或旧的 `previous_response_id`，并作为 `purpose=compaction` 的 Model Invocation 完整记录。安装成功后，下一次 Agent 请求启动新的 Provider chain。压缩请求只会对其输入中的超大 Tool Result 保留首尾约 10,000 tokens，数据库和正常 Agent 上下文中的原始 Tool Result 不受影响。

## 准备 MySQL

创建本地数据库：

```sh
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS ai_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
```

应用启动时会自动执行当前数据库迁移。连接配置和模型配置都从被 Git 忽略的 `.env` 读取，字段参见 `.env.example`。

## 运行

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:mysql
```

将仓库中的 CLI 入口链接到已经位于 `PATH` 的用户命令目录：

```sh
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/bin/ai-agent.mjs" "$HOME/.local/bin/ai-agent"
ai-agent --version
```

在任意目录直接执行 `ai-agent`，CLI 会用当前目录作为 Primary Root。首次进入该目录时自动创建持久化 Project，之后再次从同一个真实路径启动会复用已有 Project：

```sh
cd /absolute/path/to/project
ai-agent
```

查看完整命令索引或某个命令的详细参数：

```sh
ai-agent help
ai-agent help chat
ai-agent help project
ai-agent help project create
```

`ai-agent chat --help` 和 `ai-agent project create --help` 也会显示对应主题，帮助命令不会连接数据库或启动 Agent Runtime。

进入对话后，输入 `/` 可以查看斜杠命令，输入 `/` 后按 Tab 可以补全。`/resume` 会列出当前 Project 最近使用的 Session；从某个目录直接运行 `ai-agent` 时，这个范围就是该目录所映射的 Project。选择序号后会在当前进程中切换 Session，如果目标 Session 有未完成 Turn，则沿用原有恢复流程继续执行。`/compact` 会在安全的已完成 Step 边界手动创建 Context Checkpoint。

也可以显式管理 Project。`--primary` 必须出现一次，`--root` 可以重复：

```sh
ai-agent project create \
  --name my-project \
  --primary /absolute/path/to/main-repository \
  --root /absolute/path/to/shared-package
ai-agent project list
ai-agent project show <project-id>
```

给已有 Project 增加 Attached Root：

```sh
ai-agent project attach <project-id> --path /absolute/path/to/another-directory
ai-agent project show <project-id>
```

重复添加同一个目录不会产生重复 Root。正在运行的 CLI 使用启动时加载的 Project；添加后需要退出并用 Session ID 恢复，才能让该 Session 的 `Read / Glob / Grep` 获得新 Root。

从 Project 创建新 Session：

```sh
ai-agent --project <project-id>
```

显式连接 MCP Server：

```sh
ai-agent --project <project-id> --mcp-config /absolute/path/to/.mcp.json
```

也可以在 `.env` 中设置 `AGENT_MCP_CONFIG`。命令行参数优先于环境变量。恢复 Session 时需要再次提供或保留该配置，因为 MCP 连接属于当前 CLI 进程，不写入 Session。

需要跳过 Project Root 白名单时，可以为当前 CLI 进程显式开启完全文件系统访问：

```sh
ai-agent --project <project-id> --full-access
```

恢复 Session 时同样可以选择该模式：

```sh
ai-agent --session <session-id> --full-access
```

`--full-access` 允许全部 Filesystem Tools 使用任意绝对路径，包括通过 `Edit / Write` 修改或创建文件。工具仍然执行绝对路径、符号链接、文件类型、结果上限、超时和内容大小检查。该授权不写入数据库，下次启动必须重新声明；操作系统权限和 macOS 隐私控制仍可能拒绝访问。

Full Access 还会启用 `Bash`。`cwd` 不是安全边界：Shell 命令可以使用绝对路径或自行切换目录，因此在没有 OS sandbox 的阶段，Scoped 模式不会向模型提供 Bash。

System Prompt 会说明每个 Code Tool 的职责，要求模型复用 Tool 返回的绝对路径，并优先使用专用工具：文件读取使用 `Read`，文件发现使用 `Glob`，内容搜索使用 `Grep`，语义查询使用 `LSP`，文件修改使用 `Edit / Write`。即使 Full Access 提供了 `Bash`，也只应用于 Git、测试、构建、包管理器和没有专用 Tool 的命令，不应用 Shell 命令重复实现已有文件工具。

CLI 会显示 Primary Root 和新 Session ID。正常退出后可以恢复：

```sh
ai-agent --session <session-id>
```

每个 Turn 会打印结构化 Execution Trace：Step 编号、模型请求中的 Message/Tool 数量、Provider Attempt 时序、Tool 执行、最终 Content 和 Turn 总耗时。交互式终端底部还会每秒刷新截至当前的 Turn 耗时；新 Trace 输出会先清除该临时行再重新显示，完成或失败后则以 Runtime 给出的总耗时为准。非交互输出不会持续刷新，避免污染重定向日志。默认 `AGENT_TRACE=compact`：响应头、首个 SSE Event、事件数和总耗时合并为一行，中间 Provider Reasoning 隐藏，成功的 `Read / Glob / Grep / LSP` 折叠为摘要，Bash 只显示 command 而不显示成功 result。交互式终端按 `Ctrl+O` 可即时切换到 `verbose`，再次按下恢复 `compact`；切换只影响后续输出，不重放已隐藏事件。`verbose` 按 Tool 语义展示 `field: value`，不直接倾倒 JSON，`AGENT_TRACE=verbose` 仍可指定启动时的初始模式。Trace Mode 只改变终端展示，不改变数据库记录或发给模型的 Tool Result。

Final Content 会把模型返回的 Markdown 渲染成适合当前终端宽度的标题、列表、强调、代码块、表格和链接预览；数据库仍保存原始 Markdown。展开的 Tool Result 默认最多保留开头和结尾共 800 个原始字符，中间标明省略数量；可用 `AGENT_TRACE_MAX_RESULT_CHARS` 调整。完整结果仍会写入数据库并反馈给模型。MySQL 还会持久化 Model Invocation 的输入规模、Token Usage、结束原因和错误，以及每次实际 Provider Attempt 的状态阶段、响应头耗时、首个 SSE Event 耗时、事件数、HTTP 状态、Request ID、总耗时和底层错误原因。

Reasoning Content 只来自供应商 Responses 输出中的 `reasoning` item（`summary` 或显式 `content`）。并非所有模型或每个响应都会返回这些内容；未返回时 CLI 会明确显示 `Provider reasoning: not returned`，不会把 Runtime 自己生成的说明伪装成模型思考。Reasoning Content 原文仍只存在于实时 Trace；数据库仅保留其字符数和供应商报告的 reasoning token 数。

## 数据表

- `agent_projects`：可复用的 Project 身份。
- `agent_project_roots`：Primary Root 和 Attached Roots。
- `agent_sessions`：Session 身份与生命周期。
- `agent_turns`：用户输入、顺序、完成/失败状态和错误。
- `agent_steps`：每次成功模型决策及其最终输出或 Tool Call Batch。
- `agent_tool_calls`：Step 内每个 Tool Call 的参数、状态、结果和错误。
- `agent_model_invocations`：普通 Agent Step 与 Context Compaction 对应的逻辑模型调用，包括失败后未产生 Step 的调用。
- `agent_model_attempts`：一次 Model Invocation 下每个实际供应商请求及 SDK 重试，包括 `requesting / headers-received / streaming / completed / failed` 状态、首包指标和底层错误原因。
- `agent_loop_guard_reminders`：精确重复或连续无文件修改命中阈值后生成的弱提醒。
- `agent_context_checkpoints`：不可变的模型上下文 replacement、已覆盖 Step 游标、触发原因和摘要 Model Invocation 引用。
- `agent_schema_migrations`：已应用的数据库结构版本。

## Architecture decisions

- [ADR-001: Session owns multi-turn conversation history](docs/decisions/001-session-owns-conversation-history.md)
- [ADR-002: MySQL persists Sessions, Turns, and Steps](docs/decisions/002-mysql-persists-session-turns-and-steps.md)
- [ADR-003: Project groups project roots and selects one primary root](docs/decisions/003-project-groups-project-roots.md)
- [ADR-004: Project-scoped Read, Glob, and Grep provide filesystem perception](docs/decisions/004-project-scoped-read-only-filesystem-tools.md)
- [ADR-005: Projects can attach roots after creation](docs/decisions/005-projects-can-attach-roots-after-creation.md)
- [ADR-006: Full filesystem access is an explicit process mode](docs/decisions/006-full-access-is-an-explicit-process-mode.md)
- [ADR-007: Steps can contain parallel Tool Calls](docs/decisions/007-steps-can-contain-parallel-tool-calls.md)
- [ADR-008: Runtime events drive execution traces](docs/decisions/008-runtime-events-drive-execution-traces.md)
- [ADR-015: Model Invocations and Provider Attempts are durable](docs/decisions/015-model-invocations-and-provider-attempts-are-durable.md)
- [ADR-009: Source layout follows runtime roles](docs/decisions/009-source-layout-follows-runtime-roles.md)
- [ADR-010: Edit performs scoped exact replacements](docs/decisions/010-edit-performs-scoped-exact-replacements.md)
- [ADR-011: Write creates new Project files without overwriting](docs/decisions/011-write-creates-new-project-files.md)
- [ADR-012: Full access authorizes all Filesystem Tools](docs/decisions/012-full-access-authorizes-all-filesystem-tools.md)
- [ADR-013: Unsandboxed Bash requires full access](docs/decisions/013-unsandboxed-bash-requires-full-access.md)
- [ADR-014: Reuse language servers within the CLI process](docs/decisions/014-reuse-language-servers-within-cli-process.md)
- [ADR-016: Code Tools expose absolute paths](docs/decisions/016-code-tools-expose-absolute-paths.md)
- [ADR-017: Agent Loop has no Step budget and unfinished Turns are recoverable](docs/decisions/017-unbounded-agent-loop-and-turn-recovery.md)
- [ADR-018: Console traces fold successful inspection Tools by default](docs/decisions/018-console-traces-fold-inspection-tools.md)
- [ADR-019: Model requests use transport default timeouts](docs/decisions/019-model-requests-use-transport-default-timeouts.md)
- [ADR-020: Max Tokens is an optional Provider override](docs/decisions/020-max-tokens-is-an-optional-provider-override.md)
- [ADR-021: Repeat Tool Loop Guard is advisory](docs/decisions/021-repeat-tool-loop-guard-is-advisory.md)
- [ADR-022: Responses continue from durable Provider state](docs/decisions/022-responses-continue-from-durable-provider-state.md)
- [ADR-023: No-progress Loop Guard uses Tool effects](docs/decisions/023-no-progress-loop-guard-uses-tool-effects.md)
- [ADR-024: Responses continuation sends System instructions only once](docs/decisions/024-responses-continuation-sends-system-once.md)
- [ADR-025: Responses stream and Provider Attempt milestones are durable](docs/decisions/025-stream-responses-and-persist-attempt-milestones.md)
- [ADR-026: Console Trace toggles density at runtime](docs/decisions/026-console-trace-toggles-density-at-runtime.md)
- [ADR-027: MCP Tools adapt into the Runtime registry](docs/decisions/027-mcp-tools-adapt-into-runtime-registry.md)
- [ADR-031: Context checkpoints bound model-visible history](docs/decisions/031-context-checkpoints-bound-model-history.md)
- [ADR-032: Global CLI defaults to the current directory](docs/decisions/032-global-cli-defaults-to-current-directory.md)
- [ADR-033: Slash commands select Sessions within the current Project](docs/decisions/033-slash-commands-select-project-sessions.md)

## 当前限制

- 单个 Session 同时只允许一个运行中的 Turn。
- 当前 `Edit / Write` 只支持修改或创建文本文件；尚未加入文件删除。
- Edit / Write 当前没有交互式 Approval；Full Access 会显式扩大其写入范围。
- Bash 尚无 OS sandbox、Approval、交互式 stdin 和持久终端；只能在 Full Access 下执行一次性命令。
- LSP 当前只支持 Vue/TypeScript/JavaScript；首次查询仍有 Language Server 冷启动成本，Vue Provider 还需要额外启动启用 Vue 插件的 `tsserver`。
- Project 支持追加 Attached Root，但尚未支持移除 Root、更换 Primary Root 和运行时热更新。
- MCP 当前只接入 Tools；Resources、Prompts、交互式 Elicitation、Sampling callback 和浏览器 OAuth 尚未接入。运行中 Server 的工具列表变化需要重启 CLI。
- CLI 会恢复最终的 `running` 或 `failed` Turn，但尚未实现多进程租约，不能安全支持两个进程同时恢复同一 Session。
- 工具副作用与结果入库不是一个原子事务；自动重试前需要幂等键或 outbox。
- Execution Trace 尚未支持 JSON 日志、Trace ID 导出和持久化查询接口；模型调用遥测已经持久化到 MySQL。
