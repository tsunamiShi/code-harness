# ADR-027: MCP Tools adapt into the Runtime registry

## Status

Accepted

## Date

2026-09-24

## Context

The Agent Runtime already owns one provider-neutral `Tool` interface and persists every Tool Call and Tool Result. The Responses Adapter serializes that registry for the model, but using the Responses protocol does not discover or execute tools hosted by MCP servers.

MCP introduces a second lifecycle: a client connects to each server, negotiates a protocol version, discovers JSON Schema tool definitions, dispatches calls, and closes local child processes or remote sessions. Local stdio server definitions can execute arbitrary programs, while remote servers may require static authorization headers. Loading repository configuration without an explicit user choice would therefore expand process authority merely by opening a Project.

MCP tool names can also collide across servers or exceed the model provider's function-name constraints. MCP Tool Results are typed content blocks rather than the Runtime's string Tool Result.

## Decision

Add one deep `McpToolSet` module at the existing Runtime Tool seam. Its interface accepts an explicit config path and the Project's Primary Root, then returns discovered Runtime Tools, non-secret server summaries, and one idempotent `close()` lifecycle method. The CLI remains responsible only for composition.

Use the stable `@modelcontextprotocol/client` v2 SDK. Support:

- local stdio servers;
- remote Streamable HTTP servers;
- legacy SSE servers as an explicit compatibility transport;
- both portable top-level `mcpServers` and VS Code-style top-level `servers` maps;
- `${VAR}`, `${VAR:-default}`, and `${workspaceFolder}` expansion in command, arguments, working directory, environment, URL, and headers;
- configurable per-server `timeoutMs`, with a 60-second default;
- automatic negotiation between the 2026-07-28 and legacy protocol eras.

MCP is opt-in for each CLI process through `--mcp-config <path>` or `AGENT_MCP_CONFIG`. Do not auto-load `.mcp.json` from a Project. A configured server that cannot connect or list tools fails CLI startup, and partial startup closes all successful connections before returning the error.

Map each discovered tool to `mcp__<server>__<tool>`. Preserve readable names when they satisfy the provider limit; sanitize and add a stable hash only when needed. Reject any remaining collision before constructing the Agent Session. Send the server's `inputSchema` directly as the Runtime parameter schema and pass arguments back to `callTool` unchanged.

Map MCP `readOnlyHint: true` to Runtime effect `observe`; all other MCP tools use `execute`. MCP tools are not declared parallel-safe because annotations are hints and remote concurrency guarantees are unknown.

Return text-only successful results as plain text. Serialize mixed content blocks or `structuredContent` as JSON so image, audio, embedded resource, and structured result data are not discarded. Convert `isError: true` into a failed Runtime Tool Call while retaining the server's error content. Protocol and transport failures likewise become failed Tool Calls through the existing Agent Loop error path.

At shutdown, terminate Streamable HTTP sessions when supported, close every MCP client, and close stdio child processes. Tool discovery is a startup snapshot; list-change notifications do not mutate a running Agent Session's registry.

## Alternatives Considered

### Register MCP tools directly in the Responses Adapter

This would couple tool discovery and execution to one model protocol, bypass Runtime persistence and recovery, and make MCP unavailable to future Model Adapters.

### Auto-load Project `.mcp.json`

This is convenient but lets an untrusted checkout start arbitrary local commands when a Session opens. Explicit CLI or environment configuration keeps that authority visible.

### Expose raw MCP tool names

Raw names are shorter, but tools from different servers can collide and some names do not satisfy the model provider's function-name rules.

### Flatten every result to text

This is readable for simple tools but discards structured content and non-text content blocks. The chosen mapping keeps simple text simple and preserves richer results as JSON.

## Consequences

- The model can call configured MCP tools through the same Agent Loop, trace, persistence, recovery, and error handling as built-in Tools.
- Configuration files can be shared without embedding secrets by referencing environment variables.
- A resumed Session must be started with the desired MCP config again; MCP configuration is process state, not durable Session state.
- Changing a server's tool list requires restarting the CLI so the Agent Session receives a new stable registry.
- Resources, prompts, interactive elicitation, sampling callbacks, and browser-based OAuth are not exposed in this Tool integration. Static HTTP headers and environment-provided bearer tokens are supported.
- MCP server code runs with the CLI process's operating-system authority. This module does not add a sandbox or approval UI.
