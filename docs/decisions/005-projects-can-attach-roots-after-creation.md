# ADR-005: Projects can attach roots after creation

## Status

Accepted

## Date

2026-09-17

## Context

ADR-003 introduced multi-root Projects but the first Project CLI could select Attached Roots only during creation. Code tasks frequently discover a shared package, backend repository, or configuration directory after a Project and its Sessions already exist. Recreating the Project would produce a new identity and disconnect its existing Sessions.

Project updates must preserve exactly one Primary Root, canonicalize local directories in the same way as creation, and behave predictably when two CLI processes attach directories concurrently.

## Decision

Add `ProjectCatalog.attach(projectId, path)` and the CLI command `pnpm project attach <project-id> --path <directory>`. The catalog resolves the supplied directory to its real absolute path before crossing the ProjectStore seam.

The MySQL Adapter locks the Project row, checks whether the canonical path is already present, and inserts it with the `attached` role in one transaction. Attaching an existing Primary or Attached Root is idempotent and returns the unchanged Project. The Primary Root cannot be changed through this command.

New and resumed CLI processes load the updated Project and construct `Read`, `Glob`, and `Grep` with the new root. A running CLI keeps its startup Project snapshot; dynamic Tool reconfiguration is deferred.

## Alternatives Considered

### Recreate the Project

This reuses the existing creation command but changes Project identity and leaves existing Sessions bound to obsolete root configuration.

### Let individual Sessions add roots

This would duplicate workspace configuration and weaken Project as the durable authorization owner shared by its Sessions.

### Automatically discover and authorize referenced directories

Discovery is not authorization. Automatically expanding roots from imports, symbolic links, or model output would allow code content to grant filesystem access.

## Consequences

- Existing Projects can grow without changing identity or Session ownership.
- Attaching a directory is explicit and occurs outside the Agent Loop.
- The database schema does not change because `agent_project_roots` already supports multiple Attached Roots.
- Removing roots, replacing the Primary Root, and hot-reloading a running CLI remain unsupported.
