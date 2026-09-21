# ADR-021: Repeat Tool Loop Guard is advisory

## Status

Accepted

## Date

2026-09-21

## Context

The Agent Loop has no Step budget so legitimate long tasks can finish. A guard is still useful for the narrower failure mode where the model repeatedly calls the same Tool with the same arguments without using the previous result.

A periodic semantic supervisor attempted to classify the entire trajectory as `continue`, `redirect`, or `stop`. That design added a model request every fixed number of Steps, duplicated intent policy in the project System Prompt, and could remove Tools from the main model. Question syntax is not a reliable authorization boundary, and an incorrect `stop` decision can terminate useful work.

DeepSeek Harness uses a narrower mechanism: canonically compare Tool names and arguments, remind at configured consecutive-repeat counts, and leave the decision with the main model. Its default thresholds are 3, 5, and 8. The deterministic trigger has no token cost before a repeat chain reaches a threshold.

## Decision

Keep `LoopGuard` as a Runtime Policy, but limit its trigger to consecutive Tool Calls with the same name and canonically equal arguments. Object property order does not affect identity; array order and values do. A different call resets the trailing repeat count.

Use thresholds `[3, 5, 8]` by default. `AGENT_LOOP_GUARD_THRESHOLDS` accepts a comma-separated list of unique integers greater than one.

When a threshold is reached, call an independent model with no Tools and a 2,048-token output limit. The default Guard model is `ZHIPU/GLM-5.3-Flash`, configurable through `DASHSCOPE_GUARD_MODEL`. Flash uses the OpenAI-compatible Chat Completions protocol because the Provider's Responses API supports `glm-5.3` but not this direct-supply Flash model. Its bounded input contains the original user request, Tool name, canonical arguments, repeat count, and latest Tool Result. It returns `NO_REMINDER` when repetition is legitimate or a concise advisory message otherwise. A failed or unusable Guard call fails open without changing the main Agent Loop.

Persist emitted reminders in `agent_loop_guard_reminders` and reconstruct them as ordinary User Messages when a Session resumes. The main model retains its complete Tool list after a reminder. The Guard never blocks a Tool Call, terminates a Turn, or injects a System Message.

Remove intent classification and forced-stopping rules from the project System Prompt. Tool-selection instructions remain because they describe the available runtime capabilities rather than infer user intent.

## Alternatives Considered

### Use the deterministic DeepSeek Harness reminder text directly

This is cheaper and more predictable. An independent Flash review is retained because identical polling or repeated reads can be legitimate; the small model can suppress an unnecessary reminder or tailor it to the latest result. The deterministic detector still prevents a model call on normal Tool usage.

### Periodically review the full trajectory

This catches broader drift but adds steady latency and cost to healthy long tasks. It also requires a semantic authority that can incorrectly reinterpret the user's intent.

### Restore a maximum Step count

A hard ceiling cannot distinguish a long task making progress from a short loop. It would recreate the completion failures that removing `maxSteps` addressed.

## Consequences

- Healthy Tool use causes no Guard model calls.
- Exact repeat chains can add one small Flash request at each configured threshold.
- Reminders advise the main model but cannot guarantee that it changes course.
- Near-duplicate calls with changed arguments are not detected.
- Guard model invocations are not yet recorded as ordinary Model Invocations; only emitted reminders are durable.
- The version-6 `agent_loop_guard_reviews` table remains as migration history, while new writes use `agent_loop_guard_reminders` from schema version 8.
