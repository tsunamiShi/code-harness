# ADR-019: Model requests use transport default timeouts

## Status

Accepted

## Date

2026-09-21

## Context

The OpenAI-compatible Model Adapter imposed a 30-second timeout on every Provider Attempt. Complex model calls can legitimately spend longer in provider queues, reasoning, generation, and response transfer. A timeout surfaced as `Request timed out.` and could cause the SDK to retry a request that was still running at the provider.

When configured, `maxTokens` limits the output of each Model Invocation. It does not define how long the provider may take to produce that output.

## Decision

Do not set an application-level request timeout by default in the OpenAI-compatible Adapter. When `timeoutMs` is absent, omit `timeout` from the SDK configuration and use the SDK and host transport defaults. The installed OpenAI SDK currently defaults to ten minutes, while Node fetch can enforce independent response-header or body-inactivity timeouts.

Keep `timeoutMs` as an explicit Adapter option for callers that deliberately want a shorter or longer deadline. Only record `requestTimeoutMs` in the Model Descriptor when the application supplied that option. Continue treating an explicitly configured `maxTokens` as an independent per-response output limit.

## Alternatives Considered

### Increase the hardcoded timeout

A larger constant would reduce failures but still encode an arbitrary model latency policy in the protocol Adapter.

### Disable every transport timeout

The OpenAI SDK does not expose an infinite-timeout value: omitting `timeout` selects its default and `0` expires immediately. Bypassing all SDK and host transport deadlines would require owning a separate HTTP lifecycle and could leave permanently hung requests without cancellation.

### Treat `maxTokens` as a time limit

Token count limits response size, not wall-clock duration. Provider queueing and reasoning can exceed a time threshold before producing few or any output tokens.

## Consequences

- The previous 30-second application deadline no longer interrupts ordinary model calls.
- Default requests can still end at an SDK, Node fetch, operating-system, proxy, or provider timeout.
- With one configured retry, a terminal timeout can now take substantially longer than before.
- Cancellation and an explicit user-configurable timeout policy remain separate Runtime concerns.
