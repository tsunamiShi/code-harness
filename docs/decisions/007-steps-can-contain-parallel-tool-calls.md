# ADR-007: Steps can contain parallel Tool Calls

## Status

Accepted

## Date

2026-09-17

## Context

The initial Agent Loop allowed exactly one Tool Call per Step and stopped after ten Steps. A real exploration of a larger repository completed one `Glob` and nine `Read` calls, then failed before the model received another inference in which it could produce the final answer.

Independent file reads are naturally concurrent. The configured `glm-5.3` provider was verified through the OpenAI-compatible endpoint to return multiple Tool Calls when `parallel_tool_calls` is enabled. Treating every returned call as a separate Step would misrepresent one model inference as several Steps and make replay inaccurate.

## Decision

`ModelOutput` can return a non-empty Tool Call batch. One Step records the assistant batch, every Tool Call, and every corresponding Tool Result. The Runtime executes the batch concurrently only when every selected Tool declares `parallelSafe: true`; otherwise it preserves call order and executes serially. `Read`, `Glob`, and `Grep` are parallel-safe. Future mutation and process Tools are serial unless they explicitly prove otherwise.

The default Turn budget increases from 10 to 50 Steps. `AGENT_MAX_STEPS` can configure a value from 1 through 500. The budget still counts model inferences, not Tool Calls, and resets for every Turn. The final available Step omits Tools from the model request so a compliant provider must use the remaining inference to produce a final answer rather than start work the Runtime cannot continue.

MySQL schema version 3 adds `agent_tool_calls` as children of `agent_steps`. Existing single-call Step fields are copied into the child table during migration. A Step becomes completed after every child Tool Call reaches either completed or failed status; individual Tool errors remain model-visible and recoverable.

## Alternatives Considered

### Only increase the Step limit

This prevents the immediate failure but leaves independent reads serial and keeps the runtime model narrower than the provider response format.

### Add a `ReadMany` Tool

This optimizes one operation by expanding the model-visible Tool surface. Parallel Tool Calls solve the general scheduling problem without creating overlapping Tools.

### Count each Tool Call as one Step

This is easy to store but contradicts the domain definition that one Step is one model inference. A provider response containing five calls would be incorrectly reconstructed as five decisions.

### Execute every batch concurrently

This is unsafe for future `Edit`, `Shell`, or other side-effecting Tools whose ordering may matter. Concurrency is an explicit Tool property and defaults to serial.

### Remove the Step limit

An unbounded model loop can consume unlimited time and provider tokens. A larger configurable guard keeps failure bounded while supporting realistic exploration.

## Consequences

- Ten Tool Steps followed by a final-answer Step now complete under the default budget.
- A model-produced batch of file exploration calls can execute concurrently and remains one durable Step.
- The model can still choose sequential reads across separate inferences; parallel support does not replace future planning and behavior evaluation.
- Released database rows remain readable after the version 3 migration; legacy Tool columns stay in place but new writes use `agent_tool_calls`.
