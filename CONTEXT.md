# AI Agent

这个上下文描述一个 Code Agent 如何在授权目录中持续处理用户输入、调用工具并保留可恢复的执行过程。

## Language

### Agent execution

**Agent**:
在 Session 中接收用户目标，并通过 Agent Loop 产生最终答案或失败结果的执行主体。
_Avoid_: Model、Assistant

**Agent Loop**:
Turn 内由模型推理、可选 Tool Call Batch 执行和结果反馈组成的迭代过程，直到得到最终答案、失败或达到 Step 上限。
_Avoid_: Session、Turn

**Model**:
根据当前 Messages 和可用 Tools 返回最终答案或 Tool Call Batch 的决策能力。
_Avoid_: Agent、Provider

**Tool**:
Agent 可调用的一项具名能力，包含模型可见的参数说明和 Runtime 可执行的行为。
_Avoid_: Tool Call、Action

**Tool Call**:
模型在一个 Step 中选择 Tool 并给出参数的一次执行请求。
_Avoid_: Tool、Action

**Tool Result**:
Runtime 执行 Tool Call 后产生并反馈给模型的结果，属于发起调用的同一个 Step。
_Avoid_: Final Answer、Message

**Tool Call Batch**:
模型在一个 Step 中返回的一组 Tool Calls。仅当所有目标 Tools 都声明为 parallel-safe 时并行执行，仍然只计为一个 Step。
_Avoid_: Multi-Step、Read Many

### Project filesystem

**Project**:
持久化的一组代码目录，拥有唯一的 Primary Root 和零个或多个 Attached Root；Session 绑定到一个 Project。
_Avoid_: Repository、Root

**Project Root**:
Project 授权 Agent 使用的一个本地目录。一个 Project 可以包含多个 Project Roots。
_Avoid_: Project、Working Directory

**Primary Root**:
Project 中唯一的默认工作目录，相对路径和对话的默认代码上下文从这里解析。
_Avoid_: Current Directory、Main Project

**Attached Root**:
Project 中除 Primary Root 外的授权目录，不改变默认工作目录。
_Avoid_: Secondary Project、Dependency

**Filesystem Tool**:
绑定到一个 Project，并在所选 Project Root 内执行文件操作的 Tool。路径授权由 Runtime 强制执行，不依赖模型遵守 Prompt。
_Avoid_: Global Tool、Project Tool

**Filesystem Access Mode**:
当前 CLI 进程对 Filesystem Tool 的 Root 授权策略。`scoped` 只允许 Project Roots，`full` 允许读取和修改任意本地绝对目录；不属于 Session 持久状态。
_Avoid_: Project Permission、Session Permission

**Read**:
读取 Project Root 内一个 UTF-8 文本文件的有界行范围。
_Avoid_: Fetch、Open

**Edit**:
在 Project Root 内的已有 UTF-8 文件中精确替换唯一一处文本。Edit 不创建文件，并以原子文件替换提交修改。
_Avoid_: Write、Patch、Search and Replace All

**Write**:
在 Project Root 内创建一个此前不存在的 UTF-8 文件。Write 不覆盖已有路径。
_Avoid_: Edit、Overwrite、Append

**Glob**:
按相对路径模式查找 Project Root 内的候选文件。
_Avoid_: List Files、Find Files

**Grep**:
按正则表达式搜索 Project Root 内的文件内容，并返回匹配文件和行号。
_Avoid_: Search Text、Search

**Bash**:
在本机 Bash 进程中执行命令的 Code Tool，拥有与 Agent CLI 进程相同的系统权限，不受工作目录限制。
_Avoid_: Terminal、Sandbox、Shell Script

**LSP**:
通过 Language Server Protocol 查询源码定义、引用和类型信息的只读 Code Tool。
_Avoid_: Grep、Type Checker、Compiler

### Conversation lifecycle

**Session**:
一次绑定到 Project、可跨进程恢复的连续对话，由按顺序发生的多个 Turn 组成。
_Avoid_: Conversation、Chat

**Turn**:
从一条用户输入开始，到 Agent 返回最终答案或失败为止的一次处理过程。
_Avoid_: Round、Request

**Step**:
Turn 内一次成功 Model Invocation 产生的模型决策；结果是最终答案，或者一组需要执行的 Tool Calls。
_Avoid_: Turn、Action

**Message**:
提供给模型的上下文条目。Message 是已完成 Turn 的投影，不等同于完整执行记录。
_Avoid_: Event、Log

### Observability

**Model Invocation**:
Runtime 请求 Model 产生下一个 Step 的一次逻辑调用。一次 Model Invocation 可能因重试产生多个 Provider Attempts，也可能失败而不产生 Step。
_Avoid_: Provider Attempt、Step

**Provider Attempt**:
Model Invocation 为获得响应而向模型供应商发起的一次实际请求；重试是同一 Model Invocation 下的新 Provider Attempt。
_Avoid_: Model Invocation、Step

**Agent Event**:
Runtime 在执行过程中同步发出的只读观察记录，用于 CLI 时间线、日志或未来 UI；不会成为 Message，也不改变 Agent 决策。
_Avoid_: Message、Session Record

**Execution Trace**:
一个 Turn 的 Agent Events 按发生顺序形成的可观察执行链路，包括 Model Invocation、Provider Attempt、模型输出、Tool Call、Tool Result、耗时和最终状态。
_Avoid_: Message History、Model Context

**Reasoning Content**:
模型供应商在响应中显式返回的推理文本。Runtime 只透传真实字段；供应商未返回时明确显示 unavailable，不从 Final Content 推测或生成。
_Avoid_: Hidden Reasoning、Explanation
