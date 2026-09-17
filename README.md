# AI Agent

这是一个从最小 Agent Loop 演进为可部署 Code Agent 的 TypeScript 项目。当前版本支持真实模型、工具调用、多轮对话、Multi-root Project，以及 MySQL 持久化和恢复。

## 当前运行模型

```text
Project
  ├─ Primary Root（默认工作目录）
  ├─ Attached Root
  └─ Session（可恢复的连续对话）
       └─ Turn（一次用户输入到最终答案或失败）
            └─ Step（一次模型推理，以及可选的一次工具执行）
```

`ProjectCatalog` 管理本地目录选择，`AgentSession` 控制 Agent Loop，`Model` 适配模型供应商，`Tool` 暴露外部能力，存储接口隔离持久化实现。正式 CLI 使用 `MysqlAgentStore`；一次性调用和单元测试可使用内存 Adapter。

数据库保留完成和失败的 Turn/Step。发送给模型的 `messages` 只从已完成 Turn 投影，失败记录不会污染后续上下文。

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

从 Project 创建新 Session：

```sh
pnpm chat -- --project <project-id>
```

CLI 会显示 Primary Root 和新 Session ID。正常退出后可以恢复：

```sh
pnpm chat -- --session <session-id>
```

## 数据表

- `agent_projects`：可复用的 Project 身份。
- `agent_project_roots`：Primary Root 和 Attached Roots。
- `agent_sessions`：Session 身份与生命周期。
- `agent_turns`：用户输入、顺序、完成/失败状态和错误。
- `agent_steps`：模型最终输出或工具调用、参数、结果和错误。
- `agent_schema_migrations`：已应用的数据库结构版本。

## Architecture decisions

- [ADR-001: Session owns multi-turn conversation history](docs/decisions/001-session-owns-conversation-history.md)
- [ADR-002: MySQL persists Sessions, Turns, and Steps](docs/decisions/002-mysql-persists-session-turns-and-steps.md)
- [ADR-003: Project groups workspace roots and selects one primary root](docs/decisions/003-project-groups-workspace-roots.md)

## 当前限制

- 单个 Session 同时只允许一个运行中的 Turn。
- Project Root 已进入模型上下文，但文件和 Shell 工具尚未实现强制路径检查。
- 异常退出可能留下 `running` Turn；尚未实现租约和自动恢复。
- 工具副作用与结果入库不是一个原子事务；自动重试前需要幂等键或 outbox。
- 长对话尚未加入上下文窗口预算、摘要和裁剪策略。
