# ADR-016: Code Tools expose absolute paths

## Status

Accepted

## Date

2026-09-20

## Context

The initial Filesystem and LSP Tool interfaces represented one location as a model-selected Project Root plus a relative path. This preserved a visible authorization scope, but required the model to keep two values consistent across Glob, Grep, Read, LSP, Edit, Write, and Bash calls. Long tasks could reuse a relative result with the wrong Root, omit an Attached Root selection, or lose the implicit Primary Root context.

Authorization does not require the model to express the authorization scope. The Runtime already owns Project membership, access mode, canonical-path resolution, and symbolic-link checks.

## Decision

All model-visible Code Tool resource paths are absolute:

- Read, Edit, Write, and LSP require an absolute file `path`.
- Glob requires an absolute directory `path`; its `pattern` remains a relative glob expression below that directory.
- Grep requires an absolute file or directory `path`; its optional `glob` remains a relative file filter.
- Bash requires an absolute `cwd`.
- Glob, Grep, Read, Edit, Write, LSP, and Bash return absolute resource paths or working directories.

The model-visible `root` selector is removed. The Runtime canonicalizes each path and determines whether it belongs to a Primary or Attached Root. Scoped mode rejects canonical paths outside every Project Root. Full Access accepts any absolute path allowed by the host process. Existing-path checks follow symbolic links before authorization; Write authorizes the canonical parent directory before creating a new target.

LSP derives its process Root from the deepest Project Root containing the target file. For a Full Access file outside the Project, the Runtime walks upward for the nearest `tsconfig.json`, `jsconfig.json`, `package.json`, or `.git` marker and falls back to the containing directory. This Root remains an implementation detail and is not part of the Tool interface.

Project instructions list absolute Project Roots as exploration starting points and require the model to reuse exact absolute paths returned by Tools.

This decision replaces the model-facing relative-path and Root-selection clauses in ADR-004, ADR-012, and ADR-013. Their Tool selection and access-mode decisions remain accepted.

## Alternatives Considered

### Keep Root plus relative path

This makes authorization scope visible but requires every call to maintain a two-part location. The duplicated context is a source of model drift and prevents direct path transfer between Tools.

### Accept both absolute and relative paths

This eases migration but leaves two valid representations, preserves implicit Primary Root behavior, and forces every Tool description and test to define precedence. The project has one active caller, so a direct interface replacement is simpler.

### Use opaque Root identifiers plus relative paths

Stable identifiers avoid exposing local Root paths, but the model must still maintain two values and translate Tool results before reuse. This does not address the observed path drift.

## Consequences

- A path returned by Glob, Grep, or LSP can be copied directly into Read, LSP, Edit, or Bash without Root reconstruction.
- Multi-root authorization moves entirely behind the Runtime seam and no longer changes Tool schemas.
- Tool calls contain longer strings and persisted transcripts remain machine-specific.
- Moving a Project directory invalidates absolute paths in old model context; durable Project identity does not make filesystem locations portable.
- Runtime authorization tests must cover relative-path rejection, outside-Project paths, symbolic-link targets, Attached Roots, and Full Access.
