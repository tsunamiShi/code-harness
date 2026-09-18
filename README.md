# AI Agent

这是一个从最小 Agent Loop 演进为可部署 Code Agent 的 TypeScript 项目。当前版本支持真实模型、工具调用、多轮对话、Multi-root Project、受 Project Root 约束的代码探索和精确文件修改，以及 MySQL 持久化和恢复。

## 当前运行模型

```text
Project
  ├─ Primary Root（默认工作目录）
  ├─ Attached Root
  └─ Session（可恢复的连续对话）
       └─ Turn（一次用户输入到最终答案或失败）
            └─ Step（一次模型推理，以及可选的一组工具执行）
```

`ProjectCatalog` 管理本地目录选择，`AgentSession` 控制 Agent Loop，`Model` 适配模型供应商，`Tool` 暴露外部能力，存储接口隔离持久化实现。正式 CLI 使用 `MysqlAgentStore`；一次性调用和单元测试可使用内存 Adapter。

数据库保留完成和失败的 Turn/Step，并单独记录每次 Model Invocation 及其 Provider Attempts。发送给模型的 `messages` 只从已完成 Turn 投影，失败记录和观测数据不会污染后续上下文。

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

`models/openai-compatible-chat-model.ts` 按协议而不是模型品牌命名。它通过 OpenAI-compatible Chat Completions 协议连接当前 `.env` 配置的模型，因此可以使用百炼提供的 Qwen、GLM 或其他兼容模型，而不需要为每个模型复制一个 Adapter。

## Filesystem Tools

CLI 在 Scoped 模式暴露六个代码工具：

- `Glob`：按相对路径模式定位候选文件。
- `Grep`：使用正则表达式定位匹配行。
- `Read`：读取一个 UTF-8 文本文件的指定行范围。
- `Edit`：在已有 UTF-8 文件中精确替换唯一一处文本。
- `Write`：创建一个此前不存在的 UTF-8 文件。
- `LSP`：查询 Vue/TypeScript/JavaScript 的源码定义、引用和 Hover 类型信息。

前五个 Filesystem Tools 默认使用 Project 的 Primary Root；`root` 参数可以选择一个 Attached Root。所有路径都必须相对于所选 Root，运行时会检查规范路径和符号链接的真实目标。结果包含固定上限和截断标记，Tool Error 会写入 Step 并返回模型修正，而不是直接结束 Turn。

`Edit` 要求 `oldText` 在不超过 2 MB 的目标文件中恰好出现一次，单个 `oldText` 或 `newText` 最多 64,000 字符。它先写入同目录临时文件、复查原文件未变化，再原子替换目标并返回修改行范围和修改前后的 SHA-256。`Edit` 不支持创建文件。

`Write` 接收最多 64,000 字符的完整内容，只创建新文件，不覆盖任何已有文件或符号链接，也不自动创建父目录。它先完成同目录临时文件，再以排他方式发布目标，并返回字符数、字节数和 SHA-256，而不重复返回完整内容。

`LSP` 当前支持 `definition / references / hover`，并按文件类型选择语言服务：TypeScript/JavaScript 使用 `typescript-language-server`，Vue SFC 使用 `@vue/language-server` 与 `@vue/typescript-plugin` 组成的复合适配器。Vue Language Server 负责 SFC 文档服务及其自定义协议，Vue TypeScript Plugin 通过 `tsserver` 提供 `<script>` 内的 TypeScript 语义。这个差异被封装在同一个模型可见工具后面，避免为每种语言增加一套工具。

模型统一使用从 1 开始的行列号，Runtime 将不同协议结果归一化为 Root 相对路径，并过滤所选 Root 之外的位置。同一个 CLI 进程按 Project Root 和语言 Provider 复用 Language Server；查询前通过 `didOpen / didChange` 同步当前文件，单个客户端内串行执行协议请求。客户端池最多保留四组进程，使用 LRU 回收较旧的 Root；CLI 退出时通过 Tool 的 `close()` 生命周期钩子关闭全部子进程。进程意外退出后，下一次只读查询会重建客户端并重试一次。

Full Access 模式额外暴露 `Bash`。它以选定 Root 或其相对子目录为 `cwd`，返回退出码、信号、stdout、stderr、超时和截断信息；非零退出属于可供模型修正的执行结果。当前默认超时 30 秒、最大 120 秒，stdout/stderr 各最多返回 64,000 字符。

模型可以在同一个 Step 返回多个 Tool Calls。`Read / Glob / Grep` 声明为 parallel-safe，因此同批调用会并行执行并按模型给出的顺序写回结果。默认每个 Turn 最多执行 50 个模型 Step，可在 `.env` 使用 `AGENT_MAX_STEPS` 配置为 1 到 500；最后一个可用 Step 不再提供 Tools，保留给模型生成最终答案。

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

先创建 Project。`--primary` 必须出现一次，`--root` 可以重复：

```sh
pnpm project create \
  --name my-project \
  --primary /absolute/path/to/main-repository \
  --root /absolute/path/to/shared-package
pnpm project list
pnpm project show <project-id>
```

给已有 Project 增加 Attached Root：

```sh
pnpm project attach <project-id> --path /absolute/path/to/another-directory
pnpm project show <project-id>
```

重复添加同一个目录不会产生重复 Root。正在运行的 CLI 使用启动时加载的 Project；添加后需要退出并用 Session ID 恢复，才能让该 Session 的 `Read / Glob / Grep` 获得新 Root。

从 Project 创建新 Session：

```sh
pnpm chat -- --project <project-id>
```

需要跳过 Project Root 白名单时，可以为当前 CLI 进程显式开启完全文件系统访问：

```sh
pnpm chat -- --project <project-id> --full-access
```

恢复 Session 时同样可以选择该模式：

```sh
pnpm chat -- --session <session-id> --full-access
```

`--full-access` 允许全部 Filesystem Tools 选择任意存在的绝对目录作为 `root`，包括通过 `Edit / Write` 修改或创建文件。工具仍然执行相对路径、符号链接、文件类型、结果上限、超时和内容大小检查。该授权不写入数据库，下次启动必须重新声明；操作系统权限和 macOS 隐私控制仍可能拒绝访问。

Full Access 还会启用 `Bash`。`cwd` 不是安全边界：Shell 命令可以使用绝对路径或自行切换目录，因此在没有 OS sandbox 的阶段，Scoped 模式不会向模型提供 Bash。

CLI 会显示 Primary Root 和新 Session ID。正常退出后可以恢复：

```sh
pnpm chat -- --session <session-id>
```

每个 Turn 会打印结构化 Execution Trace：Step 编号、模型请求中的 Message/Tool 数量、模型耗时、供应商返回的 Reasoning Content、Tool Call 参数、串行或并行调度方式、Tool Result、最终 Content 和 Turn 总耗时。Final Content 会把模型返回的 Markdown 渲染成适合当前终端宽度的标题、列表、强调、代码块、表格和链接预览；数据库仍保存原始 Markdown。Tool Result 在终端最多显示 4,000 字符，完整结果仍会写入数据库并反馈给模型。MySQL 还会持久化 Model Invocation 的输入规模、Token Usage、结束原因和错误，以及每次实际 Provider Attempt 的 HTTP 状态、Request ID、错误与时间。

Reasoning Content 只来自供应商响应的 `reasoning_content` 字段。并非所有模型或每个响应都会返回该字段；未返回时 CLI 会明确显示 `Provider reasoning: not returned`，不会把 Runtime 自己生成的说明伪装成模型思考。Reasoning Content 原文仍只存在于实时 Trace；数据库仅保留其字符数和供应商报告的 reasoning token 数。

## 数据表

- `agent_projects`：可复用的 Project 身份。
- `agent_project_roots`：Primary Root 和 Attached Roots。
- `agent_sessions`：Session 身份与生命周期。
- `agent_turns`：用户输入、顺序、完成/失败状态和错误。
- `agent_steps`：每次成功模型决策及其最终输出或 Tool Call Batch。
- `agent_tool_calls`：Step 内每个 Tool Call 的参数、状态、结果和错误。
- `agent_model_invocations`：每个 Step 对应的逻辑模型调用，包括失败后未产生 Step 的调用。
- `agent_model_attempts`：一次 Model Invocation 下每个实际供应商请求及 SDK 重试。
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

## 当前限制

- 单个 Session 同时只允许一个运行中的 Turn。
- 当前 `Edit / Write` 只支持修改或创建文本文件；尚未加入文件删除。
- Edit / Write 当前没有交互式 Approval；Full Access 会显式扩大其写入范围。
- Bash 尚无 OS sandbox、Approval、交互式 stdin 和持久终端；只能在 Full Access 下执行一次性命令。
- LSP 当前只支持 Vue/TypeScript/JavaScript；首次查询仍有 Language Server 冷启动成本，Vue Provider 还需要额外启动启用 Vue 插件的 `tsserver`。
- Project 支持追加 Attached Root，但尚未支持移除 Root、更换 Primary Root 和运行时热更新。
- 异常退出可能留下 `running` Turn；尚未实现租约和自动恢复。
- 工具副作用与结果入库不是一个原子事务；自动重试前需要幂等键或 outbox。
- 长对话尚未加入上下文窗口预算、摘要和裁剪策略。
- Execution Trace 尚未支持 JSON 日志、Trace ID 导出和持久化查询接口；模型调用遥测已经持久化到 MySQL。
