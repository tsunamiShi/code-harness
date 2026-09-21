# ADR-017: Agent Loop has no Step budget and unfinished Turns are recoverable

## Status

Accepted

## Date

2026-09-20

## Context

A Step counts one successful model decision, not task progress. Repository exploration, diagnosis, editing, and verification can require an unpredictable number of decisions. The previous fixed `maxSteps` budget removed Tools from the last model request and failed the entire Turn when the budget was exhausted. Increasing that number only moved the failure point.

Failed Turns were retained for diagnosis but excluded from model-visible Messages. A provider timeout after many completed Tool Calls therefore forced a later Turn to repeat exploration. A process exit could also leave a Model Invocation or Tool Call in `running` state.

The Runtime still needs to prevent one model response from producing unbounded text. Recovery must not blindly execute an interrupted side-effecting Tool again because the process may have exited after the side effect but before persisting its result.

## Decision

Run the Agent Loop until the model returns a final answer or an exception interrupts the Turn. Do not limit the number of Steps and do not remove Tools from a model request based on iteration count.

Pass the configured `maxTokens` to every `Model.generate()` call. The OpenAI-compatible Adapter sends it as `max_tokens`. This is an independent output limit for each Model Invocation, not a cumulative Turn budget. A response with `finish_reason=length` is an incomplete Invocation and fails the Turn instead of becoming a final answer. ADR-020 supersedes this decision's original 4096-token default and makes the limit optional.

Keep every successfully persisted Step in the model-visible projection of the final `failed` or `running` Turn. A Session with such a Turn must continue it before accepting another user prompt. `continueTurn()` reopens the same Turn, reconstructs Messages from storage, and resumes at the first Step that has no durable model decision. MySQL schema version 5 allows multiple Model Invocations for one Step so a failed request and its later retry remain independently observable.

During recovery, preserve completed Tool Results. Convert Tool Calls that are still `running` into Tool Errors explaining that their result is unknown, then return those errors to the model. Do not execute them automatically. This protects non-idempotent `Edit`, `Write`, and `Bash` calls from duplicate side effects while allowing the model to inspect current state and choose the next action.

## Alternatives Considered

### Increase `maxSteps`

A larger value reduces the frequency of failure but still terminates valid work based on a metric unrelated to completion.

### Apply one cumulative token budget to the Turn

This provides a cost ceiling but again forces long tasks to stop after useful progress. The requested limit is specifically per model response. Aggregate cost policy can be added independently without changing loop completion semantics.

### Replay every incomplete Tool Call

Automatic replay is safe only for proven idempotent operations. The current Tool interface does not encode idempotency, and duplicate file edits or shell commands can corrupt state.

### Start a new Turn after failure

This keeps storage transitions simple but inserts another user message and loses the meaning that the Agent is still handling the original request.

## Consequences

- Long tasks can use as many model-and-tool Steps as needed to reach a final answer.
- A configured output limit bounds each model response independently; total task time and token consumption are intentionally not bounded by this decision.
- Provider failures preserve prior exploration and can retry the same logical Step without overwriting Invocation history.
- Reconnecting with `--session` automatically continues the final unfinished Turn; `/retry` repeats recovery after another failure.
- A recovered Tool Error reports uncertainty rather than claiming whether an interrupted side effect occurred.
- User cancellation, context compaction, and lease ownership remain future runtime policies. ADR-021 adds advisory exact-repeat detection without restoring a maximum Step count.
