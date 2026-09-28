# ADR-038: Console Trace uses a shared semantic color palette

## Status

Accepted

## Date

2026-09-26

## Context

The CLI rendered almost every Execution Trace line in the default foreground. Turn and Step headers, tool names, latency metadata, structural glyphs (`┌─`, `├─`, `└─`, `│`), success markers, and failure markers all carried the same visual weight, so long Turns read as a wall of white text in which nothing stood out. Color helpers were also private to `console-trace.ts`, while `chat.ts`, the Markdown renderer, the transient elapsed-time line, and slash-command output each printed plain text with no shared palette. ANSI state was duplicated as ad-hoc escape strings in `turn-elapsed.ts`.

## Decision

Introduce one shared palette module, `src/cli/colors.ts`, exporting a `TraceColor` interface and a `createColor(enabled)` factory. Every CLI presentation surface—Console Trace, the chat banner, Markdown Final Content previews, the elapsed-time line, and slash-command output—consumes the same palette instead of defining its own escapes. `supportsColor(stream)` centralizes the existing TTY + `NO_COLOR` policy that previously lived inline in `chat.ts`.

The palette encodes a semantic hierarchy:

- structural glyphs (`┌─`, `├─`, `└─`, `│`) are dim, so the execution chain stops competing with content;
- markers stay semantic: green `✓` for success, red `✗` for failure, yellow `▶`/`→`/`!` for in-progress and advisory states;
- subjects carry the message: bold cyan for Turn/Step headers and tool names, bold green/red for turn outcomes, cyan for user prompts and Tool arguments, magenta for Provider reasoning;
- metadata (ids, counts, durations, paths, thresholds) is dim everywhere;
- Final content and streamed output deltas remain in the default foreground so the answer stays the brightest anchor on screen.

Markdown previews pass the same `colors` flag into marked-terminal theme functions (bold cyan headings, yellow code, cyan links, dim italic blockquotes). All color helpers degrade to identity functions when disabled, so non-TTY output, `NO_COLOR`, and every existing test that asserts plain text remain byte-identical. `block()` accepts an optional palette so its gutters dim without changing label decoration, and `TurnElapsedDisplayOptions` gains an explicit `colors` option separate from `enabled` because enabling the display does not imply a color-capable stream.

## Alternatives Considered

### Color only the failure lines

Failures would stand out, but the complaint was visual hierarchy across the whole trace; leaving metadata, structure, and subjects monochrome preserves the wall-of-white problem.

### Adopt a full terminal framework (ink, blessed)

A component framework could own layout and theming, but the CLI is a line-oriented trace with transient single-line updates; a framework adds screen ownership, resize, and scrollback concerns for no hierarchy benefit.

### Keep per-module color helpers

Duplicating escape handling per file keeps modules isolated, but drifts: the Markdown theme, elapsed line, and banner would each re-derive the TTY/`NO_COLOR` policy and invent inconsistent shades for the same meanings.

## Consequences

- One palette to adjust: changing a shade or adding a semantic style edits `colors.ts` and applies everywhere.
- Structure lines and metadata recede; successes, failures, headers, and tool names pop.
- Final content stays default-foreground white and remains the visual anchor.
- Tests assert both the enabled palette (escape sequences present) and the disabled fallback (no escapes), guarding the byte-identical non-TTY contract.
