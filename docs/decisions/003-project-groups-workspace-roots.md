# ADR-003: Project groups workspace roots and selects one primary root

## Status

Accepted

## Date

2026-09-17

## Context

A Code Agent task may span an application repository, a shared package, and supporting configuration stored in different directories. Treating one process working directory as the entire workspace would either exclude legitimate files or encourage unrestricted filesystem access. A Session also needs one deterministic base for relative paths and shell commands.

## Decision

Introduce Project as the durable owner of one or more Workspace Roots. Every Project has exactly one Primary Root; remaining roots are attached. New durable Sessions reference a Project, and its Primary Root is the default working directory injected into model context.

`ProjectCatalog` resolves every selected directory to its real absolute path, rejects non-directories, and removes duplicates before persistence. MySQL also enforces unique roots and at most one Primary Root per Project. Project creation inserts the Project and every root in one transaction, which guarantees at least one Primary Root for committed Projects.

## Alternatives Considered

### Store a working directory directly on Session

This handles one folder but duplicates workspace configuration across conversations and does not represent multi-root projects.

### Let every tool accept arbitrary absolute paths

This removes project setup but provides no durable authorization scope. Prompt instructions alone are not an enforcement mechanism.

### Use the process current directory implicitly

This is convenient for a one-repository CLI, but restored Sessions could change behavior depending on where the command was launched.

## Consequences

- Project configuration can be reused by multiple Sessions.
- Relative paths have one stable base even when a Project contains several roots.
- Future filesystem and shell tools must enforce the Project roots; the current model instruction communicates scope but does not yet provide that security enforcement.
- Changing roots and moving the Primary Root require explicit Project management commands that are not included in the first version.
