# ADR-002: MySQL persists Sessions, Turns, and Steps

## Status

Accepted

## Date

2026-09-17

## Context

ADR-001 made `AgentSession` the owner of ordered multi-turn history, but process memory could not restore a Session after restart and discarded failed execution details. The project is intended to become a deployable Agent rather than a local-only demonstration, and MySQL is already available in the target development environment.

Persistence must retain completed and failed execution records without sending failed Turns back to the model. It must also prevent two processes from starting Turns concurrently on the same Session.

## Decision

Persist the domain model in MySQL using `agent_sessions`, `agent_turns`, and `agent_steps`. A Step contains either a final model answer or one tool call together with its execution result. Failed Turns and Steps remain queryable for diagnosis; only completed Turns are projected into model-visible Messages.

The Agent runtime depends on the small `SessionStore` interface. The MySQL Adapter owns SQL, migrations, transactions, and row validation. Starting a Turn locks its Session row before allocating the next Turn number, so concurrent writers cannot interleave two active Turns.

## Alternatives Considered

### Keep the message array only in memory

This is simple but loses every Session on restart and cannot retain failed execution attempts. It no longer meets the product goal.

### SQLite

SQLite would provide the fastest zero-configuration path and excellent isolated tests. It was not chosen for the product Adapter because the target already has MySQL and needs to exercise connection pooling, transactions, and multi-process concurrency behavior early.

### Store a single JSON document per Session

One document closely resembles the current message array, but every Step would rewrite growing state and make failed Turn, Step, and tool-call queries awkward. Relational rows preserve ordering while keeping execution records independently inspectable.

### Event sourcing

An append-only event log could reconstruct all state and support replay, but it would add projection/versioning complexity before replay is a requirement. The current relational model records each lifecycle stage directly and keeps a future event-log evolution possible behind `SessionStore`.

## Consequences

- CLI sessions can be resumed by ID after a normal process exit.
- A database migration version is recorded independently of application releases.
- Tests can use the in-memory Adapter through the same interface; a separate integration test verifies real MySQL behavior.
- A process crash can leave a Turn in `running`; automatic lease expiry and recovery are deliberately deferred because safe recovery requires ownership and idempotency rules.
- Tool execution and result persistence are not atomic. Side-effecting tools will require idempotency keys or an execution outbox before automatic retries are safe.
