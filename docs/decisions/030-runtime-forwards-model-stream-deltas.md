# ADR-030: Runtime forwards model stream deltas

## Status

Accepted

## Date

2026-09-26

## Context

ADR-025 made the Responses adapter consume raw SSE events, but kept `Model.generate()` as a
complete-result-only boundary. The Runtime and CLI therefore remained silent until the terminal
Response arrived even though output text and provider reasoning were already available.

The complete terminal Response must remain authoritative for tool calls, usage, continuation IDs,
durable Steps, and recovery. Persisting every text fragment would add high write volume and make
Session state depend on provider-specific chunk boundaries.

## Decision

Add an optional awaited `onStream` callback to `Model.generate()`. The provider-neutral event has
only two variants: `output-text` and `reasoning`, each carrying one text delta.

`OpenAICompatibleResponsesModel` maps `response.output_text.delta`,
`response.reasoning_text.delta`, and `response.reasoning_summary_text.delta` into that callback as
the raw SSE decoder yields them. `AgentSession` immediately forwards each callback as a transient
`model.delta` Agent Event. It does not persist delta events or add them to model Messages.

The CLI writes delta fragments directly so they are visible before `Model.generate()` resolves. It
suspends the live elapsed-time line while a fragment stream is active, closes the stream before the
next non-delta event, and does not print the same reasoning or output again from `model.completed`.
The final `ModelOutput` remains the only source for persistence, tool dispatch, and the return value.

## Alternatives Considered

### Return an AsyncIterable from Model.generate

This gives callers full control over the stream, but forces every Model implementation and Runtime
caller to assemble a terminal result and handle errors. An optional callback extends the existing
contract without moving provider response assembly out of the adapter.

### Persist every delta

This would support exact replay after a process crash, but chunk boundaries are transport details
and the write volume is disproportionate. Durable recovery continues from completed Steps; partial
display from a failed invocation is explicitly ephemeral.

### Stream only final answer text

This is simpler, but would retain the same long silent periods for providers that emit reasoning
before output. Both explicit provider reasoning and output text are therefore forwarded.

## Consequences

- Users see provider reasoning and answer text while the model is still generating.
- Non-streaming Model implementations remain compatible because `onStream` is optional.
- UI adapters can consume the same typed Runtime event without parsing provider SSE shapes.
- A failed invocation can leave already displayed partial text that is not present in durable state.
- Markdown is emitted as raw incremental text; terminal rendering of incomplete Markdown is not
  attempted.
