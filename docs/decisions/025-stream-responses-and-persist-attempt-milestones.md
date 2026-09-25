# ADR-025: Responses stream and Provider Attempt milestones are durable

## Status

Accepted

The decision to keep every text delta below `AgentSession` is superseded by
[ADR-030](030-runtime-forwards-model-stream-deltas.md). The raw SSE decoder and durable Provider
Attempt milestone decisions remain accepted.

## Date

2026-09-22

## Context

The Responses Model Adapter previously waited for the complete HTTP response before returning control to Runtime. A slow Model Invocation therefore exposed only its total duration. The existing Provider Attempt record could not distinguish time spent waiting for response headers, time spent waiting for the first decoded server-sent event, or time spent receiving the remaining stream. A transport timeout also lost the nested network error code that can distinguish a provider HTTP response from a client or connection-layer failure.

Without these boundaries, a long Turn or `Request timed out.` error is insufficient evidence that the model provider itself was unstable. The same symptom can come from connection establishment, response-header latency, stream stalls, a lower transport timeout, or SDK retry behavior.

## Decision

Use the OpenAI SDK's raw Responses SSE decoder inside `OpenAICompatibleResponsesModel`. The Adapter consumes the complete event stream and takes the final Response from the `response.completed`, `response.incomplete`, or `response.failed` terminal event, while keeping the existing `Model.generate()` contract unchanged. Streaming is therefore a transport and observability detail rather than a new responsibility for `AgentSession`.

Do not use the SDK `ResponseStream` accumulator as the source of the final Response. Alibaba Model Studio can emit `response.reasoning_text.delta` for `content_index=0` after adding a reasoning output item without first emitting `response.content_part.added`. The raw event sequence is usable and its terminal event contains the complete Response, but the SDK 7.15.0 accumulator rejects the intermediate sequence with `missing content at index 0`.

Represent each actual Provider Attempt with a private, forward-only state machine:

```text
requesting -> headers-received -> streaming -> completed
     |               |              |
     +---------------+--------------+-> failed
```

- `requesting` begins immediately before the SDK's observed `fetch` call.
- `headers-received` begins when `fetch` resolves with the HTTP response.
- `streaming` begins when the SDK yields the first decoded SSE event.
- `completed` means the response stream ended after providing a terminal event with the complete Response.
- `failed` records the phase in which the Attempt stopped. An SDK retry starts a new Provider Attempt; it never rewinds an existing Attempt.

Emit Runtime Agent Events and persist only these lifecycle milestones. For each Attempt, MySQL schema version 10 stores header latency, first-event latency and type, total duration, decoded event count, terminal phase, HTTP status, provider request ID, and the nested transport cause name/code/message when present. Do not persist every SSE event or text delta.

`completed` describes transport completion. The final Response can still be rejected by the Model Adapter as an incomplete model result, and the enclosing Model Invocation can consequently fail.

## Alternatives Considered

### Expose an async stream through the Model interface

This would let Runtime react to every delta, but would spread provider protocol concerns through `AgentSession`, storage, and CLI rendering before incremental user-visible output is required.

### Measure only time to response headers

Header latency identifies pre-response delays but cannot show a server that accepts the request and then stalls before its first SSE event.

### Persist every SSE event

This offers replay-level detail but increases write volume and couples the durable schema to provider-specific event shapes. Milestones are sufficient for current latency and timeout diagnosis.

### Keep the non-streaming Responses request

This preserves simpler transport handling, but total duration alone cannot localize delays or separate pre-header failures from stream failures.

## Consequences

- The CLI shows response-header and first-SSE-event latency while a Model Invocation is running.
- MySQL can distinguish failed Attempts in `requesting`, `headers-received`, and `streaming` phases and retain lower-layer error codes such as Undici timeout codes.
- SDK retries remain visible as separate Provider Attempts under one Model Invocation.
- The public Model interface and Step semantics remain unchanged because the Adapter still returns one complete model result.
- SSE framing and JSON decoding depend on the OpenAI SDK, while Provider-specific intermediate event ordering is not passed through its stricter Response accumulator.
- ADR-030 later adds transient user-visible text and reasoning deltas while preserving the complete terminal Response as the durable result.
