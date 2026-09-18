# ADR-013: Unsandboxed Bash requires full access

## Status

Accepted

## Date

2026-09-18

## Context

The Agent needs command execution for tests, builds, Git inspection, and operations that do not justify a dedicated structured Tool. A Bash process, however, inherits the CLI process's filesystem, network, credential, and process authority. Setting its current working directory to a Project Root does not prevent a command from using absolute paths, changing directories, or starting child processes.

Presenting Bash in Scoped mode would therefore claim a restriction that the Runtime cannot enforce. Implementing a correct scoped shell requires an operating-system sandbox and process-tree policy, not additional prompt instructions or string checks.

## Decision

Expose Bash only when the CLI starts with `--full-access`. Scoped sessions do not include Bash in the model-visible Tool list.

Bash runs `/bin/bash -lc` in the selected Root or a validated relative subdirectory. It applies a configurable per-call timeout, terminates the spawned process group on timeout, and bounds captured stdout and stderr. Non-zero exits and timeouts are structured Tool Results rather than Runtime failures so the model can inspect and correct a command.

Bash is not parallel-safe. Its commands may mutate shared files or process state, so a Tool Call Batch containing Bash executes serially.

## Alternatives Considered

### Treat cwd as the sandbox

The working directory only controls relative path resolution. It does not constrain absolute paths, shell built-ins, subprocesses, network access, or inherited credentials.

### Filter dangerous command strings

Shell syntax has too many equivalent forms, expansions, interpreters, and indirect execution paths for a denylist to provide a security guarantee.

### Omit Bash permanently

Dedicated Tools provide stronger interfaces, but implementing one for every build system, test runner, Git query, and repository script would create tool explosion and still leave common workflows unsupported.

## Consequences

- Full Access sessions can run builds, tests, Git commands, and repository scripts.
- Scoped sessions remain honest about their enforcement and cannot invoke Bash.
- A timeout covers the spawned process group, while output limits protect model context from unbounded command output.
- Full Access currently means trusting model-directed commands with the host process's authority.
- Adding Bash to Scoped mode requires an OS sandbox; adding destructive or external actions should also revisit Approval Policy.
