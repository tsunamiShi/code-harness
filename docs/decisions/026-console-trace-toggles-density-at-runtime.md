# ADR-026: Console Trace toggles density at runtime

## Status

Accepted

## Date

2026-09-23

## Context

ADR-018 made `compact` the default Console Trace mode, but it still expanded Bash results, Provider reasoning, and every Provider Attempt milestone. A long Agent Turn therefore remained difficult to follow even though successful inspection Tools were folded. Selecting `AGENT_TRACE=verbose` also required restarting the CLI, which made it impractical to inspect one suspicious part of an otherwise routine Turn.

Verbose Tool arguments and results were formatted as JSON. That accurately represented the stored values but emphasized serialization syntax, large text fields, and arrays instead of the fields a human uses to understand the operation.

## Decision

Keep Console Trace as the presentation Adapter for unchanged Agent Events, and let it own mutable display mode. `compact` remains the default and `AGENT_TRACE` selects only the initial mode.

In an interactive terminal, bind `Ctrl+O` to toggle the active Console Trace between `compact` and `verbose` without restarting or changing the current Turn. Toggling affects future output; it does not replay previously hidden events. Non-interactive input has no shortcut binding.

Compact mode presents the execution outline:

- combine response headers, first SSE Event, event count, and total duration into one completed-Attempt line;
- hide intermediate Provider reasoning while retaining the final answer and a short model-authored plan when present;
- fold successful `Read`, `Glob`, `Grep`, and `LSP` calls as defined by ADR-018;
- display the Bash command when execution begins, but omit successful Bash result content;
- display concise mutation completion lines and retain one actionable error reason for Tool failures without expanding the full result payload.

Verbose mode presents individual milestones and Tool details, but formats structured arguments and results as named semantic fields instead of raw JSON. Large Edit/Write text inputs are represented by character counts, arrays by item counts, and Bash results by exit, timeout, truncation, stdout, and stderr fields. The existing result character limit still bounds displayed text.

The keyboard Adapter, transient elapsed-time display, and Console Trace have separate interfaces. A mode-change notification temporarily clears and then restores the elapsed-time line so concurrent terminal output remains readable.

This decision supersedes ADR-018's clauses that compact mode expands Bash result output and that mode can only be selected through `AGENT_TRACE`. Its persistence boundary and successful-inspection folding remain accepted.

## Alternatives Considered

### Keep restart-only environment configuration

This keeps terminal input simpler, but requires predicting when detail will be needed and restarting or recovering the Session to change presentation.

### Replay hidden events when switching to verbose

Replay would reconstruct earlier detail but duplicate the active Turn timeline and require Console Trace to retain potentially large result payloads solely for presentation.

### Build an interactive TUI with expandable rows

A TUI can expand individual events but requires complete screen ownership, navigation, resize, scrollback, and redirected-output policies. A single density shortcut addresses the current supervision need without that complexity.

### Continue rendering structured values as JSON

JSON is lossless and easy to implement, but braces, quoting, nested source content, and large arrays obscure the command, target, exit state, and other operational fields.

## Consequences

- Routine Turns use fewer lines while preserving the execution outline and latency signals.
- Bash success output is still persisted and returned to the model even though compact terminal output hides it.
- `Ctrl+O` can expose future detailed events during a suspicious Turn and switch back afterward.
- Verbose output is a human-oriented projection rather than a byte-for-byte rendering of stored JSON.
- Previously hidden events are not retroactively available in terminal scrollback; durable Session records remain the source for later diagnosis.
