# AI Agent

这个上下文描述一个 Code Agent 如何在授权目录中持续处理用户输入、调用工具并保留可恢复的执行过程。

## Language

### Agent execution

**Agent**:
在 Session 中接收用户目标，并通过 Agent Loop 产生最终答案或失败结果的执行主体。
_Avoid_: Model、Assistant

**Agent Loop**:
Turn 内由模型推理、可选工具执行和结果反馈组成的迭代过程，直到得到最终答案、失败或达到 Step 上限。
_Avoid_: Session、Turn

**Model**:
根据当前 Messages 和可用 Tools 返回最终答案或 Tool Call 的决策能力。
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

### Project workspace

**Project**:
一组共同参与代码任务的 Workspace Root，以及供 Session 使用的唯一 Primary Root。
_Avoid_: Workspace、Repository

**Workspace Root**:
Project 授权 Agent 使用的一个本地目录。一个 Project 可以包含多个 Workspace Root。
_Avoid_: Project、Working Directory

**Primary Root**:
Project 中唯一的默认工作目录，相对路径和对话的默认代码上下文从这里解析。
_Avoid_: Current Directory、Main Project

**Attached Root**:
Project 中除 Primary Root 外的授权目录，不改变默认工作目录。
_Avoid_: Secondary Project、Dependency

### Conversation lifecycle

**Session**:
一次绑定到 Project、可跨进程恢复的连续对话，由按顺序发生的多个 Turn 组成。
_Avoid_: Conversation、Chat

**Turn**:
从一条用户输入开始，到 Agent 返回最终答案或失败为止的一次处理过程。
_Avoid_: Round、Request

**Step**:
Turn 内的一次模型推理；结果是最终答案，或者一次需要执行的 Tool Call。
_Avoid_: Turn、Action

**Message**:
提供给模型的上下文条目。Message 是已完成 Turn 的投影，不等同于完整执行记录。
_Avoid_: Event、Log
