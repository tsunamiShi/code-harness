# ADR-031: Context checkpoints bound model-visible history

## Status

Accepted

## Date

2026-09-26

## Context

The Runtime keeps the complete durable execution history in Sessions, Turns, Steps, Tool Calls,
Model Invocations, and Provider Attempts. `projectModelState()` currently projects every completed
Turn plus recoverable work from the final unfinished Turn into model-visible Messages.

ADR-022 and ADR-024 avoid repeatedly uploading that projection by continuing a Responses chain
with `previous_response_id`. ADR-029 deliberately falls back to the complete durable projection
when the Provider confirms that continuation state is unavailable. That fallback preserves
recoverability, but a sufficiently long Session can no longer fit into the model context window.
Provider continuation also reduces request transfer; it does not reduce the logical context carried
by the Provider.

Context reduction must not delete or rewrite durable execution facts. Those rows remain necessary
for transcript display, Tool side-effect recovery, diagnostics, evaluation, and audit. It must also
survive process restart and Provider continuation loss. Replacing only the in-memory `messages`
array would therefore be insufficient.

The first implementation targets the existing OpenAI-compatible Responses adapter backed by
Alibaba Model Studio. No verified Provider-native compaction contract is currently available for
that adapter, so the initial strategy must be a provider-neutral summarizing checkpoint rather than
an opaque Provider compaction item.

## Decision

Introduce a Session-scoped `ContextCheckpoint`. A checkpoint is an immutable, durable replacement
for a prefix of model-visible history. It is a derived projection checkpoint, not an execution
record and not a substitute for the underlying Turns and Steps.

The Runtime will place a `ContextManager` module at the seam between durable Session state and a
Model Invocation. Its interface prepares the context for one invocation; threshold calculation,
summary generation, checkpoint installation, projection, and continuation reset remain inside its
implementation.

Conceptually, the interface is:

```ts
interface ContextManager {
  prepareForInvocation(input: {
    sessionId: string
    turnId: string
    step: number
    state: ProjectedModelState
    projectSystemMessage?: Message
    tools: readonly ToolDescription[]
  }): Promise<ProjectedModelState>
}
```

`AgentSession` continues to consume only `ProjectedModelState.messages` and its optional Provider
continuation. It does not query checkpoint tables or interpret checkpoint cursors.

### Durable history and model context remain separate

Compaction changes only the model-visible projection:

```text
durable Session history
    = every Turn + Step + Tool Call + Reminder + invocation record

model-visible history
    = latest checkpoint replacement Messages
    + durable model-visible records after the checkpoint cursor
```

The CLI transcript, diagnostics, recovery of interrupted Tool Calls, Loop Guard evidence, and Tool
Registry restoration continue to use the complete durable history. They must not be rebuilt from
the compacted Messages. In particular, `ToolRegistry.restore()` must be given the uncompressed
durable projection or an equivalent durable registry snapshot; compaction may omit old Tool Search
messages without revoking tools already discovered by the Runtime.

### Safe cursor

A checkpoint covers history through one completed Step. `covered_through_step_id` means:

- the Step and all of its Tool Calls have reached durable terminal states;
- Tool Results and Loop Guard Reminders emitted at that Step are included in the checkpoint source;
- no model-visible record at or before that safe point needs to be projected again.

Compaction runs only between completed Steps and before the next Model Invocation. It never runs
while Tool Calls are executing. If a new Turn prompt has already been recorded but has no Step, the
checkpoint continues to cover the previous completed Step and the new prompt remains in the tail.
The summary request contains only the durable prefix through the captured cursor; it never absorbs
that later tail. Candidate-size validation uses the complete result: replacement Messages plus the
unchanged tail and current Tool schemas.

The MySQL adapter resolves the cursor with the Step's Turn and projects the tail in deterministic
`turn_number`, `step_number`, Tool Call index, and Reminder order. Callers do not traverse
checkpoint-to-Step-to-Turn relationships themselves.

### Schema version 11

Add an immutable checkpoint table:

```sql
CREATE TABLE agent_context_checkpoints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  checkpoint_number INT UNSIGNED NOT NULL,
  covered_through_step_id BIGINT UNSIGNED NOT NULL,
  trigger_kind VARCHAR(16) NOT NULL,
  reason_kind VARCHAR(32) NOT NULL,
  strategy VARCHAR(32) NOT NULL,
  payload_version INT UNSIGNED NOT NULL,
  replacement_context JSON NOT NULL,
  source_invocation_id BIGINT UNSIGNED NULL,
  estimated_tokens_before BIGINT UNSIGNED NULL,
  estimated_tokens_after BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_agent_context_checkpoints_session_number
    (session_id, checkpoint_number),
  KEY idx_agent_context_checkpoints_session_cursor
    (session_id, covered_through_step_id),
  CONSTRAINT fk_agent_context_checkpoints_session FOREIGN KEY (session_id)
    REFERENCES agent_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_context_checkpoints_step FOREIGN KEY (covered_through_step_id)
    REFERENCES agent_steps (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_context_checkpoints_invocation FOREIGN KEY (source_invocation_id)
    REFERENCES agent_model_invocations (id) ON DELETE SET NULL,
  CONSTRAINT chk_agent_context_checkpoints_trigger
    CHECK (trigger_kind IN ('automatic', 'manual')),
  CONSTRAINT chk_agent_context_checkpoints_reason
    CHECK (reason_kind IN ('token-limit', 'user-requested', 'model-change')),
  CONSTRAINT chk_agent_context_checkpoints_strategy
    CHECK (strategy IN ('summary'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Only successfully installed checkpoints are stored. There is no `running` checkpoint row. Failed
summary requests remain observable as failed Model Invocations and Provider Attempts, while the
previous context stays authoritative.

Extend `agent_model_invocations` with:

```sql
ALTER TABLE agent_model_invocations
  ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'agent'
    AFTER invocation_number,
  ADD COLUMN provider_response_id VARCHAR(255) NULL
    AFTER provider_request_id,
  ADD CONSTRAINT chk_agent_model_invocations_purpose
    CHECK (purpose IN ('agent', 'compaction'));
```

A summarization request is a normal observed Model Invocation with `purpose = 'compaction'`, empty
Tools, no `previous_response_id`, and its own Provider Attempts. Its Provider Response ID is retained
for diagnosis only and is never adopted as the next agent continuation.

The Runtime uses the same internal observed-invocation implementation for agent and compaction
requests; `purpose` is an input to that implementation rather than a second telemetry path. When a
checkpoint is installed, the storage adapter resolves the just-completed compaction invocation for
the supplied Turn and Step and records its database ID as `source_invocation_id`. The field may
become null only if invocation retention is introduced later and removes that diagnostic record.

An automatic compaction immediately before an Agent Step uses that active Turn and Step for its
invocation coordinates. A manual `/compact` between Turns attaches its maintenance invocation to
the covered Step's Turn and step number. Storage permits `purpose = 'compaction'` on that completed
Turn without reopening it or creating an Agent Step; ordinary `purpose = 'agent'` invocations still
require a running Turn.

`replacement_context` is a versioned tagged payload. Version 1 is:

```ts
interface SummaryCheckpointPayloadV1 {
  version: 1
  kind: 'summary'
  messages: readonly Message[]
}
```

The MySQL adapter validates the JSON shape when loading it. The payload does not contain Project
System instructions; current Project instructions are regenerated whenever a new Provider chain is
bootstrapped.

### Summary replacement shape

The summary request uses the current Project System Message, the compactable durable Message
prefix, and a final user instruction asking for a concise handoff containing:

- the active user goal and authorization constraints;
- decisions and confirmed facts;
- completed mutations and their validation evidence;
- unresolved work and the next concrete action;
- exact paths, identifiers, errors, and commands still needed;
- Tool side effects whose outcome is unknown.

The request has no Tools. It must return one final text result; Tool Calls, an incomplete response,
an empty summary, or an invocation failure do not install a checkpoint.

The replacement payload contains recent real user messages followed by one contextual user Message
whose content begins with `[Context checkpoint]`. Recent user messages are selected newest-first
within a retention budget of the smaller of 20,000 tokens and 25% of the resolved automatic
compaction limit, then restored to chronological order. A manual compaction without a resolved
automatic limit uses an 8,000-token retention budget. The newest message may be middle-truncated to
the remaining budget, but its existence is preserved. Images and other future non-text content are
not copied by the version 1 payload.

The generated checkpoint summary is always the last replacement Message so the next model sees the
current handoff state after the retained requests.

### Compaction source preprocessing

The durable Tool Result remains unchanged. For the compaction request only, each Tool Result is
limited to approximately 10,000 tokens by retaining its beginning and end with an omission marker.
This bounds one oversized observation without applying terminal preview limits to stored or normal
model-visible results.

If the complete compactable prefix still does not fit the compaction request, the implementation
removes the oldest complete Turn or Step groups until the request fits, never splitting a Tool Call
from its Tool Result. The final summary instruction explicitly tells the model when older durable
source groups were omitted. If no viable source remains, compaction fails without changing the
installed context.

### Automatic and manual triggers

Context preparation estimates the tokens for the current Project System Message, complete local
model projection, and Tool schemas before each Model Invocation. A `TokenEstimator` internal seam
uses a Provider tokenizer when one exists. Its fallback estimates ASCII content at approximately
four bytes per token and non-ASCII Unicode code points at one token each, including serialized
Message and Tool structure. Provider `input_tokens` remain recorded for later calibration, and the
larger of the local estimate and the latest relevant Provider observation drives the threshold.

Configuration is explicit:

- `AGENT_CONTEXT_WINDOW_TOKENS` declares the selected model's context window;
- `AGENT_AUTO_COMPACT_TOKEN_LIMIT` optionally overrides the automatic threshold;
- when only the context window is configured, the threshold is 90% of that value;
- when neither value is configured, automatic compaction is disabled;
- a configured automatic limit must be positive and may not exceed 90% of a configured context
  window.

The CLI adds `/compact` for a manual checkpoint. Manual compaction requires at least one completed
Step after the latest checkpoint and otherwise reports that there is nothing to compact.

Before an automatic compaction, at least one completed Step must exist after the latest checkpoint.
The Runtime will not repeatedly compact the same cursor. After generating a candidate replacement,
it estimates the candidate context before installation. A candidate that does not reduce the
estimated context below the trigger threshold fails with
`ContextCompactionIneffectiveError` and is not installed.

Once the automatic threshold is reached, a compaction failure prevents the pending ordinary Model
Invocation rather than knowingly sending an oversized request. The current Turn follows its normal
failure and recovery path, while the previously installed context remains authoritative. If there
is no completed Step after the latest checkpoint, the Runtime reports
`ContextWindowBudgetExceededError`; another checkpoint over the same cursor cannot help. Manual
failure is reported to the CLI without changing Session or Turn completion state.

### Atomic checkpoint installation

Summary generation must not hold a database transaction open. Installation uses optimistic
validation:

1. Capture the latest completed Step cursor and the latest checkpoint number.
2. Build the compactable source and run the observed compaction Model Invocation outside a database
   transaction.
3. Estimate and validate the replacement payload.
4. Begin a transaction and lock the Session row.
5. Verify that the captured cursor is still the latest safe Step and that no newer checkpoint was
   installed.
6. Insert the next immutable checkpoint row and commit.
7. Only after commit, replace the process-local model state from the durable checkpoint projection.

A stale cursor causes a conflict result; the candidate summary is discarded. The normal serialized
`AgentSession` execution means this should be rare, but the database check prevents two processes
from silently skipping durable work.

Crash behavior is fail-safe:

- before insertion, the old context remains authoritative; Session resume marks any still-running
  compaction invocation and attempt as interrupted so compaction may be retried;
- after insertion but before the in-memory update, resume or immediate reprojection selects the new
  checkpoint;
- original Turns, Steps, Tool Calls, and invocation records are never removed.

### Projection and recovery

`AgentSessionSnapshot` exposes the latest valid checkpoint in addition to complete durable history.
`projectModelState()` behaves as follows:

1. Without a checkpoint, retain the existing full projection behavior.
2. With a checkpoint, start with its replacement Messages.
3. Resolve `covered_through_step_id` to its `turn_number` and `step_number`.
4. Do not repeat the prompt of the checkpoint's Turn.
5. Append later Steps from the same Turn.
6. For each later Turn, append its prompt and then its durable Steps, Tool Results, and Reminders.
7. Derive Provider continuation only from Provider Response IDs after the checkpoint cursor.

For the version 1 summary strategy, installing a checkpoint clears the old in-memory Provider
continuation. The next agent request starts a new Responses chain with exactly one current Project
System Message followed by checkpoint replacement Messages and any tail. Subsequent requests return
to `previous_response_id` plus incremental Messages under ADR-024.

The ordinary response that generated the summary must not become the continuation: its Provider
state still contains the pre-compaction history and would defeat the new context window.

When ADR-029 handles an unavailable continuation after a checkpoint, its bounded replay input is the
latest checkpoint replacement plus the durable tail, not the complete raw Session history.

### Store and Runtime records

The `SessionStore` interface adds one atomic record rather than exposing create/update/finalize
checkpoint methods:

```ts
type SessionRecord =
  | ExistingSessionRecord
  | {
      type: 'context.compacted'
      turnId: string
      step: number
      coveredThroughStepId: string
      trigger: 'automatic' | 'manual'
      reason: 'token-limit' | 'user-requested' | 'model-change'
      payload: SummaryCheckpointPayloadV1
      estimatedTokensBefore?: number
      estimatedTokensAfter?: number
    }
```

The MySQL and in-memory adapters assign `checkpoint_number`, validate the cursor while holding their
Session write lock, resolve the completed `purpose = 'compaction'` Model Invocation for the supplied
Turn and Step, and either install the complete checkpoint or make no change. The existing
`record(sessionId, record)` argument remains the Session identity; it is not duplicated in the
record payload.

Transient Runtime events are emitted for `context.compaction-started`,
`context.compaction-completed`, and `context.compaction-failed`. They are for UI and trace rendering;
the checkpoint row and Model Invocation lifecycle remain the durable authority.

## Alternatives Considered

### Add a summary column to `agent_sessions` or `agent_turns`

A Session column has no safe source cursor or versioned replacement shape. A Turn column cannot
represent compaction across Turns or in the middle of a long Turn. Both make incremental projection
and stale-write detection ambiguous.

### Rewrite or delete old Turns and Steps

This makes the compacted projection the only history, destroying audit, diagnostics, transcript,
Tool side-effect recovery, and future re-compaction from original evidence.

### Store only summary text

Summary text alone cannot reproduce retained recent user messages, represent future opaque Provider
items, or establish the canonical next model input. A bounded, versioned replacement payload keeps
checkpoint installation and recovery deterministic.

### Treat compaction as an Agent Step

An Agent Step represents progress returned by the primary agent: a final answer or Tool Calls.
Compaction maintains the model context projection and should not change the user-visible Step count,
Loop Guard progress, or task completion semantics.

### Depend only on `previous_response_id`

Provider continuation saves transfer and local serialization but retains the prior logical context.
It also expires. It cannot bound context size or provide durable replay after Provider state loss.

### Implement Provider-native compaction first

An opaque Provider checkpoint can retain richer reasoning state, but Alibaba Model Studio support
has not been verified. Introducing it first would couple the provider-neutral Runtime to an assumed
protocol. A future ADR may add a second tagged payload strategy after a real adapter and integration
test exist.

### Introduce a separate Message event table

A monotonic Message ledger would provide a precise generic cursor, but duplicates the established
Turn/Step/Tool Call model and expands this change substantially. The completed-Step cursor is
sufficient because compaction is restricted to safe points. A Message ledger can be reconsidered if
model-visible events are later allowed outside those ordering invariants.

## Consequences

- Long Sessions gain a durable upper bound on model-visible history while keeping complete execution
  records.
- Session resume and continuation-loss replay use the same checkpoint-aware projection.
- A compaction requires an additional observed Model Invocation and can fail independently without
  corrupting the active context.
- Local summary compaction is semantically lossy; repeated checkpoints may omit details even when
  token size is controlled.
- Project instructions are refreshed when compaction starts the new Provider chain.
- The Runtime must separate Tool Registry and recovery state from compacted model Messages.
- MySQL schema version 11 adds one table and two Model Invocation columns.
- Automatic compaction remains disabled until the model context window or explicit threshold is
  configured.
- Provider-native compaction, multimodal retention, checkpoint rollback, branching Sessions, and
  deletion of old execution rows remain outside this decision.

## Verification Plan

The implementation is complete only when all of the following are verified:

1. Unit tests show full projection without a checkpoint and `replacement + tail` projection with a
   checkpoint, including a checkpoint in the middle of a Turn.
2. Projection does not duplicate the checkpoint Turn prompt, Tool Results, or Reminders.
3. Resume after process restart selects the same Messages and continuation as the live Session.
4. Installing a summary checkpoint clears the pre-compaction continuation and the next request
   contains exactly one current Project System Message.
5. A Provider continuation-loss replay sends checkpoint replacement plus tail rather than raw full
   history.
6. Tool Registry restoration and interrupted Tool recovery still use complete durable history.
7. Concurrent or stale checkpoint installation is rejected without changing the active projection.
8. Failed, empty, incomplete, tool-calling, or ineffective summary responses install no checkpoint.
9. A crash before checkpoint insertion preserves the old projection; a crash after insertion
   restores the new projection.
10. The compaction Model Invocation and every Provider Attempt retain their purpose, timing, token
    usage, response IDs, and failure details.
11. MySQL migration tests cover upgrade from schema version 10 and a fresh schema, while the
    in-memory adapter passes the same SessionStore contract tests.
12. A long synthetic Session crosses the configured threshold, compacts, continues through Tool
    Calls, completes, and resumes successfully without exceeding the configured context budget.
