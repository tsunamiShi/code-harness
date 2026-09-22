# ADR-024: Responses continuation sends System instructions only once

## Status

Accepted

## Date

2026-09-22

## Context

ADR-022 established durable Responses continuation through `previous_response_id`. It also required every continuation request to send the current Project instructions again as a System Message.

Alibaba Model Studio retains the original System Message when resolving a response chain. A continuation request that supplies another System Message is therefore rejected with HTTP 400 because the effective input contains more than one System Message. The failure occurs on the first Model Invocation after a Tool Result, before the model can continue the Turn.

## Decision

Send Project instructions as the single leading System Message only when starting a response chain. After a Provider Response ID exists:

- send `previous_response_id`;
- send only Messages added after the referenced Provider response;
- map Tool Results to `function_call_output` items;
- do not send another System Message.

This decision supersedes only ADR-022's requirement to resend current Project instructions on every continuation request. Its durable Provider Response ID and incremental-input decisions remain accepted.

## Alternatives Considered

### Resend identical Project instructions

This keeps each request locally self-describing, but Alibaba Model Studio combines the retained and new System Messages and rejects the request.

### Replay the complete local history without `previous_response_id`

This guarantees one current System Message and can reflect changed Project instructions, but discards provider-side continuation state and restores the serialization and transfer cost ADR-022 removed.

### Reset continuation only when Project instructions change

This could reflect changed roots or access mode without repeating System Messages, but requires persisting and comparing the instructions associated with every Provider Response ID. That lifecycle is outside this bug fix.

## Consequences

- The first request contains one System Message followed by the user input.
- Tool and later Turn continuations contain only incremental input plus `previous_response_id`.
- Alibaba Model Studio no longer rejects continuation requests for containing multiple System Messages.
- A response chain retains the Project instructions from the request that created it. Runtime filesystem enforcement remains authoritative, but changed Project roots or access-mode guidance are not reflected in that provider chain until continuation is explicitly reset.
