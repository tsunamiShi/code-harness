# ADR-037: WebSearch requires provider-verifiable Responses search calls

## Status

Accepted

## Date

2026-09-28

## Context

`WebFetch` can read one exact URL, but the model has no way to discover an address or check a fact that is not in its training data. The Code Agent therefore could only ask the user for links, which is exactly what the "find unknown addresses with a search capability first" guidance in the WebFetch Tool description anticipates.

DashScope no longer offers a standalone `websearch-pro` service endpoint; the 2026 model catalog exposes search as a built-in model Tool. Three integration shapes were evaluated:

1. `enable_search: true` on a Chat Completions request injects search results into the model context invisibly. The injection cannot be surfaced to the Agent, and observed results included poisoned/spam pages the model itself rejected, with no way to inspect or filter them.
2. A Chat Completions request with `enable_search: true` and a `json_object` response format asks the backend model to report the hits it used. The returned JSON is still model-generated: a successful Provider request proves neither that search ran nor that its URLs came from the search index.
3. The Responses API accepts a built-in `{ "type": "web_search" }` Tool. With exactly one Tool, `tool_choice: "required"` forces a Tool call. Completed responses contain `web_search_call` output items whose `action.sources` are the Provider-reported source URLs and whose presence is explicit evidence that search executed.

## Decision

Add a `WebSearch` Tool backed by shape 3. It is an `observe` Tool with `parallelSafe: true`, so it batches with `Read / Glob / Grep / LSP / WebFetch` in one Step. Its interface is one natural-language `query` plus optional `count` and `timeoutMs`. Each request sends only the built-in `web_search` Tool, sets `tool_choice: "required"`, and disables response storage because WebSearch calls have no continuation lifecycle.

Only completed `web_search_call` items count as search evidence. The Tool extracts `action.queries` and `action.sources`, accepts credential-free http(s) source URLs, removes fragments, deduplicates them, and applies the caller's count limit. Provider-generated message text is returned as a synthesized summary only after a completed search call exists. If no completed call exists, all model text is discarded and the Tool returns a correctable message instead of presenting unverified links as results.

The Tool is **opt-in**: it is exposed only when `AGENT_WEB_SEARCH=true` is set and `DASHSCOPE_API_KEY` is present. A key alone never enables paid web searches. `--no-web-search` opts out for one process, and the CLI flag wins over the environment. Rationale differs from WebFetch's default-on:

- WebFetch reads a user-supplied address; the SSRF surface is fully refused inside the Tool. WebSearch sends the query and the Bearer key to a provider API, and results come from a search index the operator does not control. An operator who already pays for an LLM API should decide whether the Agent also performs paid web searches.
- `DASHSCOPE_API_KEY` is already required for the chat model, so for most existing `.env` files enabling WebSearch is a single boolean, not a new credential.

Configuration is process state: `AGENT_WEB_SEARCH`, `AGENT_WEB_SEARCH_ENDPOINT` (defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1/responses`), and `AGENT_WEB_SEARCH_MODEL` (defaults to `qwen3.7-flash`, which supports Responses `web_search` in the configured region). The CLI flag wins over the environment; a resumed Session does not inherit the setting.

Endpoint safety: the endpoint must be https outside test wiring, must not embed credentials, and loopback/private-IP hosts are refused. No DNS pinning is needed because the endpoint is fixed configuration, not model-controlled input. Search source URLs are metadata for WebFetch to read, not content the Agent should trust blindly.

Backend errors (invalid key, quota, non-JSON bodies), missing search calls, and empty source sets return as correctable results with a `message` instead of failing the Turn. Timeouts throw, matching WebFetch. The default timeout is 60 seconds because the verified Responses search measured about 42 seconds; the cap stays 120 seconds.

The Project System Message gains WebSearch guidance only while the Tool is exposed, directing the model to search for unknown addresses, then read exact URLs with WebFetch before relying on them.

## Alternatives Considered

### Default-on like WebFetch

Rejected: searches cost money per call, results come from an index the operator does not control, and the Tool ships a provider-side dependency that not every deployment has. The opt-in keeps a surprise network dependency out of default installs while remaining one env var away.

### A dedicated search API endpoint

The standalone `websearch-pro` endpoint no longer exists on DashScope; direct requests return `Model not exist`. Rebuilding a dedicated search adapter would target a deprecated surface.

### Chat Completions `enable_search` injection

Rejected: with OpenAI-compatible Chat Completions, the response does not explicitly prove whether search executed. Asking the model to report JSON links makes the output inspectable but not verifiable, because those links can still be generated from model knowledge or hallucinated.

### MCP search server

A legitimate option, but it adds a server process and config for a capability one already-configured provider offers. WebSearch stays a built-in Tool for the same reason WebFetch is.
