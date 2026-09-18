# ADR-011: Write creates new Project files without overwriting

## Status

Accepted

## Date

2026-09-18

## Context

Edit can change an existing file but cannot create a new test, configuration file, or source module. Treating file creation as an Edit special case would make an empty or missing match carry unrelated meanings. Letting Write replace existing files would also allow a stale complete-file response to erase changes made after the model last read the target.

Full filesystem access is an explicit launch-time decision to trust the Agent with local files. Write must preserve exclusive creation and path checks while honoring that selected Root authority.

## Decision

Add a `Write` Tool that creates one new UTF-8 file from a relative path and complete string content. Its parent directory must already exist. Write does not create directories and fails if any file, directory, or symbolic link already occupies the target path; modifying an existing text file remains Edit's responsibility.

Write accepts the Project's Primary and Attached Roots in scoped mode. With `--full-access`, it can select any existing absolute local directory as its Root. It rejects parent traversal and canonical parent paths outside the selected Root. Content may be empty and is limited to 64,000 characters.

Write first completes a uniquely named temporary file in the target directory, then creates the target as a hard link with exclusive filesystem semantics and removes the temporary name. The published target is therefore complete, and a concurrent creator wins without being overwritten. Its result contains the relative path, character and UTF-8 byte counts, and SHA-256 instead of echoing the content.

Write is not parallel-safe. Tool Call batches containing it execute serially because separate calls can target the same path or interact with later mutations.

## Alternatives Considered

### Let Write overwrite files

This matches a familiar file API but duplicates Edit's responsibility and can silently discard changes based on stale model context.

### Make Edit create files when oldText is empty

An empty match exists at many positions in every string. Giving it a separate create meaning makes validation and model recovery ambiguous.

### Create missing parent directories automatically

One Tool Call would then mutate an unbounded number of paths and require partial-failure semantics. Directory creation can be introduced as an explicit capability when a concrete task requires it.

### Use Bash for creation

Shell redirection makes quoting, exclusive creation, path authorization, and structured results depend on each generated command.

## Consequences

- The Agent can add source files, tests, and configuration under an authorized Workspace Root.
- Existing paths and symbolic links are never overwritten; the model must use Edit or choose another path.
- Missing parent directories fail visibly instead of creating an implicit directory tree.
- A successful result is compact and can be checked later with Read or its SHA-256.
- The hard-link publication strategy assumes the temporary file and target share a filesystem, which is guaranteed by placing them in the same directory.
- Interactive approval, directory creation, file deletion, and multi-file transactions remain future capabilities.
