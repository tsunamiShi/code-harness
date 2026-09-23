# ADR-018: Console traces fold successful inspection Tools by default

## Status

Superseded in part by ADR-026

ADR-026 adds runtime `Ctrl+O` mode switching, further reduces compact output, and replaces raw JSON presentation in verbose mode. The successful-inspection folding and persistence boundaries in this decision remain accepted.

## Date

2026-09-21

## Context

ADR-008 separated Runtime events from terminal formatting and initially displayed every Tool Call argument and up to 4,000 result characters. Code exploration can issue many `Read`, `Glob`, `Grep`, and `LSP` calls, causing routine source content and path lists to dominate the terminal while the Turn's model decisions, mutations, failures, and final answer become difficult to follow.

A normal line-oriented terminal has no portable, persistent click-to-expand control. ANSI cursor rewriting can temporarily hide output but behaves poorly in redirected logs, terminal scrollback, and concurrent output. The complete execution facts already remain available in Session storage and model-visible Tool Results.

## Decision

Keep `AgentEvent` and persistence unchanged. Add two Console Trace presentation modes selected by `AGENT_TRACE`:

- `compact` is the default. It buffers successful `Read`, `Glob`, `Grep`, and `LSP` completion events within a Step and emits one summary containing counts by Tool, up to three abbreviated targets, and the slowest duration.
- `verbose` preserves the existing presentation of Tool Batch scheduling, every Tool argument, and every truncated Tool Result.

Expanded Tool Results retain at most 800 source characters by default, split between the beginning and end so command summaries and trailing errors remain visible. `AGENT_TRACE_MAX_RESULT_CHARS` changes this presentation limit without modifying the complete result persisted in MySQL or sent back to the model.

Compact mode always expands a failed inspection Tool so its arguments and error remain actionable. It also always expands `Edit`, `Write`, `Bash`, and unknown Tools because their mutations, process output, or unfamiliar behavior should remain visible.

## Alternatives Considered

### Hide all Tool events

This produces a clean transcript but removes evidence that the Agent is making progress and makes failures or dangerous mutations easy to miss.

### Fold every Tool including writes and Bash

Mutation and process execution are materially more important than repetitive perception. Hiding their arguments and results would make the CLI unsafe to supervise.

### Build an interactive TUI

A TUI can provide real expandable rows but introduces screen ownership, keyboard navigation, resize handling, and redirected-output behavior. Presentation modes solve the immediate density problem without changing the CLI interaction model.

## Consequences

- Normal repository exploration occupies substantially fewer terminal lines.
- Inspection failures, file mutations, and shell commands remain explicit by default.
- `AGENT_TRACE=verbose` provides the full live diagnostic trace without changing Runtime behavior.
- `AGENT_TRACE_MAX_RESULT_CHARS` tunes expanded result previews independently of trace mode.
- Compact summaries are presentation artifacts; they do not replace durable Session records or full Tool Results sent to the model.
