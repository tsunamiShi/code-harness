# ADR-014: Reuse language servers within the CLI process

## Status

Accepted

## Date

2026-09-18

## Context

The LSP Tool originally started and stopped a Language Server for every query. A TypeScript query launched one Node child process. A Vue query launched both Vue Language Server and a Vue-enabled tsserver. Repeated Definition, References, and Hover calls therefore paid process startup, initialization, project discovery, and indexing costs every time.

A reusable client must also handle file changes, concurrent protocol requests, child-process failure, multiple Workspace Roots, and CLI shutdown. A process-global cache without ownership would improve warm-query latency but leak child processes and make tests depend on hidden state.

## Decision

One LSP Tool owns a bounded pool of reusable language clients for the lifetime of the CLI process. The pool key combines the canonical Workspace Root path and language Provider. It retains at most four clients and closes the least recently used client before admitting another.

Each client initializes its Language Server once and serializes its requests. Before every query, it reads the file through the existing Workspace Tool checks and sends `didOpen` for a new document or `didChange` when its content has changed. The Vue adapter synchronizes the same content with its Vue-enabled tsserver.

`Tool` has an optional asynchronous `close()` lifecycle method. The chat CLI closes every Tool before closing storage. LSP tests close their Tool explicitly. If a language process exits unexpectedly, the pool discards the unhealthy client, creates a replacement, and retries the read-only query once.

## Alternatives Considered

### Start a language process for every Tool Call

This has simple ownership and always observes fresh files, but repeated process startup and project indexing dominate interactive query latency.

### Keep an unbounded process-global cache

This avoids changing Tool lifecycle, but clients outlive their Project and Session ownership, tests leak processes, and Full Access queries can retain an unbounded number of roots.

### Run one language process for every Project regardless of language

TypeScript Language Server and Vue Language Server are distinct protocols and process topologies. Combining them behind one process key would hide incompatible initialization and failure behavior.

### Persist language processes across CLI restarts

An external daemon could remove first-query cold starts, but it requires discovery, version negotiation, stale-workspace cleanup, and authorization beyond the current single-process CLI architecture.

## Consequences

- Consecutive queries for the same Root and Provider reuse initialized processes and project indexes.
- File edits are visible without restarting the server.
- Requests to one client are serialized; different retained clients may operate independently.
- At most four client groups are retained, bounding Full Access and multi-root process growth.
- The first query for a Root and Provider still pays cold-start cost.
- Vue retains two child processes while warm because its current architecture combines Vue Language Server with a Vue-enabled tsserver.
- Adding a daemon or idle-time eviction remains a later optimization if CLI startup or long idle sessions become material.
