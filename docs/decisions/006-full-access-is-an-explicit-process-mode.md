# ADR-006: Full filesystem access is an explicit process mode

## Status

Accepted

## Date

2026-09-17

## Context

Project-scoped filesystem access provides a durable authorization list, but requiring every exploratory directory to be attached interrupts local Code Agent workflows. Some users intentionally run the CLI as a trusted local process and prefer operating-system permissions to be the only filesystem authorization limit.

Removing Project checks globally would make every invocation broad by default. Persisting broad access on the Project would also let a later resumed Session inherit authority without an explicit decision at launch.

## Decision

Support two runtime `WorkspaceAccessMode` values:

- `scoped` is the default and accepts only the Project's Primary and Attached Roots.
- `full` accepts any existing absolute local directory as the `root` argument for `Read`, `Glob`, and `Grep`.

Users enable full access for one CLI process with `--full-access` on either a new or resumed Session. The mode is passed to the Workspace Tools and model instructions, displayed in the startup banner, and not persisted in MySQL. Every later CLI process defaults to `scoped` unless the flag is supplied again.

Full access changes root authorization only. Tool paths remain relative to the selected root, and the existing read-only behavior, binary checks, result limits, search exclusions, and timeouts remain active. Operating-system permissions and macOS privacy controls can still deny access.

## Alternatives Considered

### Make all filesystem access unrestricted

This is convenient but removes a safe default and makes an accidental broad search or sensitive-file read possible in every Session.

### Persist full access on Project

This reduces repeated flags but turns a launch-time authority decision into hidden durable state. Resuming an old Session could unexpectedly recover broad filesystem access.

### Require attaching every directory

This keeps durable authorization precise but does not serve trusted local workflows that intentionally prioritize convenience.

### Accept arbitrary absolute file paths only

This would create different path semantics between modes. Keeping `root + relative path` preserves one Tool Interface while changing only root authorization.

## Consequences

- Full access must be visibly requested on every CLI launch.
- The model can select an unregistered absolute directory without modifying the Project.
- A Session's persisted Messages do not imply that a future process has the same authority.
- Full access currently applies only to the read-only Workspace Tools; future mutation and Shell Tools need their own permission and approval design.
