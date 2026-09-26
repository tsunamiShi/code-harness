# ADR-032: Global CLI defaults to the current directory

## Status

Accepted

## Date

2026-09-26

## Context

The chat CLI was only exposed through `pnpm chat` inside the repository. Its `--env-file=.env`
argument also resolved configuration from the process working directory, so invoking the same
entrypoint elsewhere would lose the ai-agent configuration. Starting a chat additionally required a
previously created Project ID even when the intended Primary Root was simply the current directory.

The process working directory must remain the user's target directory. Changing it to the ai-agent
repository would make a global command start against the wrong project, while loading `.env` from
the target repository would couple unrelated projects to ai-agent's provider and database secrets.

## Decision

Expose `bin/ai-agent.mjs` through the package `bin` field. The launcher locates its own package root,
loads ai-agent's `.env` from there, keeps the caller's working directory unchanged, and dispatches to
the TypeScript chat or Project entrypoint through the repository's `tsx` runtime loader.

Running `ai-agent` without `--project` or `--session` resolves the caller's current directory to its
canonical real path. `ProjectCatalog` reuses a persisted Project whose Primary Root matches that path,
or creates one named after the directory on first use. Explicit Project IDs, Session IDs, access mode,
and MCP configuration remain available. Project administration is namespaced under
`ai-agent project`.

The launcher also owns help routing before configuration or Runtime startup. `ai-agent help` lists
the complete command surface, while nested topics such as `ai-agent help project create` and the
equivalent `ai-agent project create --help` show command-specific arguments without connecting to
MySQL.

## Alternatives Considered

### Change the process working directory to the ai-agent repository

This would make the existing relative `.env` lookup work, but it would violate the meaning of
starting the command inside a target directory and make shell-relative behavior surprising.

### Require a Project ID for every global invocation

This preserves the previous domain flow but does not provide the expected directory-oriented CLI
experience. A canonical Primary Root already provides a stable local lookup key.

### Build and publish compiled JavaScript

A compiled distribution is appropriate for publishing to npm, but the current CLI is linked from a
local repository and already executes source through `tsx`. Reusing that loader avoids adding a
build artifact lifecycle for this local command.

## Consequences

- `ai-agent` can be invoked from any directory while configuration still comes from this repository.
- First use of a canonical directory creates one persistent Project; later uses reuse it.
- Symlinked paths resolve to the same Project as their real path.
- Explicit `ai-agent --project` and `ai-agent --session` commands remain deterministic.
- Help output is available without a valid `.env` or database connection.
- Concurrent first launches for the same previously unseen directory can still create duplicate
  Projects because Primary Root uniqueness is not enforced across Projects.
