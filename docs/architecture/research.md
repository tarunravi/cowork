# Cowork architecture research

Updated: 2026-10-20

This is a source-based inventory of the current OpenBot foundation and the parts of the proposed cowork runtime it already supports. It is not a claim that background agent execution is durable end to end.

## Current foundation

| Layer | Existing code | What it provides | Boundary |
|---|---|---|---|
| Product UI | `app/` | Existing React application and conversation experience to extend. | Product changes need browser-level review; no UI implementation is included in this research pass. |
| Harnesses | `agent-*/`, `shared/harnesses.*` | Separate agent processes connected through AG-UI; a central registry describes harnesses. | Each adapter can only promise its actual capabilities. The Codex adapter currently exposes text output, not computer control or durable delegation. |
| Server and tools | `server/src/`, `toolkit/src/` | Agent dispatch, tools, permissions, channel handling, and thread coordination. | A live agent request is not itself a durable resumable run. |
| Persistent work queue | `server/src/work/queue.ts`, `server/src/db/schema/work.ts`, `server/src/work/loop.ts` | PostgreSQL work items with idempotency keys, leased claims/renewal, retries, attempt limits, and multi-replica-safe claiming. Server-side loops claim queue kinds; `worker/src/` runs the local routine scheduler and dispatches routine work to the server. | The queue stores dispatchable work, not the conversation transcript or a general run graph. A retry after an external side effect can repeat that effect unless the tool is idempotent. |
| Per-thread concurrency | `toolkit/src/ports.ts`, `toolkit/src/run-turn.ts`, `toolkit/src/lease.ts` | Headless turns take and renew the CopilotKit Intelligence thread lock before streaming. The lock is a platform resource backed by Redis, shared across server replicas. | This is not a PostgreSQL lease and it does not persist provider protocol state. |
| Existing run records | `server/src/db/schema/coworker.ts`, `server/src/db/schema/responsibilities.ts` | `routine_runs` and `responsibility_runs` persist lifecycle, waiting/continuation data, outcomes, and timestamps for their respective work types. | They are purpose-specific records, not a unified parent/child run graph. Reuse their patterns before adding another generic table. |
| Bot handoffs | `server/src/agents/handoff.ts`, `handoff-runner.ts`, `handoff-delivery.ts`, `server/src/work/queue.ts` | Bot-to-Bot work is already enqueued as durable `bot.message` work, claimed with a renewable lease, delivered through the platform runner, and recorded in audit events. The Intelligence thread holds the visible transcript. | The queue and audit trail do not yet provide a unified run graph or exactly-once side effects. Handoff retries can repeat a turn after a worker dies between delivery and queue settlement. |
| Approvals | `server/src/approvals/`, `server/src/approvals/resume-sweep.ts` | Persisted approval/question state and continuation data; decided approvals are resumed through durable `approval.resume` work. | Expiry and the complete crash/retry behavior still need targeted verification; restart resumption is already implemented. |
| Local fallback | `server/src/config.ts`, `server/src/copilot.ts` | A truthful local development path when the CopilotKit runtime integration is not configured. | It uses an in-process runner; state is not crash-recoverable, and scheduled surfaces such as routines, handoffs, and responsibilities fail fast without Intelligence. It does not meet the persistent background-work goal. |
| Computer use | `agent-computer/` | Existing computer-control provider and related tests. | The Codex adapter does not currently bind these computer tools into its own session. Provider capabilities and permissions need explicit mapping. |

## Requirements for a real cowork run

For the target product, PostgreSQL should own accepted work identity, lifecycle, attempts, parent/child relationships, cancellation, and recovery state. OpenBot already writes headless turns to the CopilotKit Intelligence thread, which is the transcript the UI reads, and holds the corresponding cross-replica thread lock there. Keep that transcript integration for the first slice; do not mirror every AG-UI event into a second event store without a concrete query or recovery need. The local in-memory fallback has neither durable history nor background work, so it cannot satisfy the persistence promise.

The existing PostgreSQL queue and database should be reused for dispatch. Add run-specific tables or projections only for lifecycle and relationships that the queue and existing purpose-specific run records do not represent. Keep transcript events in the existing Intelligence thread unless the project deliberately replaces that storage boundary. Do not make the queue payload a second event store.

Use the existing app-owned `bot.message` handoff as the base for cross-provider delegation and generalize it if needed; do not create a parallel delegation mechanism. A provider-native subagent can continue only while its parent process/session remains alive; it is not a restart-safe ownership boundary. See [the T3 source audit](source-audit.md).

## Current Codex adapter status

The Codex adapter runs the installed Codex CLI in a per-thread workspace and resumes the saved CLI session for later turns. It streams completed assistant messages and maps success only when it receives a successful process exit plus `turn.completed`. Its session id is saved atomically. Per-thread overlap protection is process-local; a multi-replica deployment still needs a distributed thread lease at the orchestration layer. The adapter does not expose computer tools, model/provider switching, or child-task delegation.

The focused adapter suite uses a deterministic local fake CLI and verifies prompt forwarding, resumed sessions, output streaming, failure reporting, timeout, disconnect, path-safe thread IDs, and overlap rejection. It does not authenticate to Codex or prove a live model completion.

## Evidence checked

- `server/src/work/queue.ts` defines idempotent offers, leased claims, lease renewal, finish/release operations, retries and attempt caps; `server/src/work/loop.ts` runs server-side queue consumers.
- `worker/src/index.ts` runs a local routine scheduler and dispatches due routine runs to the server.
- `toolkit/src/run-turn.ts` takes and renews the Intelligence thread lock during a headless turn.
- `server/src/agents/handoff-runner.ts` claims and delivers durable `bot.message` work; `handoff-delivery.ts` records the turn in the Intelligence thread.
- `server/src/db/schema/coworker.ts` and `schema/responsibilities.ts` define existing purpose-specific run tables.
- `server/src/approvals/` stores approval/questions and continuation paths; `resume-sweep.ts` queues decided approval continuations after restart.
- `server/src/copilot.ts` selects the configured CopilotKit runtime or the in-memory local runner.
- `agent-codex/src/adapter.ts` and `agent-codex/tests/adapter.test.ts` define the current Codex boundary and deterministic tests.

## Open research

- Define the precise boundary between PostgreSQL run/lifecycle state and the existing Intelligence transcript before changing either store.
- Trace a handoff worker crash between transcript persistence, provider side effects, and queue settlement to define duplicate-delivery behavior and safe retry classes.
- Decide how user cancellation reaches the provider process and how it is recorded if the worker disconnects.
- Codex registration, port, and packaging are done: a registry row gated off for creation (`desktopCreate` and `webCreate` false), default port 4215, a Dockerfile and release-manifest entry, and a local `linux/arm64` image build where `codex --version` passed. Still blocked: verify the packaged runtime (`/proc` visibility of the startup service token, Linux sandbox read and network limits, and sandboxed-shell reach to proxy :60001); define supported authentication without exposing subscription credentials to arbitrary containers; and record that evidence in [decisions.md](decisions.md#keep-codex-unavailable-for-creation) before re-enabling creation. Run an authenticated turn only after that boundary is safe.
- Verify approval expiry and recovery paths with focused tests.
- Add an end-to-end restart test for handoff delivery after defining which retries are safe.
