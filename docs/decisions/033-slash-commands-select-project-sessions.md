# ADR-033: Slash commands select Sessions within the current Project

## Status

Accepted

## Date

2026-09-26

## Context

The interactive CLI recognized `/exit` and `/retry`, but users had to remember those commands and
could only resume a Session by restarting the process with a copied Session ID. A global CLI that
starts from the current directory already resolves that directory to one persistent Project, so the
same Project is the natural boundary for discovering resumable conversations.

Session selection must not expose conversations from unrelated Project roots. It should also avoid
requiring another Agent Runtime or database connection while switching, because the existing model,
tools, MCP connections, and Project authorization remain valid for Sessions from the same Project.

## Decision

Give the readline interface a completer for `/resume`, `/retry`, `/help`, and `/exit`. Entering `/`
or `/help` prints the same command list, while typing `/` and pressing Tab completes matching names.

`/resume` queries at most the 20 most recently updated Sessions whose `project_id` equals the current
Project. The current Session is omitted from the menu. Each choice shows its ID, update time, Turn
count, latest Turn status, and a bounded preview of the latest prompt. Selecting a number restores
that Session in the existing process with the same Runtime options. Any recoverable Turn follows the
normal continuation path immediately after selection.

## Alternatives Considered

### List Sessions from every Project

This makes discovery broader, but mixes unrelated filesystem authorization boundaries and makes a
directory-oriented workflow harder to reason about.

### Require restarting with `ai-agent --session`

This remains useful for direct automation, but adds copy-and-paste friction to an already interactive
workflow and does not provide Session discovery.

### Build a full-screen terminal picker

A full-screen picker can support arrow-key navigation, search, and previews, but adds terminal state
management and another UI dependency. Numbered selection plus readline completion covers the current
need while keeping the interaction portable and testable.

## Consequences

- Slash commands are discoverable through both `/` and Tab completion.
- `/resume` cannot switch across Project boundaries.
- Switching reuses the current Tool and MCP lifecycle instead of reconnecting them.
- Only the 20 most recently updated Sessions are selectable in one menu.
- The newly created current Session remains persisted when the user switches away before sending a
  Turn; empty-Session cleanup remains a separate lifecycle concern.
