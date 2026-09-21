# ADR-020: Max Tokens is an optional Provider override

## Status

Accepted

## Date

2026-09-21

## Context

The Runtime set every Model Invocation to `maxTokens=4096`, and the OpenAI-compatible Adapter always sent `max_tokens=4096`. This application default could truncate models whose Provider default supports longer reasoning or output. It also made the absence of user configuration indistinguishable from an intentional 4096-token policy.

A model can still stop at its own output limit when the request omits `max_tokens`. The resulting `finish_reason=length` remains an incomplete response rather than a final Agent answer.

## Decision

Keep `maxTokens` and `AGENT_MAX_TOKENS` as optional configuration. When absent, preserve `undefined` through the CLI, Runtime, Model interface, and session telemetry, and omit `max_tokens` from the OpenAI-compatible request. The Provider and selected Model then determine the effective output limit.

When configured, validate a positive safe integer, send that value on every Model Invocation in the Turn, and persist it with each Invocation. Store `NULL` when no application limit was configured.

Treat `finish_reason=length` as failure in both cases. The error names the configured limit when known and otherwise identifies the Provider output limit.

## Alternatives Considered

### Keep 4096 as the application default

This gives predictable response size but silently constrains models with larger useful outputs and reasoning budgets.

### Configure the model's advertised maximum by default

Maximum output limits vary by Provider, model, and protocol. Encoding that catalog in the Runtime would duplicate Provider policy and become stale.

### Remove Max Tokens configuration

Deployments still need an explicit per-response cost and output-size control. Keeping the override preserves that policy without imposing it on every user.

## Consequences

- Default model requests no longer contain `max_tokens`.
- Explicit `AGENT_MAX_TOKENS` values retain their existing per-Invocation behavior.
- Invocation telemetry distinguishes an application limit from a Provider default through a nullable `max_tokens` field.
- A Provider can generate more than 4096 output tokens by default, increasing latency, cost, and model-visible history size.
