# AI Agent

这是一个从最小 Agent Loop 开始、逐步演进 AI Agent 系统设计的学习项目。

## 当前版本：Multi-turn Session + LLM + Tools

```text
User
  -> AgentSession.send()
  -> Model
  -> Tool call
  -> Tool result
  -> Model
  -> Final answer
  -> retain completed turn
  -> next AgentSession.send()
```

第一版只有三个概念：

- `Model`：根据消息历史选择调用工具或返回最终答案。
- `Tool`：执行一个外部能力并返回文本结果。
- `AgentSession`：拥有多轮消息历史，每次串行执行一个 Turn。
- `runAgent()`：为不需要多轮状态的调用方提供一次性兼容入口。

`src/demo.ts` 使用确定性的脚本模型和虚构数据，因此不需要 API Key。它只承担可重复测试，不是产品运行入口。

`src/live-agent.ts` 使用阿里云百炼的真实模型。模型收到消息和 JSON Schema 工具描述，自主决定是否调用工具；本地 Runtime 执行工具，再把结果返回模型。

## 运行

```sh
pnpm install
pnpm test
pnpm demo
pnpm agent
pnpm chat
```

真实调用从被 Git 忽略的 `.env` 读取：

```text
DASHSCOPE_API_KEY=...
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
```

提交配置模板 `.env.example`，不要提交 `.env`。

`pnpm chat` 启动真实多轮 CLI；输入 `/exit` 退出。当前 Session 位于进程内存中，退出 CLI 后不会恢复。

## Architecture decisions

- [ADR-001: Session owns multi-turn conversation history](docs/decisions/001-session-owns-conversation-history.md)

## 暂不加入

Planner、Memory、Multi-Agent、持久化和权限留给后续需求驱动的演进。当前真实模型 Adapter 已设置请求超时和一次网络重试，但还没有 Agent 级重试策略。消息历史也还没有压缩或上下文窗口预算。
