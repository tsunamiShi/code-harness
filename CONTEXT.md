# AI Agent

这个上下文描述一个 Code Agent 如何在授权目录中持续处理用户输入、调用工具并保留可恢复的执行过程。

## Language

### Agent execution

**Agent**:
在 Session 中接收用户目标，并通过 Agent Loop 产生最终答案或失败结果的执行主体。
_Avoid_: Model、Assistant

**Agent Loop**:
Turn 内由模型推理、可选 Tool Call Batch 执行和结果反馈组成的迭代过程，直到得到最终答案或遇到异常。Agent Loop 不按 Step 数量终止。
_Avoid_: Session、Turn

**Loop Guard**:
在 Tool Step 完成后观察执行轨迹的 Runtime Policy。当前 Policy 分别识别精确重复 Tool Call，以及连续多个 Step 没有成功文件修改的无进展状态；它们只生成弱提醒，不阻塞 Tool Call，也不终止 Turn。
_Avoid_: Max Steps、Request Timeout

**Loop Guard Reminder**:
Loop Guard 命中确定性阈值后产生并持久化的建议性 Message。它作为普通 User Message 进入主模型上下文，不属于 System Prompt，也不拥有 stop、redirect 或 Tool 授权能力。精确重复 Policy 可以请求独立小模型决定是否提醒；无进展 Policy 只生成固定文本。
_Avoid_: Model Invocation、Tool Call

**Tool Effect**:
Runtime 对 Tool 行为的静态分类。`observe` 读取状态，`mutate` 可以产生持久文件修改，`execute` 运行无法由 Runtime 精确判断副作用的命令。无进展 Policy 只把成功的 `mutate` Tool Call 视为文件进展。
_Avoid_: Tool Result、Filesystem Access Mode

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
Project 中唯一的默认工作目录，也是模型开始代码探索时的首要绝对路径。
_Avoid_: Current Directory、Main Project

**Attached Root**:
Project 中除 Primary Root 外的授权目录，不改变默认工作目录。
_Avoid_: Secondary Project、Dependency

**Filesystem Tool**:
绑定到一个 Project，并使用绝对路径执行文件操作的 Tool。Scoped 模式下，Runtime 根据规范路径识别所属 Project Root 并强制授权，不依赖模型选择 Root 或遵守 Prompt。
_Avoid_: Global Tool、Project Tool

**Filesystem Access Mode**:
当前 CLI 进程对 Filesystem Tool 绝对路径的授权策略。`scoped` 只允许 Project Roots 内的规范路径，`full` 允许读取和修改任意本地绝对路径；不属于 Session 持久状态。
_Avoid_: Project Permission、Session Permission

**Read**:
读取一个绝对路径所指向 UTF-8 文本文件的有界行范围。结果同时报告文件总行数,使模型可以在一次后续调用中请求完整剩余范围,而不是盲目分页。
_Avoid_: Fetch、Open

**Edit**:
在绝对路径所指向的已有 UTF-8 文件中精确替换唯一一处文本。Edit 不创建文件，并以原子文件替换提交修改。
_Avoid_: Write、Patch、Search and Replace All

**Write**:
在绝对路径创建一个此前不存在的 UTF-8 文件。Write 不覆盖已有路径。
_Avoid_: Edit、Overwrite、Append

**Glob**:
在一个绝对目录路径下按相对 Glob 模式查找候选文件，并返回绝对文件路径；开启 includeDirectories 后同时返回匹配的目录，可用 pattern `*` 完成一层目录列举。
_Avoid_: List Files、Find Files

**Grep**:
按正则表达式搜索绝对文件或目录路径，并返回匹配文件的绝对路径和行号；可通过 before 与 after 参数附带每个匹配行前后指定数量的上下文行。上下文行不计入 maxResults 限制。
_Avoid_: Search Text、Search

**Bash**:
以绝对 `cwd` 在本机 Bash 进程中执行命令的 Code Tool，拥有与 Agent CLI 进程相同的系统权限；`cwd` 不构成权限限制。
_Avoid_: Terminal、Sandbox、Shell Script

**LSP**:
通过 Language Server Protocol 查询源码定义、引用和类型信息的只读 Code Tool。
_Avoid_: Grep、Type Checker、Compiler

### Conversation lifecycle

**Session**:
一次绑定到 Project、可跨进程恢复的连续对话，由按顺序发生的多个 Turn 组成。
_Avoid_: Conversation、Chat

**Turn**:
从一条用户输入开始，到 Agent 返回最终答案为止的一次处理过程。异常会将 Turn 暂时标记为 failed，但恢复后仍继续同一个 Turn。
_Avoid_: Round、Request

**Step**:
Turn 内一次成功 Model Invocation 产生的模型决策；结果是最终答案，或者一组需要执行的 Tool Calls。
_Avoid_: Turn、Action

**Message**:
提供给模型的上下文条目。Message 是已完成 Turn，以及最后一个可恢复 Turn 中已持久化 Steps 的投影，不等同于完整执行记录。
_Avoid_: Event、Log

### Observability

**Model Invocation**:
Runtime 请求 Model 产生下一个 Step 的一次逻辑调用。一次 Model Invocation 可能因重试产生多个 Provider Attempts，也可能失败而不产生 Step。
_Avoid_: Provider Attempt、Step

**Max Tokens**:
可选的单次 Model Invocation 输出 Token 上限。未配置时 Runtime 不设置该上限，由 Provider 和 Model 决定默认值；配置后也不累计整个 Turn 或 Agent 任务的 Token 消耗，不限制 Step 数量。
_Avoid_: Turn Budget、Context Window

**Provider Attempt**:
Model Invocation 为获得响应而向模型供应商发起的一次实际请求；重试是同一 Model Invocation 下的新 Provider Attempt。
_Avoid_: Model Invocation、Step

**Agent Event**:
Runtime 在执行过程中同步发出的只读观察记录，用于 CLI 时间线、日志或未来 UI；不会成为 Message，也不改变 Agent 决策。
_Avoid_: Message、Session Record

**Execution Trace**:
一个 Turn 的 Agent Events 按发生顺序形成的可观察执行链路，包括 Model Invocation、Provider Attempt、模型输出、Tool Call、Tool Result、耗时和最终状态。
_Avoid_: Message History、Model Context

**Trace Mode**:
CLI 对同一组 Agent Events 的展示密度。`compact` 折叠成功的只读感知工具，`verbose` 展示每个 Tool Call 的完整参数与结果；不改变持久化或模型上下文。
_Avoid_: Log Level、Tool Policy

**Reasoning Content**:
模型供应商在响应中显式返回的推理文本。Runtime 只透传真实字段；供应商未返回时明确显示 unavailable，不从 Final Content 推测或生成。
_Avoid_: Hidden Reasoning、Explanation
