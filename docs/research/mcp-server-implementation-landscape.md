# MCP Server 的实现与部署方式：以同花顺为例

> 调研日期：2026-09-24
> 资料范围：MCP 官方规范、官方 SDK 文档/仓库、GitHub 与 Microsoft 第一方产品文档。未使用第三方博客。

## 结论先行

1. **同花顺可以、而且在处理公司内部行情、研报、交易、客户或权限数据时通常更适合自建并自管 MCP Server，但协议并不要求必须自建。** MCP Server 只是向 MCP Client 暴露 `tools`、`resources`、`prompts` 的程序，可以运行在员工电脑本地，也可以作为公司内网或公网远程服务运行。官方架构文档明确区分本地 `stdio` Server 和可服务多个 Client 的远程 Streamable HTTP Server。[MCP Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（访问日期：2026-09-24）
2. **大家的 MCP Server 不是同一套业务实现。** 相同的是线上的协议契约，例如 JSON-RPC 消息、版本/能力发现、`tools/list`、`tools/call`、Tool 的 JSON Schema 以及标准传输语义；不同的是 Tool 列表、业务代码、后端 API/数据库、语言和 SDK、鉴权、租户隔离、审计、限流、部署拓扑与可用性设计。[MCP Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（访问日期：2026-09-24）；[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问日期：2026-09-24）
3. **主流部署选择是：本地集成用 `stdio`，共享/生产远程服务用 Streamable HTTP。** MCP 当前标准传输就是这两种；旧 HTTP+SSE 已被 Streamable HTTP 取代，但一些 SDK/客户端仍为兼容保留 SSE。[MCP Transports specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)（访问日期：2026-09-24）；[MCP Python SDK - Running your server](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/index.md)（访问日期：2026-09-24）
4. **MCP 统一的是 Agent 到能力提供方之间的接口，不会替企业解决业务授权与治理。** HTTP MCP 的官方授权模型把受保护的 MCP Server 视为 OAuth Resource Server；是否对某用户开放某个 Tool、是否允许实盘交易、怎样审计和风控，仍由公司实现并强制执行。[MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)（访问日期：2026-09-24）

## 以同花顺为例：MCP Server 应该放在哪里

没有唯一答案，常见的是三种形态。

### 1. 公司托管的远程 MCP Server

```text
员工/客户 Agent
      │  Streamable HTTP + OAuth
      ▼
同花顺 MCP Gateway / Server
      ├── 行情服务
      ├── 研报与资讯检索
      ├── 用户与权限中心
      ├── 交易/风控系统
      └── 审计、限流、观测
```

这是内部共享和对外产品化最自然的形态。同花顺负责部署、升级、数据边界、Tool 版本、OAuth/企业 IdP、审计和 SLA。远程 MCP Server 是独立服务，可供多个 MCP Client 使用；Streamable HTTP 为远程场景设计。[MCP Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（访问日期：2026-09-24）；[MCP Transports specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)（访问日期：2026-09-24）

适合：公司私有数据、集中权限、统一风控、多租户、需要持续运营的场景。

### 2. 公司内部自托管实例

部署在内网、私有云、Kubernetes、Serverless 或 API Gateway 后面，只允许公司 Agent 和授权员工访问。基础设施不由 MCP 限定。Microsoft 的第一方文档展示了两条远程自托管路线：使用云平台的 MCP 扩展构建，或把基于官方 MCP SDK 的现有 Server 直接部署到函数服务。[Azure Functions self-hosted remote MCP server](https://learn.microsoft.com/en-us/azure/azure-functions/self-hosted-mcp-servers)（访问日期：2026-09-24）

适合：不能把数据或调用权交给外部厂商、需要接入企业 IdP 和内控体系的场景。

### 3. 用户本地 `stdio` MCP Server

```text
桌面 Agent ──启动子进程──> 本地 MCP Server ──HTTPS──> 同花顺已有 API
```

这时 Server 程序运行在用户机器上，凭证通常通过环境变量传入；协议规定 `stdio` 由 Client 启动子进程，通过 stdin/stdout 交换换行分隔的 JSON-RPC。官方授权规范也明确：OAuth 授权规范面向 HTTP Transport，`stdio` 通常从环境中取得凭证。[MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)（访问日期：2026-09-24）；[MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)（访问日期：2026-09-24）

适合：个人开发工具、需要访问本机资源、快速试点，或把已有 HTTP API 包成轻量本地桥接器。

GitHub 的第一方文档也展示了同一个 GitHub MCP Server 既能使用远程 URL，也能以 Docker 子进程方式在本地运行，说明“Server 属于谁”和“Server 跑在哪里”是两个独立选择。[GitHub Copilot MCP configuration](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp)（访问日期：2026-09-24）

## 所有 MCP Server 都一样吗

### 一样的部分：协议互操作层

| 统一内容 | 协议要求 |
| --- | --- |
| 消息基础 | UTF-8 JSON-RPC 2.0 请求、响应和通知 |
| 版本与能力 | Client/Server 声明协议版本和 capabilities；当前版本提供 `server/discover` |
| Tool 发现 | `tools/list` 返回名称、描述、`inputSchema`，可包含 `outputSchema`、annotations 等 |
| Tool 调用 | `tools/call` 携带 Tool 名称和 arguments，Server 返回内容、结构化结果或错误 |
| Server 原语 | Tools、Resources、Prompts |
| 标准传输 | `stdio`、Streamable HTTP |

这些标准字段与行为使一个合规 MCP Client 能连接不同厂商、不同语言编写的 MCP Server。协议还允许自定义 Transport，但必须保持 JSON-RPC 消息、消息模式和每请求元数据模型。[MCP Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（访问日期：2026-09-24）；[MCP Transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)（访问日期：2026-09-24）；[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问日期：2026-09-24）

### 不一样的部分：产品与企业实现层

| 可变内容 | 同花顺可能的实现 |
| --- | --- |
| Tool 设计 | `search_market_news`、`get_quote`、`screen_stocks`、`submit_order` |
| 数据和业务系统 | 行情平台、搜索引擎、研报库、账户系统、交易与风控系统 |
| Handler | 参数校验、API 编排、SQL/RPC 调用、结果裁剪与脱敏 |
| 权限 | 员工/客户身份、产品权限、数据市场授权、账户级权限、Tool/参数级授权 |
| 风险控制 | 只读与写操作区分、交易二次确认、额度限制、幂等、人工审批 |
| 部署 | 本机子进程、内网服务、私有云、Kubernetes、Serverless、公网 SaaS |
| 运营 | 版本兼容、灰度、限流、缓存、审计、OpenTelemetry、告警与 SLA |

规范明确说 MCP 只聚焦上下文交换协议，并不规定 AI 应用如何使用 LLM 或管理上下文。因此两个 Server 即使都叫“证券 MCP”，其业务质量、安全性和 Tool 设计也可能完全不同。[MCP Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（访问日期：2026-09-24）

## 一个典型 MCP Server 的代码结构

无论 TypeScript、Python、Go 还是 Java，常见逻辑都是：

```text
创建 MCP Server
  ├── 注册 Tool / Resource / Prompt
  ├── 为每个 Tool 绑定 Handler
  │     ├── 校验输入
  │     ├── 校验调用者权限
  │     ├── 调用公司 API / DB / RPC
  │     ├── 脱敏和结果整形
  │     └── 返回 MCP CallToolResult
  ├── 选择 Transport
  │     ├── stdio
  │     └── Streamable HTTP
  └── 加上企业能力
        ├── OAuth / IdP / scope
        ├── 审计、风控、限流
        └── 日志、追踪、指标
```

官方 TypeScript SDK 的 Server Guide 将基本步骤概括为：创建 `McpServer` 并注册 primitives、创建 Transport、调用 `server.connect(transport)`；远程推荐 Streamable HTTP，本地使用 stdio。[TypeScript SDK Server Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)（访问日期：2026-09-24）

Tool 的业务处理函数完全由实现者编写。例如协议只定义 `tools/call` 的 `name`、`arguments` 与返回数据结构，不知道 `submit_order` 最终是调用 REST、gRPC、消息队列还是数据库。[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问日期：2026-09-24）

## 官方 SDK

截至调研日期，官方 SDK 页面列出了以下实现：

| 语言 | 官方等级 |
| --- | --- |
| TypeScript、Python、C#、Go、Rust | Tier 1 |
| Java、Ruby | Tier 2 |
| Swift、PHP、Kotlin | Tier 3 |

Tier 反映功能完整性、协议支持和维护承诺。官方说明各 SDK 对外提供相同的核心能力，但遵循各语言的惯用写法；都支持 Server、Client、本地/远程 Transport 和类型安全的协议实现。[MCP official SDK list](https://modelcontextprotocol.io/docs/2026-07-28/sdk)（访问日期：2026-09-24）

公司不必手写 JSON-RPC 或消息 framing，通常使用官方 SDK；也可以自己实现协议，但需要自行承担版本兼容、Transport、安全和互操作测试。

## 鉴权层：协议统一到哪里，企业负责什么

对远程 HTTP MCP：

- MCP 规定 OAuth 的角色和互操作流程；受保护 MCP Server 是 OAuth Resource Server，Client 是 OAuth Client，Authorization Server 负责登录和签发 Token。
- Server 需要验证 Bearer Token，包括有效期、scope 和 audience；Token 必须是签发给该 MCP Server 的，不能把其他下游系统 Token 透传给 MCP Server。
- Authorization Server 可以与 MCP Server 一起托管，也可以使用公司现有 IdP；其内部实现不属于 MCP 的范围。
- 每个 HTTP 请求都应携带 Authorization Header；401/403、Protected Resource Metadata 和 scope challenge 有标准行为。

以上属于协议层的授权互操作要求。[MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)（访问日期：2026-09-24）

同花顺仍需自行决定并实现：

- 哪些身份允许连接；
- 哪个用户能看哪些行情、研报和账户；
- 哪个 Tool 需要哪些 scope；
- Tool 参数是否越权，例如用户是否能查询别人的账户；
- 下单等高风险调用是否需要二次确认、额度、风控或人工审批；
- 多租户隔离、日志留存、合规审计和数据脱敏。

Tool annotations 不能替代权限控制。官方规范要求 Client 将来自不受信 Server 的 annotations 视为不可信信息；Server 必须在自己的业务边界重新校验权限。[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问日期：2026-09-24）

## 对同花顺的推荐落地

### 内部员工 Agent

推荐由公司部署一个或多个内网 Streamable HTTP MCP Server，通过企业 IdP/OAuth 接入。按业务域拆分，例如“行情与资讯”“研报知识库”“客户服务”“交易操作”，而不是做一个拥有全部权限的万能 Server。所有写操作在后端执行参数级鉴权、风控和审计。

### 面向客户的 Agent 接入

推荐公司托管公网 Remote MCP Endpoint，使用 OAuth 将最终用户身份绑定到同花顺账户；Tool 列表可以按调用者权限变化。当前规范允许 `tools/list` 根据每次请求携带的授权信息返回不同 Tool 集合。[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问日期：2026-09-24）

### 本地试点

可以先做一个 `stdio` Server，通过环境变量读取测试凭证，复用已有同花顺 OpenAPI。这种方式部署简单，但凭证分发、版本升级、终端安全和集中审计较弱，不应直接等同于生产架构。[MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)（访问日期：2026-09-24）

## 一句话判断

**MCP Server 就像“为 Agent 设计的标准 API 网关/适配器”：协议和消息骨架一致，里面暴露什么业务、连接什么系统、部署在哪里、谁能调用以及调用后如何风控，完全由每家公司自行实现。**
