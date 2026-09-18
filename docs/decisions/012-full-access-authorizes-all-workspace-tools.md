# ADR-012: Full access authorizes all Workspace Tools

## Status

Accepted

## Date

2026-09-18

## Context

ADR-006 introduced `--full-access` but limited it to read-only exploration. After Edit and Write were added, that meaning conflicted with the established meaning of full access in local Code Agents: an explicit process launch grants the Agent the same filesystem authority as its host process, while scoped mode remains the safe default.

Requiring users to attach every directory before modifying it makes `--full-access` appear active while mutation still fails. Adding a second write flag would split one clear trust decision into overlapping modes.

## Decision

`WorkspaceAccessMode` applies uniformly to every Workspace Tool. In `scoped` mode, Read, Edit, Write, Glob, and Grep accept only the Project's Primary and Attached Roots. In `full` mode, all five Tools may select any existing absolute local directory as their Root.

Full access changes Root authorization, not each Tool's operation rules. Paths remain relative to the selected Root; traversal and symbolic-link escape checks remain active; Edit still requires an existing UTF-8 file and one exact match; Write still creates only a new file without overwriting. Operating-system permissions and macOS privacy controls remain the outer limit.

The authorization applies only to the current CLI process and is never persisted. Every new or resumed process must receive `--full-access` again.

## Alternatives Considered

### Keep mutation Project-scoped

This preserves a narrower write policy but contradicts the user-facing name and causes trusted local workflows to fail after broad access was explicitly requested.

### Add a separate full-write flag

This exposes finer-grained policy but creates combinations that are not yet needed. A future approval system can represent granular permissions when the Agent has more side-effecting capabilities.

## Consequences

- `--full-access` now authorizes Edit and Write outside Project Roots.
- Scoped mode remains unchanged and continues to reject unregistered Roots.
- Full access is a high-trust mode because a model-directed Tool Call can modify any file writable by the CLI process.
- Future mutating Workspace Tools inherit the same access mode unless their operation requires a separate authorization model.
