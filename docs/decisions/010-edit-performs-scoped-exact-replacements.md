# ADR-010: Edit performs scoped exact replacements

## Status

Accepted

## Date

2026-09-18

## Context

The Agent can locate and read code but cannot change it. Bug fixing requires a mutation Tool whose result is precise enough to diagnose failures and whose behavior does not overwrite unrelated user work.

Sending a complete replacement file consumes more context and can erase concurrent changes based on a stale Read. General patch formats support multiple operations but require a parser, more failure semantics, and decisions about partial multi-file application before the Agent needs those capabilities.

Full filesystem access is an explicit launch-time decision to trust the Agent with local files. Edit must preserve its file-level safety checks while honoring that selected Root authority.

## Decision

Add an `Edit` Tool that replaces `oldText` with `newText` in one existing UTF-8 file. `oldText` must be non-empty, differ from `newText`, and occur exactly once. A missing match tells the model to read current content; multiple matches require more surrounding context. An empty `newText` deletes the matched text.

Edit accepts the Project's Primary and Attached Roots in scoped mode. With `--full-access`, it can select any existing absolute local directory as its Root. Relative-path, canonical-path, symbolic-link, regular-file, and binary checks are shared with the existing Workspace implementation.

The target file may be at most 2 MB, and each replacement argument may contain at most 64,000 characters. Edit writes a same-directory temporary file with the target mode, verifies that the source content has not changed since it was read, and renames the temporary file over the target. Its Tool Result includes the changed line range and before/after SHA-256 values without returning the complete file again.

Edit is not parallel-safe. A Tool Call batch containing Edit is therefore executed serially by the Runtime. Interactive write approval remains a separate future Runtime policy; Workspace Access Mode is the current Root authorization.

## Alternatives Considered

### Replace the complete file

This has a small Tool interface but increases token use and makes accidental removal of unrelated or concurrently added content more likely.

### Implement ApplyPatch first

A patch Tool can edit and create multiple files, but parsing, partial failure, deletion, and multi-file atomicity expand the interface before a single-file exact replacement has been evaluated.

### Use Bash for file mutation

Shell commands can modify files but make quoting, path authorization, concurrency checks, and structured results depend on every generated command.

## Consequences

- The Agent can make focused modifications to existing Project files and receive a compact verifiable result.
- Concurrent or stale content usually fails through exact matching or the pre-rename content check instead of silently overwriting the observed file.
- Edit cannot create files, replace repeated text without context, change binary files, or escape its selected Root.
- A process crash before rename leaves the original target intact; failed writes remove their temporary file.
- File metadata other than the permission mode is not preserved by the replacement strategy.
- Approval, Bash, cumulative context budgets, and multi-file transactions remain future capabilities.
