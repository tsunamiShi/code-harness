# ADR-022: Responses continue from durable Provider state

## Status

Accepted

## Date

2026-09-21

## Context

The Model Adapter used OpenAI-compatible Chat Completions and replayed the complete normalized Message history on every Model Invocation. Migrating only the endpoint and JSON shape would leave that Chat Completions state model intact and would not use the Responses API continuation contract.

The Agent Runtime still needs durable recovery. A Provider Response ID that exists only in process memory would be lost when the CLI exits during a Tool Step, forcing a full replay or making the Turn impossible to resume.

Alibaba Model Studio exposes an OpenAI-compatible `/responses` endpoint for supported models. Responses links subsequent inputs with `previous_response_id`; function calls and function outputs are separate items connected by `call_id`.

## Decision

Replace `OpenAICompatibleChatModel` with `OpenAICompatibleResponsesModel` and call `client.responses.create`.

This supersedes the adapter-specific Chat Completions naming in ADR-009 and the Chat Completions field mapping originally described by ADR-020; their broader source-layout and optional-limit decisions remain accepted.

Persist the returned Provider Response ID on the durable Agent Step that represents the same model output. Project the newest persisted ID when restoring a Session. While that continuation exists:

- send `previous_response_id` on the next Model Invocation;
- send only Messages added after that Provider response;
- map Runtime Tool Results to `function_call_output` items;
- send the current Project instructions again as a System Message so Project Root and access changes are not hidden by an older Provider response.

For a new Session or legacy history without a persisted Provider Response ID, send the projected full context once. After the Provider returns a Response ID, continue incrementally.

Map Runtime Tool descriptions to non-strict Responses `function` tools. Read Tool Calls from `response.output`, use `call_id` as the Runtime Tool Call ID, map `maxTokens` to `max_output_tokens`, and treat an incomplete response as a failed Model Invocation.

This decision migrates the protocol and conversation continuation only. Provider-hosted Tools are not registered in this change; the Runtime Tool registry remains authoritative.

## Alternatives Considered

### Continue replaying complete context

This is resilient to Provider response expiration, but it keeps the Chat Completions state model and pays the serialization and transfer cost on every invocation.

### Keep Provider Response IDs only in memory

This works until the process exits. It conflicts with the existing guarantee that a Session can recover an unfinished Turn from durable Steps.

### Store Provider output items locally and remain stateless

Replaying every typed output item can preserve reasoning state without Provider retention, but it couples the provider-neutral Session schema to a large and evolving Responses item union.

## Consequences

- Normal follow-up requests send only new input plus `previous_response_id`.
- MySQL schema version 7 stores `provider_response_id` on `agent_steps`.
- Session recovery can continue a Provider response chain after process restart.
- Existing Sessions without a Response ID bootstrap the new chain by sending their full projected context once.
- The Provider must retain the referenced response. Expired or deleted response chains currently fail the Invocation instead of automatically replaying full history.
- Provider-hosted Tools remain unavailable until explicitly modeled and registered.
