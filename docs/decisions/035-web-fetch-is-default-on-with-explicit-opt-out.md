# ADR-035: WebFetch is a default-on observe Tool with an explicit opt-out

## Status

Accepted

## Date

2026-09-26

## Context

The Code Agent can work on Projects entirely offline, but many real tasks reference documentation, changelogs, or error pages that live at an exact URL the user or a prior Tool Result already provides. Without any network Tool the model can only ask the user to paste content, and with unrestricted network access it could reach internal services, cloud metadata endpoints, or loopback addresses from a single prompt-injected link.

The Runtime already distinguishes `observe` Tools (parallel-safe, no side effects) from `execute` Tools. MCP sets the project's opt-in precedent, but its reason is specific: an MCP config can declare local commands that the CLI would execute. WebFetch has no equivalent command surface.

## Decision

Ship a single `WebFetch` Tool **enabled by default** in every CLI process. Operators who need it off have one explicit escape hatch per process: `--no-web-fetch`, or `AGENT_WEB_FETCH=false` in the environment for a machine-wide default. The CLI flag wins over the environment. The setting is process state, not durable configuration; a resumed Session does not inherit it, matching how MCP config and `--full-access` behave.

The Tool is an `observe` Tool with `parallelSafe: true`, so it batches with `Read / Glob / Grep / LSP` in the same Step. Its interface is deliberately one exact URL plus an optional timeout; it is not a search engine and exposes no POST bodies, headers, or cookies. Results report the final URL after redirects, HTTP status, content type, byte counts, and truncation flags, and convert `text/html` to readable text by dropping script/style/non-body blocks and decoding entities. HTTP error statuses return as correctable results.

Safety inverts the Bash model. Bash is withheld in Scoped mode because no OS sandbox exists yet; WebFetch ships on, but the network boundary is enforced inside the Tool, independent of any CLI flag:

- DNS is resolved and validated before connecting, then the validated addresses are pinned into the request's `lookup`, so a hostname cannot be re-resolved to a private address between check and use.
- IPv4 private/loopback/link-local/shared-space ranges, IPv6 ULA, link-local, `::`, and IPv4-mapped addresses, `localhost` variants, and metadata service hostnames are refused, both as URL literals and as DNS answers.
- Credentials in the URL, fragments, non-default ports, more than 5 redirects, and redirect cycles are rejected.

The Project System Message gains WebFetch guidance only while the Tool is exposed, telling the model to fetch known URLs rather than inventing ones.

`allowPrivateAddresses` exists only as a construction option for the Tool's own tests against a loopback server; production wiring never sets it.

## Alternatives Considered

### Keep WebFetch behind an explicit opt-in flag

Symmetric with MCP, but the two capabilities are not symmetric: MCP executes local commands, while WebFetch performs read-only GETs to public addresses with private networks already refused. Default-off meant most users never discovered the Tool and kept pasting page text by hand, while the actual risk surface (SSRF to private targets) is blocked regardless of the flag.

### Gate WebFetch behind full access

Full access is about filesystem reach; they are different risk domains. A Scoped-mode session on documentation fixes is a legitimate read-only workflow, and the Tool already refuses private targets regardless of access mode.

### Reuse a headless browser

A browser executes page scripts and needs process sandboxing; that is a much larger, riskier surface for returning page text, and it would be an `execute`-class capability.

### Perform TOCTOU-free validation with a connect hook

Pinning validated DNS answers into the request `lookup` achieves the same guarantee with the standard Node API surface and no additional dependency.
