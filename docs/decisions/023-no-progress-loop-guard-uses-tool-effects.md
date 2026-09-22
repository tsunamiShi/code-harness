# ADR-023: No-progress Loop Guard uses Tool effects

## Status

Accepted

## Date

2026-09-21

## Context

ADR-021 detects exact repeated Tool Calls, but a long implementation task can stall while the model changes file paths, line ranges, and search terms on every Step. A regression comparison reproduced this behavior before and after the Responses migration: the Agent completed more than fifty successful Read and Bash Steps without attempting Edit or Write. Exact-repeat detection remained silent because the Tool arguments changed.

A semantic supervisor could classify whether the whole trajectory is useful, but it would add model latency and could reinterpret the user's intent. A hard Step limit would terminate legitimate long tasks. The Runtime instead needs a deterministic signal that advises the main model without deciding whether the task requires modification.

## Decision

Classify every Tool with one static effect:

- `observe` reads state without intending a persistent change;
- `mutate` can create a persistent file change;
- `execute` runs an operation whose side effects the Runtime does not infer.

Read, Glob, Grep, and LSP are `observe`; Edit and Write are `mutate`; Bash is `execute`. Only a successful `mutate` Tool Call is durable file progress. A failed mutation does not reset the no-progress count.

Run composable Loop Guard policies after each completed Tool Step. Count Steps rather than Tool Calls so a parallel inspection batch remains one model decision. The no-progress policy emits deterministic reminders after 12 and 24 consecutive Steps without a successful mutation. `AGENT_NO_PROGRESS_THRESHOLDS` accepts a comma-separated list of unique integers greater than one.

The reminder asks the main model to re-evaluate whether it has enough evidence to implement, whether one specific fact is still missing, or whether a read-only task can finish. It explicitly does not require a file change. It is persisted and restored as an ordinary User Message. It does not call another model, change the System Prompt, remove Tools, stop the Turn, or impose a Step budget.

Generalize persisted reminders to `kind`, `metric`, `summary`, and `content`. MySQL schema version 9 replaces the earlier reminder table and removes the unused semantic-review table. Released local schema compatibility and old reminder rows are intentionally not preserved.

## Alternatives Considered

### Treat every Bash call as progress

Bash can run tests or Git operations, but it was also the dominant inspection mechanism in the reproduced loop. Treating it as progress would hide the failure mode. The advisory text prevents the opposite classification from forcing mutation on legitimate command-only tasks.

### Count Tool Calls

This would penalize efficient parallel inspection because one model decision can contain many independent calls. Step counting measures decisions and produces stable thresholds regardless of batch width.

### Add a Planner first

A durable Plan and Goal model is the stronger solution for complex work, but it introduces new lifecycle and persistence state. The no-progress reminder is a smaller Runtime Policy that tests whether explicit progress feedback can make the current model converge before adding Planner authority.

### Ask a small model to judge progress

This could recognize semantic progress, but it adds cost, latency, and another source of intent errors on every threshold. The deterministic signal is sufficient for an advisory reminder.

## Consequences

- Long read-only trajectories receive bounded feedback without a second model request.
- Successful Edit or Write calls reset the no-progress count.
- Read-only analysis can continue because reminders are advisory and explicitly permit it.
- Bash-based mutations are not recognized as file progress; the project instructions already require Edit or Write for file changes.
- A model may ignore the reminder. Planner and Goal state remain a later, separate capability.
