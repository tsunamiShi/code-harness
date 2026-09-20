# ADR-004: Project-scoped Read, Glob, and Grep provide filesystem perception

## Status

Accepted

The model-facing Root selector and relative-path rules are replaced by [ADR-016](016-code-tools-expose-absolute-paths.md).

## Date

2026-09-17

## Context

A Code Agent must locate candidate files, search their contents, and inspect exact context before it can plan changes. Exposing every filesystem operation as a separate Tool would increase model choice ambiguity, while relying only on Shell would mix basic read-only exploration with arbitrary process execution.

Multi-root Projects also require executable path authorization. The Project instructions tell the model which directories are allowed, but prompt text cannot prevent a malformed Tool Call, parent traversal, or symbolic-link escape.

## Decision

Expose exactly three model-visible filesystem perception Tools:

- `Glob` locates files by relative path pattern.
- `Grep` locates matching lines by regular expression.
- `Read` returns an exact bounded line range from one text file.

`createFilesystemTools(project)` binds all three Tools to one durable Project. Every Tool defaults to the Primary Root and can select an Attached Root by its exact Project path. Tool paths and glob patterns must be relative. The shared Project Filesystem implementation resolves existing paths to real paths and rejects results outside the selected root, including symbolic-link escapes.

Results use bounded JSON objects rather than unstructured terminal output. `Read` limits lines and characters, `Glob` limits candidates and returned files, and `Grep` limits matching lines and execution time. `Glob` uses the Node filesystem implementation. `Grep` runs the project-pinned ripgrep binary because its regular-expression engine, ignore handling, binary detection, and separate process are safer than evaluating model-provided JavaScript regular expressions in the Agent process.

Tool execution errors are logged and returned to the model as Tool Messages. The Turn continues so the model can correct an invalid path, pattern, or argument. Restored model history includes these error results.

## Alternatives Considered

### Add `list_files`, `search_text`, and `read_file`

These names duplicate the established `Glob`, `Grep`, and `Read` semantics. `Glob("**/*")` already covers file listing, so a separate listing Tool would create overlapping choices.

### Expose only Shell

Shell can invoke `rg`, `find`, and text readers, but it grants process execution for read-only exploration, produces platform-dependent output, and makes Project path enforcement dependent on every generated command.

### Expose one `Explore` Tool

A single Tool could choose between listing, searching, and reading internally, but that would hide the model's action, complicate result types, and make permissions and telemetry less precise.

### Search with JavaScript regular expressions

This avoids a binary dependency but evaluates model-provided expressions in the long-lived Agent process without an execution timeout. A pathological expression could block the complete Session runtime.

## Consequences

- The CLI exposes three orthogonal read-only Tools rather than the previous demonstration time Tool.
- Primary and Attached Roots share one Tool set; adding a root does not add model-visible Tools.
- `.git`, `node_modules`, and `dist` are excluded from broad `Glob` and `Grep` operations to bound common searches. `Read` can still inspect a specifically requested authorized file.
- Tool output explicitly reports truncation or a reached result limit, so the model can narrow a query.
- Filesystem mutation, Shell execution, notebook editing, and language-server semantics remain separate future capabilities.
