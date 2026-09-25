# ADR-029: Responses replays durable history after continuation loss

## Status

Accepted

## Date

2026-09-25

## Context

ADR-022 persists the latest Provider Response ID so a Session can continue with
`previous_response_id` after a process restart. Alibaba Model Studio retains each response ID for
seven days. An expired, deleted, or otherwise unavailable response therefore made the next Model
Invocation fail even though the Runtime still had the complete durable Message projection.

Retrying every Provider failure with full history would be unsafe operationally. A timeout or
server error does not prove that continuation state is unavailable, and unconditional replay can
duplicate inference cost while hiding an unrelated outage or request defect.

## Decision

The Responses adapter classifies a 400 or 404 as `ModelContinuationUnavailableError` only when the
Provider error identifies `previous_response_id`, a previous response, or the exact referenced
response ID as invalid, expired, deleted, unavailable, unknown, or not found.

When a Model Invocation with a persisted continuation raises that error, the Agent Runtime:

1. records the failed Invocation and its Provider Attempt normally;
2. clears the in-memory continuation;
3. retries the same logical Step once without `previous_response_id`;
4. sends the current Project System Message followed by the complete durable Message projection;
5. persists the new Provider Response ID returned by the successful replay.

The fallback does not re-execute completed Tool Calls. Their durable `function_call` and
`function_call_output` Messages are replayed as model input. A successful replay starts a new
Provider response chain, so later Model Invocations return to incremental input.

## Alternatives Considered

### Replay after every continuation request failure

This needs no Provider-specific classification, but retries authentication, rate-limit, timeout,
server, and malformed-request failures with a potentially large input. Those failures do not prove
that the response chain is unavailable.

### Reject expired Sessions permanently

This preserves a simple continuation-only state model but contradicts the Session contract: local
durable history outlives Provider retention and is sufficient to establish a new chain.

### Persist response creation time and reset at seven days

This can avoid one failed request for ordinary expiry, but it needs a storage migration and still
cannot handle early deletion or Provider-side loss. Error-driven recovery remains necessary.

## Consequences

- Sessions can recover after the Provider's seven-day response retention window.
- Normal continuations still send only incremental Messages.
- A confirmed unavailable continuation produces two durable Model Invocations for the same Step:
  one failed incremental attempt and one full-history replay.
- Only one automatic replay is allowed per Step; an error from the replay is surfaced normally.
- Long Sessions can still exceed the model context window during full replay. Context compaction
  remains a separate Runtime policy.
