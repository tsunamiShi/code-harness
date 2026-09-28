# ADR-034: Turn completion reports Context window usage

## Status

Superseded in part by ADR-036

## Date

2026-09-26

## Context

The CLI reports Model Invocation size and Context Compaction events, but an operator supervising a conversation cannot see how full the current Model Context is after a Turn ends. The available Provider usage belongs to a completed invocation, while the next invocation will also continue from the final assistant message and may use Provider-side continuation state.

The Runtime already owns a provider-neutral fallback Token estimator and uses it to decide when automatic Context Compaction should run. A separate CLI-only calculation would risk showing a different budget from the one that triggers compaction.

## Decision

ContextManager exposes a synchronous `estimateUsage` operation over the current projected Messages and visible Tool schemas. It uses the same estimator as automatic compaction and takes the maximum of the local estimate and the latest available Provider Input Tokens. The result includes configured Context window and automatic compaction limits when available.

Every terminal `turn.completed` and `turn.failed` Agent Event carries this Context Usage snapshot. Console Trace always renders it after the terminal Turn line, independent of `compact` or `verbose` mode.

When `AGENT_CONTEXT_WINDOW_TOKENS` is configured, render:

- a ten-cell progress bar;
- estimated current Tokens and configured window Tokens;
- percentage used and Tokens remaining;
- the automatic compaction percentage and Tokens remaining before that threshold, when enabled.

When only `AGENT_AUTO_COMPACT_TOKEN_LIMIT` is configured, render progress against that threshold without calling it window utilization. When neither value is configured, render the estimated Token count and state that the window size is unknown.

All displayed counts use `~` because they are estimates. The snapshot is transient presentation data: it is not another Session record and does not change Context projection, compaction, or Provider requests.

## Alternatives Considered

### Display only the last Provider usage

Provider usage is valuable evidence, but it describes the invocation that just completed and may omit the final assistant message from the next logical context. Some Model adapters may not return usage at all.

### Infer a Context window from the model name

Model aliases and Provider capabilities change independently of this Runtime. Hard-coded model-name tables become stale and can produce a precise-looking but incorrect percentage. The denominator therefore remains explicit configuration.

### Show Context only in verbose mode

Context pressure is a conversation-level operating signal, not low-level transport detail. It remains useful in the compact execution outline and costs one line per terminal Turn state.

## Consequences

- Operators can see Context pressure after every completed or failed Turn.
- The displayed estimate and automatic compaction decision use one calculation path.
- A configured Context window produces a meaningful percentage; without it the CLI does not invent one.
- Provider Input Tokens reduce estimator undercounting but do not make the value exact.
- The estimate describes the state after the Turn and does not include the next user message.
