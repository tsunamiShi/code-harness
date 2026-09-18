# ADR-009: Source layout follows runtime roles

## Status

Accepted

## Date

2026-09-17

## Context

The first implementation kept every source file directly under `src/`. As the Agent gained Projects, storage, Filesystem Tools, CLI parsing, and terminal traces, unrelated responsibilities became visually indistinguishable. File names did not communicate which code belonged to the reusable Runtime and which code adapted an external system.

The model Adapter was named `QwenModel`, although it uses the OpenAI-compatible Chat Completions protocol and the current deployment runs `glm-5.3` through Alibaba Model Studio. The class name described an earlier model choice instead of its stable interface and protocol.

## Decision

Group source files by runtime role:

- `runtime/` owns the Agent Loop, core Model and Tool types, and the `SessionStore` interface used by the loop.
- `models/` contains Model adapters.
- `tools/` contains Tool implementations.
- `projects/` owns Project and Project Root behavior.
- `storage/` contains persistence adapters.
- `cli/` contains process entry points, argument parsing, environment configuration, and terminal presentation.

Tests mirror these directories so a behavior test is adjacent in concept without mixing production and test files.

Rename `QwenModel` to `OpenAICompatibleChatModel` and `qwen-model.ts` to `models/openai-compatible-chat-model.ts`. Provider error messages are also brand-neutral. DashScope environment variable names remain because they identify the configured gateway and credentials, not the Model implementation.

Use direct file imports. Do not add directory barrel files until a real external consumer needs a smaller public import surface.

## Alternatives Considered

### Keep a flat source directory

This minimizes relative path depth, but discovery cost grows with every capability and filenames alone cannot show Runtime versus Adapter ownership.

### Name the Adapter after the configured GLM model

This would repeat the same problem when the deployment changes models. The stable fact is the wire protocol, not the selected model ID.

### Create one directory for every domain term

Directories containing one shallow forwarding file add navigation without hiding complexity. The selected groups already have distinct responsibilities or multiple implementations.

### Add barrel exports for every directory

Barrels would create another public surface to maintain without an external package consumer. Direct imports keep dependencies explicit at the current project size.

## Consequences

- The top-level source tree communicates where execution, external adapters, Tools, persistence, Projects, and CLI behavior live.
- Switching between compatible Qwen and GLM models changes configuration rather than TypeScript class names.
- Imports become longer but expose dependency direction.
- Future Edit or Bash Tools belong under `tools/`; a provider using another wire protocol belongs under `models/`.
