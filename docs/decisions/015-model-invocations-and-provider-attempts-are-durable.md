# ADR-015: Model Invocations and Provider Attempts are durable

## Status

Accepted

## Date

2026-09-18

## Context

Steps are persisted only after a model response, so a timed-out request leaves no Step row. The OpenAI-compatible SDK may also retry one logical model call internally, making a sixty-second failure indistinguishable from one slow request when the configured timeout is thirty seconds.

## Decision

Persist each logical Model Invocation before calling the model and persist every actual Provider Attempt beneath it. The Invocation records model identity, protocol, request limits, model-input size, output metrics, token usage, finish reason, and terminal error. The Attempt records its sequence number, HTTP outcome, provider request ID, error, and timestamps. A Step remains the model decision produced by a successful Invocation; failed Invocations do not create synthetic Steps.

The OpenAI-compatible Adapter observes its configured `fetch` function so SDK-managed retries remain unchanged while each real HTTP request becomes visible. MySQL is the durable source for telemetry; model-visible Messages remain a projection of completed Turns and do not include observability records.

## Consequences

- A failed final model request is queryable even when it produced no Step.
- Provider retries can be separated from Agent Loop iterations.
- Existing Sessions cannot be backfilled because their request and retry facts were never recorded.
- Durable reasoning text remains deferred; only its character and token counts are recorded.
