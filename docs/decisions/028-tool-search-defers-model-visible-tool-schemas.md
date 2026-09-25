# ADR-028: Tool Search uses a stable ExecuteTool facade

## Status

Accepted

## Date

2026-09-25

## Context

The Runtime can discover many MCP Tools during CLI startup. Passing every Tool name, description, and parameter JSON Schema to every Model Invocation increases input size even when a Turn needs only one external capability. A large flat Tool list also makes tool selection harder and allows an accidental or hallucinated call to reach any discovered Tool.

MCP discovery and model-visible Tool selection are different lifecycles. Discovery connects to an explicitly configured Server and creates executable Runtime adapters. Selection decides which already-discovered definitions the Model needs in its current context. Re-running MCP discovery from a search call would mix those lifecycles and make search depend on network or process state.

The built-in code Tool set is small and used throughout normal repository work. Deferring it would add search Steps to common operations without materially reducing the prompt. MCP catalogs are the unbounded part of the Tool surface and therefore provide the useful seam for deferred exposure.

## Decision

Add one deep `ToolRegistry` module at the Runtime Tool seam. Its interface accepts always-visible Tools and optional Searchable Tools, returns a stable model-visible description set, resolves only visible facade Tools directly, and restores prior search discoveries from durable Messages.

When Searchable Tools exist, the registry adds two always-visible facade Tools: `ToolSearch` and `ExecuteTool`. `ToolSearch` accepts only `query` and returns at most five matches. Search runs locally over an index built once from the static startup catalog and uses explicit, deterministic weights adapted from CCB's keyword search:

- an exact Tool-name part scores 12, a partial name part scores 6, and a full-name fallback scores 3;
- an exact parameter-name part scores 4 and a partial parameter-name part scores 2;
- a Tool-description term scores 2 and a parameter-description term scores 1;
- common English request words are ignored, camelCase boundaries are split, and contiguous Chinese text also emits character bigrams;
- `+term` requires every candidate to match that term, while `select:<exact_tool_name>` bypasses ranking for a known name;
- registration order breaks equal scores.

The index deliberately excludes parameter types, enums, defaults, validation keywords, and all other raw JSON Schema content. A successful search returns a stable JSON `matches` list plus a `tools` list containing each candidate's exact name, description, and full `input_schema`, and makes those names eligible for `ExecuteTool` in later Model Steps. The contract is ordinary Tool Result content; it does not inject matched Tool definitions into the Model Invocation's `tools` field. Session restoration replays only the discovery names from persisted successful search results; it does not re-execute searches or external Tools. Results from the earlier `ToolSearchBM25`, `ToolSearchRegex`, and `activated` formats remain readable for backward-compatible restoration.

`ExecuteTool` accepts an exact `tool_name` and a `params` object built from the selected candidate's `input_schema`. The Runtime resolves the real Searchable Tool and dispatches only if that name was discovered in an earlier Model Step and `params` passes the MCP SDK's dialect-aware JSON Schema validator. Invalid target contracts and invalid parameter values do not reach the adapter. They become failed Tool Results, so the Agent Loop can give the error back to the Model and let it correct the call. Discoveries remain pending until the entire Tool Call Batch finishes, so a same-batch search plus guessed `ExecuteTool` cannot bypass the seam. Calling a Searchable Tool directly, executing an undiscovered name, or executing an unknown name follows the same failed-Tool-Result path. Tool-name uniqueness is validated across always-visible Tools, both reserved facade names, and all Searchable Tools.

The CLI keeps built-in code Tools always visible and supplies discovered MCP Tools as Searchable Tools. If the MCP catalog is empty, both facade Tools are absent. Search does not reconnect Servers, perform a new MCP `tools/list`, call another Model, or use a vector index. The in-memory index is immutable for the Session because the MCP Tool Set remains a startup snapshot.

## Alternatives Considered

### Expose every discovered Tool on every request

This preserves the simplest registry, but prompt cost and selection ambiguity grow with every configured Server even when most Tools are irrelevant to a Turn.

### Inject matched Tool definitions after search

This preserves normal function calling, but changes the `tools` request field over the Session. That weakens prefix stability and does not satisfy providers or gateways that cannot incrementally extend the server-held Tool set. The chosen facade keeps request Tool definitions stable while carrying the exact parameter contract in the search Tool Result.

### Let a guessed deferred Tool execute

This would make Tool Search advisory rather than an actual capability gate. It would also hide model-selection failures because a Tool absent from the request could still run.

### Search with embeddings or a dedicated Model

Semantic retrieval can improve matching for vague descriptions, but it adds latency, cost, configuration, nondeterminism, and another failure mode. Deterministic lexical ranking is sufficient for names and well-authored Tool metadata and can later be replaced behind the same registry interface.

### Discover MCP Tools only when searched

Searching an undiscovered Server would require a separate metadata catalog and delayed connection lifecycle. It would also move connection failures into the middle of an Agent Turn. Startup discovery remains the explicit authority and health check; Tool Search controls only which catalog names ExecuteTool may dispatch.

## Consequences

- Normal code work retains direct access to the small built-in Tool set.
- Large MCP catalogs no longer add every Tool schema to every Model Invocation.
- A search costs one additional Agent Step before the first use of a deferred Tool.
- Search quality depends on Tool names, descriptions, parameter names, and parameter descriptions; vague metadata may require `+required` terms or `select:<exact_tool_name>`.
- The Model sees a deferred Tool's exact parameter Schema only after search and only as Tool Result content. Invalid `params` are rejected before adapter dispatch, recorded as failed Tool Results, and fed back for correction without terminating the Agent Loop.
- Discovered names remain executable through `ExecuteTool` for the rest of the Session, including after process restart when the same catalog is supplied again.
- The MCP Tool Set remains a static startup snapshot. Server list-change notifications still require a CLI restart.
