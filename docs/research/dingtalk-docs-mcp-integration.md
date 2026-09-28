# code-harness 接入钉钉文档 MCP：官方能力与接入边界

> 调研日期：2026-09-25
> 资料范围：钉钉开放平台、钉钉官方 MCP 市场接口、钉钉官方 GitHub 仓库、MCP 官方规范。未把第三方 Skill、博客或非官方 MCP Server 作为结论依据。

## 结论先行

1. **钉钉官方已经提供可由外部 MCP Client 连接的“钉钉文档 MCP Server”。** 官方市场记录为 `mcpId=9629`，标记 `official=true`、`local=false`、`onlyRunInDT=false`，服务提供方为“钉钉（中国）信息技术有限公司”。这不是只能在钉钉 AI 助理内部调用的隐藏能力。[钉钉官方市场详情 API](https://aihub.dingtalk.com/mcp/market/detail?mcpId=9629)（访问日期：2026-09-25）
2. **官方远程 endpoint 使用 Streamable HTTP。** 钉钉公开的 OAuth 配置是 `https://mcp-gw.dingtalk.com/oauth/server/doc`，市场返回的 JSON 中明确写有 `"type":"streamable-http"`。[钉钉官方市场详情 API](https://aihub.dingtalk.com/mcp/market/detail?mcpId=9629)（访问日期：2026-09-25）
3. **当前 code-harness 可以直接接“市场生成的个人 StreamableHttp URL”，但不能直接完成官方 OAuth endpoint 的交互式登录。** 当前实现支持 Streamable HTTP、URL 环境变量展开和静态 Header，没有给 MCP SDK 提供 OAuth auth provider。因此现在最短路径是：用户登录钉钉官方 MCP 市场开通服务，复制个人 `StreamableHttp URL`，通过环境变量放进 `.mcp.json`，再用 `--mcp-config` 启动 code-harness。
4. **不需要自己再写钉钉文档 MCP Server，也不需要为这个远程市场服务申请应用 Client ID/Client Secret。** Client ID/Client Secret 是普通开放平台 OpenAPI 或旧的本地 `dingtalk-mcp` 包的接入模式，不是钉钉文档远程 MCP 的必备配置。
5. **截至调研日期，官方市场详情返回 40 个文档 Tools。** 能力覆盖搜索、读取、创建、Markdown/Block 编辑、权限管理、上传下载、导入导出、历史版本、模板和样式；实际可操作的数据仍受当前钉钉用户和组织权限约束。[钉钉官方市场详情 API](https://aihub.dingtalk.com/mcp/market/detail?mcpId=9629)（访问日期：2026-09-25）

## 先区分三类“钉钉文档能力”

| 类型 | 谁调用谁 | 协议/凭证 | 是否能直接放进 code-harness 的 MCP 配置 |
| --- | --- | --- | --- |
| 钉钉开放平台文档/文件 OpenAPI | 自己的应用调用钉钉业务 HTTP API | REST/OpenAPI；应用 access token、用户授权和对应权限点 | 不能。需要自己编写 MCP Server，把 OpenAPI 封装成 Tools |
| 钉钉对话或 AI 助理内使用 MCP | 钉钉自己的 AI 产品消费已部署的 MCP 能力 | 钉钉产品内部完成连接和身份传递 | 不等于外部 Client 配置方式 |
| 官方钉钉文档 MCP Server | code-harness 等外部 MCP Client 连接钉钉托管的远程 Server | Streamable HTTP；OAuth 或市场签发的个人 API Key URL | 可以；当前 code-harness 应优先用个人 API Key URL |

钉钉开放平台官网目前把 MCP、Skill、OpenAPI 作为不同基础设施入口展示，并单列“钉钉文档 MCP”。[钉钉开放平台官网](https://open.dingtalk.com/)（访问日期：2026-09-25）

另一个容易混淆的项目是钉钉官方 GitHub 组织中的 [`open-dingtalk/dingtalk-mcp`](https://github.com/open-dingtalk/dingtalk-mcp)。它是用 `npx -y dingtalk-mcp@latest` 启动的本地 `stdio` Server，使用 `DINGTALK_Client_ID`、`DINGTALK_Client_Secret` 和 `ACTIVE_PROFILES`；README 列出的能力包括通讯录、部门、机器人、待办、日历、签到、工作通知、应用管理、服务窗、Teambition 和日志，**没有钉钉文档读写**。它不能替代本文讨论的 `mcpId=9629` 远程钉钉文档 MCP。[钉钉官方 dingtalk-mcp README](https://github.com/open-dingtalk/dingtalk-mcp/blob/main/README.md)（访问日期：2026-09-25）

## 官方 Server 的精确信息

| 项目 | 当前官方值 |
| --- | --- |
| 名称 | 钉钉文档 |
| MCP ID | `9629` |
| Server name | `doc` |
| 提供方 | 钉钉（中国）信息技术有限公司 |
| 官方标记 | `official=true` |
| 部署形态 | 远程服务，`local=false` |
| 是否仅限钉钉内运行 | 否，`onlyRunInDT=false` |
| Transport | Streamable HTTP |
| OAuth MCP endpoint | `https://mcp-gw.dingtalk.com/oauth/server/doc` |
| 市场详情页 | `https://aihub.dingtalk.com/#/detail?mcpId=9629&detailType=marketMcpDetail` |

来源：[钉钉官方市场详情 API](https://aihub.dingtalk.com/mcp/market/detail?mcpId=9629)（访问日期：2026-09-25）。

MCP 官方规范把 Streamable HTTP 定义为标准远程传输：Client 通过同一个 MCP endpoint 发送 HTTP POST，并可使用 GET/SSE 接收服务端消息。[MCP Transports specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)（访问日期：2026-09-25）

## 鉴权有两条路径

### 路径 A：市场签发的个人 StreamableHttp URL，适合当前 code-harness

用户登录官方市场详情页并开通服务后，页面会生成可复制的 `StreamableHttp URL` 和 `JSON Config`。官方页面同时提示：

- 配置包含 API Key，属于敏感信息；
- 调用会使用当前用户及组织身份；
- 仅限个人使用，不应发布到公开文档或代码仓库；
- Key 可设置有效期，并可重置；重置后旧 Key/旧配置失效。

这些信息来自钉钉官方 MCP 市场页面及其当前前端实现。[钉钉文档 MCP 市场页](https://aihub.dingtalk.com/#/detail?mcpId=9629&detailType=marketMcpDetail)（访问日期：2026-09-25）；[钉钉官方市场前端 bundle 1.74.0](https://cdn.dingtalkapps.com/dingding/appcenter-home-pc/1.74.0/index.js)（访问日期：2026-09-25）

个人 URL 只有登录并开通后才能获取。不要猜测它的路径格式，也不要把完整 URL 写入仓库。

### 路径 B：标准 OAuth endpoint，适合具备 MCP OAuth 的 Client

未携带 Token 访问 `https://mcp-gw.dingtalk.com/oauth/server/doc` 会返回 `401 Unauthorized`，并通过 `WWW-Authenticate` 指向 Protected Resource Metadata：[钉钉 OAuth Protected Resource Metadata](https://mcp-gw.dingtalk.com/.well-known/oauth-protected-resource/oauth/server/doc)。该 metadata 当前声明：

- Resource：`https://mcp-gw.dingtalk.com/oauth/server/doc`
- Authorization Server：`https://mcp-gw2.dingtalk.com`
- Scope：`user`
- Bearer Token 通过 HTTP Header 传递

Authorization Server Metadata 当前位于 [钉钉 OAuth Authorization Server Metadata](https://mcp-gw2.dingtalk.com/.well-known/oauth-authorization-server)，声明：

- Authorization endpoint：`https://mcp-gw2.dingtalk.com/oauth/authorize`
- Token endpoint：`https://mcp-gw2.dingtalk.com/oauth/token`
- Dynamic Client Registration endpoint：`https://mcp-gw2.dingtalk.com/oauth/register`
- Grant types：`authorization_code`、`refresh_token`
- PKCE：`S256`
- Scope：`user`

这与 MCP 官方授权流程一致：HTTP MCP Client 从 `401` 的 `WWW-Authenticate` 发现 Protected Resource Metadata，再发现 Authorization Server，并执行 OAuth 授权码流程。[MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)（访问日期：2026-09-25）

当前 `src/tools/mcp-tools.ts` 创建 `StreamableHTTPClientTransport` 时只传入 URL 和可选静态 headers，没有 OAuth auth provider、回调 Server、Token 持久化或刷新逻辑。因此只把 OAuth endpoint 填进当前 code-harness，会在连接阶段收到 401；若要走这条路径，需要另行实现 MCP OAuth Client 生命周期。

## 当前 code-harness 的实际接入步骤

### 1. 在钉钉官方市场获取个人 URL

打开[钉钉文档 MCP 市场页](https://aihub.dingtalk.com/#/detail?mcpId=9629&detailType=marketMcpDetail)，使用需要访问文档的钉钉账号登录：

1. 点击“获取 MCP Server 配置”或“查看 MCP Server 配置”；
2. 选择合适的 Key 有效期；
3. 复制完整的 `StreamableHttp URL`；
4. 把它作为 secret 保存，不发送到聊天、不写进 Git、不放进 README。

### 2. 创建不含 secret 的 MCP 配置

例如在仓库外创建 `/absolute/private/path/dingtalk-docs.mcp.json`：

```json
{
  "mcpServers": {
    "dingtalk-docs": {
      "type": "streamable-http",
      "url": "${DINGTALK_DOCS_MCP_URL}",
      "timeoutMs": 60000
    }
  }
}
```

`mcpServers`、`type: "streamable-http"`、URL 环境变量展开都已被当前 code-harness 的 MCP 配置解析器支持。

### 3. 在当前 shell 注入个人 URL 并启动

```bash
export DINGTALK_DOCS_MCP_URL='<从钉钉市场复制的完整 StreamableHttp URL>'

pnpm chat -- \
  --project <project-id> \
  --mcp-config /absolute/private/path/dingtalk-docs.mcp.json
```

也可以把配置路径设为 `AGENT_MCP_CONFIG`。恢复 Session 时仍需保留该配置和环境变量，因为 MCP 连接属于当前 CLI 进程，不写入 Session。

### 4. 连接后的 Runtime Tool 名称

code-harness 会执行 `tools/list`，然后将 Tool 注册成：

```text
mcp__dingtalk-docs__search_documents
mcp__dingtalk-docs__get_document_content
mcp__dingtalk-docs__create_document
mcp__dingtalk-docs__update_document
```

Tool 列表由 Server 在连接时动态返回；不要在 Prompt 中把当前 40 个名字当成永久不变的静态契约。

## 官方当前提供的 40 个 Tools

以下名称来自 2026-09-25 的官方市场详情响应。

### 搜索与读取（5）

- `search_documents`
- `get_recent_list`
- `get_document_info`
- `get_document_content`
- `list_nodes`

### 创建、上传、下载与导入（11）

- `create_document`
- `create_file`
- `create_folder`
- `create_import_session`
- `confirm_import`
- `query_import_task`
- `get_file_upload_info`
- `commit_uploaded_file`
- `get_doc_attachment_upload_info`
- `download_doc_attachment`
- `download_file`

### 内容与 Block 编辑（5）

- `update_document`
- `list_document_blocks`
- `insert_document_block`
- `update_document_block`
- `delete_document_block`

### 节点生命周期（4）

- `rename_document`
- `move_document`
- `copy_document`
- `delete_document`

### 导出、历史版本、模板与样式（10）

- `submit_export_job`
- `query_export_job`
- `list_doc_versions`
- `save_doc_version`
- `revert_doc_version`
- `list_doc_templates`
- `search_doc_templates`
- `apply_doc_template`
- `get_document_style`
- `update_document_style`

### 权限与所有权（5）

- `list_permission`
- `add_permission`
- `update_permission`
- `remove_permission`
- `transfer_owner`

完整 Tool 描述、输入 JSON Schema 和输出 JSON Schema 可从[钉钉官方市场详情 API](https://aihub.dingtalk.com/mcp/market/detail?mcpId=9629)读取。该响应把 `get_document_content` 标为敏感 Tool；但 `isSensitive=false` 或当前 code-harness 推导出的 Tool effect 都不能代替业务权限检查或用户确认。

## 能力与验证边界

- 连接成功只证明 MCP 握手和 `tools/list` 成功，不证明某个钉钉文档可读写。
- 文档搜索、读取、创建、编辑和授权都使用当前钉钉用户及组织身份，并继续受钉钉原有文档、知识库和组织权限约束。
- `get_document_content` 主要面向钉钉在线文档内容；其他文件类型是否支持内容读取或更新，应以 Tool 当次 Schema、描述和调用结果为准。
- 写操作如覆盖内容、删除 Block、移动节点、修改权限和转交所有者，需要在 Agent 层保留明确的确认和审计策略。
- 本次未持有用户个人 MCP URL，因而没有做真实账号的连接、`tools/list` 或文档读写验证；本文的 Server、Transport、OAuth 和 Tool 结论来自当前官方公开接口，code-harness 兼容性结论来自当前工作区静态代码审计。

## 最终判断

对当前 code-harness，最现实的接入方案是：

```text
code-harness
  └── Streamable HTTP
      └── 钉钉市场签发的个人 MCP URL（secret）
          └── 钉钉官方文档 MCP Server
              └── 以当前钉钉用户/组织权限操作文档
```

因此不需要再实现一套钉钉文档 MCP Server；当前缺的是用户在官方市场完成开通并提供个人连接 URL。若希望只保存公开 OAuth endpoint、由 code-harness 自动拉起浏览器登录和刷新 Token，则需要为 code-harness 增加完整的 MCP OAuth Client 支持。
