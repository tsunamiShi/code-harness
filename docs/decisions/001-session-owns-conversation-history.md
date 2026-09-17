# ADR-001: Session owns multi-turn conversation history

## Status

Accepted

## Date

2026-09-17

## Context

The initial `runAgent()` function created a new message array for every call. That supported one user prompt but discarded the completed exchange before a follow-up question could reference it.

Multi-turn conversation requires one owner for message ordering, per-turn execution, and concurrent input behavior. The project does not yet have durable events or a database representation for failed turns.

## Decision

Introduce `AgentSession` as the in-memory owner of one conversation. `send(prompt)` executes one turn and retains its completed user and assistant messages for later turns. The step limit resets for each turn.

Only one `send()` may run at a time on a session. Concurrent calls fail rather than interleave messages nondeterministically.

If a turn fails, its newly appended messages are rolled back. This preserves a valid model history while the message model cannot represent failed attempts. `runAgent()` remains as a one-turn compatibility wrapper around a disposable session.

## Alternatives Considered

### Pass messages into and out of `runAgent()`

This keeps the runtime stateless, but every caller must own ordering, defensive copies, and concurrent writes. The complexity would be repeated across the CLI, HTTP handlers, tests, and future workers.

### Persist sessions immediately

Durable storage is required later for restart recovery, but choosing a database and event format is a separate decision. Adding it now would hide the simpler distinction between a turn and a session.

### Queue concurrent sends

Implicit queuing makes cancellation and user steering ambiguous. The first interface fails loud; a future inbox can define explicit ordering semantics.

## Consequences

- Follow-up prompts see every completed prior turn.
- One session is sequential even when multiple sessions run concurrently.
- Failed turn details are not retained yet.
- Long conversations will eventually exceed model context and require context management.
- Process restart loses the session until durable storage is introduced.
