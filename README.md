# AI Agent

这是一个从最小 Agent Loop 演进为可部署 Code Agent 的 TypeScript 项目。当前版本支持真实模型、工具调用、多轮对话、Multi-root Project、受 Project Root 约束的代码探索，以及 MySQL 持久化和恢复。

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

数据库保留完成和失败的 Turn/Step。发送给模型的 `messages` 只从已完成 Turn 投影，失败记录不会污染后续上下文。

## Workspace Tools

CLI 向模型暴露三个只读代码探索工具：

- `Glob`：按相对路径模式定位候选文件。
- `Grep`：使用正则表达式定位匹配行。
- `Read`：读取一个 UTF-8 文本文件的指定行范围。

三个工具默认使用 Project 的 Primary Root；`root` 参数可以选择一个 Attached Root。所有路径都必须相对于所选 Root，运行时会检查规范路径和符号链接的真实目标。结果包含固定上限和截断标记，Tool Error 会写入 Step 并返回模型修正，而不是直接结束 Turn。

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

`--full-access` 允许 `Read / Glob / Grep` 选择任意存在的绝对目录作为 `root`，但工具仍然只读，并继续执行结果上限、超时和二进制检查。该授权不写入数据库，下次启动必须重新声明；操作系统权限和 macOS 隐私控制仍可能拒绝访问。

CLI 会显示 Primary Root 和新 Session ID。正常退出后可以恢复：

```sh
pnpm chat -- --session <session-id>
```

每个 Turn 会打印结构化 Execution Trace：Step 编号、模型请求中的 Message/Tool 数量、模型耗时、供应商返回的 Reasoning Content、Tool Call 参数、串行或并行调度方式、Tool Result、最终 Content 和 Turn 总耗时。Tool Result 在终端最多显示 4,000 字符，完整结果仍会写入数据库并反馈给模型。

Reasoning Content 只来自供应商响应的 `reasoning_content` 字段。并非所有模型或每个响应都会返回该字段；未返回时 CLI 会明确显示 `Provider reasoning: not returned`，不会把 Runtime 自己生成的说明伪装成模型思考。当前 Execution Trace 是实时观察输出，Reasoning Content 和耗时尚未持久化。

## 数据表

- `agent_projects`：可复用的 Project 身份。
- `agent_project_roots`：Primary Root 和 Attached Roots。
- `agent_sessions`：Session 身份与生命周期。
- `agent_turns`：用户输入、顺序、完成/失败状态和错误。
- `agent_steps`：每次模型推理及其最终输出或 Tool Call Batch。
- `agent_tool_calls`：Step 内每个 Tool Call 的参数、状态、结果和错误。
- `agent_schema_migrations`：已应用的数据库结构版本。

## Architecture decisions

- [ADR-001: Session owns multi-turn conversation history](docs/decisions/001-session-owns-conversation-history.md)
- [ADR-002: MySQL persists Sessions, Turns, and Steps](docs/decisions/002-mysql-persists-session-turns-and-steps.md)
- [ADR-003: Project groups workspace roots and selects one primary root](docs/decisions/003-project-groups-workspace-roots.md)
- [ADR-004: Project-scoped Read, Glob, and Grep provide filesystem perception](docs/decisions/004-project-scoped-read-only-workspace-tools.md)
- [ADR-005: Projects can attach roots after creation](docs/decisions/005-projects-can-attach-roots-after-creation.md)
- [ADR-006: Full filesystem access is an explicit process mode](docs/decisions/006-full-access-is-an-explicit-process-mode.md)
- [ADR-007: Steps can contain parallel Tool Calls](docs/decisions/007-steps-can-contain-parallel-tool-calls.md)
- [ADR-008: Runtime events drive execution traces](docs/decisions/008-runtime-events-drive-execution-traces.md)

## 当前限制

- 单个 Session 同时只允许一个运行中的 Turn。
- 当前只有只读的 `Read / Glob / Grep`；尚未加入文件修改、Shell 和 LSP。
- Project 支持追加 Attached Root，但尚未支持移除 Root、更换 Primary Root 和运行时热更新。
- 异常退出可能留下 `running` Turn；尚未实现租约和自动恢复。
- 工具副作用与结果入库不是一个原子事务；自动重试前需要幂等键或 outbox。
- 长对话尚未加入上下文窗口预算、摘要和裁剪策略。
- Execution Trace 尚未支持 JSON 日志、Trace ID 导出和持久化查询。
