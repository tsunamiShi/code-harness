# ADR-036: Known models provide Context window defaults

## Status

Accepted

## Date

2026-09-26

## Context

ADR-034 required an explicit `AGENT_CONTEXT_WINDOW_TOKENS` value because OpenAI-compatible usage responses report consumed Tokens but not the model's maximum Context window. That conservative behavior avoids presenting incorrect percentages for aliases and private models, but it also makes operators repeat stable public metadata for models selected directly through `DASHSCOPE_MODEL`.

For `glm-5.3` and `ZHIPU/GLM-5.3`, Alibaba Cloud Model Studio documents a Context window of `1,048,576` Tokens. Leaving this known value unconfigured caused every completed Turn to report `window size not configured` even though the CLI already knew the exact model identifier.

## Decision

The CLI owns a small exact-match registry of verified model Context windows. `agentContextLimitsFromEnvironment` resolves its window in this order:

1. a positive `AGENT_CONTEXT_WINDOW_TOKENS` value;
2. an exact, case-insensitive `DASHSCOPE_MODEL` match in the built-in registry;
3. no Context window.

The initial registry maps `glm-5.3` and `ZHIPU/GLM-5.3` to `1,048,576` Tokens. A resolved window also derives the existing 90% automatic compaction threshold unless `AGENT_AUTO_COMPACT_TOKEN_LIMIT` supplies a lower explicit threshold.

Aliases and unknown models are not matched heuristically. Their operators can continue to supply an explicit override.

Model limits must be verified against current provider documentation before registry entries change. The initial value comes from the [Alibaba Cloud Model Studio GLM-5.3 documentation](https://help.aliyun.com/zh/model-studio/glm-5-3).

## Alternatives Considered

### Require explicit configuration for every model

This avoids stale metadata but produces a poor default for first-party model identifiers already known to the CLI. It was the ADR-034 behavior and is superseded for exact known models.

### Infer by model-name prefix or substring

This would cover more aliases but can silently assign the wrong window to dated snapshots, fine-tunes, routers, or unrelated names. Exact identifiers keep failure conservative.

### Fetch model metadata at startup

The OpenAI-compatible endpoint used here has no portable Context-window capability response. A provider-specific network lookup would add startup latency and availability coupling.

## Consequences

- GLM-5.3 users receive Context percentages and automatic compaction without duplicate configuration.
- Explicit configuration remains authoritative for gateways whose deployed limit differs from public model metadata.
- Unknown models still report that the window size is not configured.
- Built-in entries can become stale and require maintenance when provider limits change.
