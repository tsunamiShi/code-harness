# ADR-039: Rename the product to Code Harness

## Status

Accepted

## Date

2026-09-28

## Context

The `ai-agent` name described a broad category rather than this project's actual responsibility.
The project now provides a durable harness for coding agents: it coordinates model invocations,
tools, filesystem authorization, Projects, Sessions, Turns, persistence, recovery, context
management, and loop policies. The old name neither identified the coding domain nor distinguished
the Runtime and orchestration layer from a generic AI agent demo.

The name is also part of the public local interface through the package name, global CLI command,
launcher filename, help output, protocol client metadata, and repository URL. Renaming only the
repository would leave a split identity throughout the installation and documentation.

## Decision

Rename the product, package, repository, launcher, and CLI command from `ai-agent` to
`code-harness`. Do not retain an `ai-agent` command alias: the project is local and unpublished, so
one complete migration is clearer than an indefinite compatibility surface.

Keep the internal domain vocabulary (`Agent`, `AgentSession`, `Project`, `Turn`, `Step`, and Runtime)
because those terms describe concepts rather than the product brand. New installations use
`code_harness` as the default MySQL database name. Existing installations can continue using an
explicit `MYSQL_DATABASE=ai_agent`, preserving all persisted Sessions without a database copy or
destructive migration.

This decision supersedes only the `ai-agent` package, launcher, and command names recorded in
ADR-032. Its directory-oriented launcher behavior and configuration-loading decision remain in
force. Historical ADR text is not rewritten.

## Alternatives Considered

### Keep `ai-agent`

This avoids a breaking command rename, but the name is too broad and no longer communicates that
the project is specifically the execution harness for coding agents.

### Use `code-agent-harness`

This is maximally explicit, but the extra word makes the repository, package, and frequently typed
CLI command unnecessarily long.

### Use `code-agent-runtime`

This accurately describes the core execution module, but underrepresents the surrounding CLI,
tool catalog, persistence, recovery, authorization, and policy orchestration.

## Consequences

- The public command becomes `code-harness`; existing `ai-agent` shell links must be replaced.
- The repository directory and Git remote use `code-harness`.
- Help text, documentation, tests, temporary-file prefixes, and protocol client metadata use the
  new identity.
- Existing databases remain usable through explicit configuration, while new setup instructions
  and defaults use `code_harness`.
- Historical ADRs retain the old name as a record of the interface that existed when they were
  accepted.
