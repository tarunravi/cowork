# Architecture decisions

Updated: 2026-10-20

## Direction

Build Cowork as a product layer over OpenBot's existing chat, harness registry, PostgreSQL database, worker queue, Intelligence thread integration, approval system, and computer-control agent. PostgreSQL owns work identity and lifecycle; the existing Intelligence thread remains the transcript for the first slice. Extend existing work primitives before introducing a parallel run or delegation system.

## Decisions

### Reuse PostgreSQL and the worker queue

Use the existing work queue for dispatch, retries, and distributed work leases. Persist only state the queue and purpose-specific `routine_runs` / `responsibility_runs` do not already represent. The Intelligence thread remains the transcript and run lock for headless turns; do not duplicate every AG-UI event in PostgreSQL without a concrete product or recovery requirement. Keep PostgreSQL authoritative for app-owned work identity, lifecycle, attempts, and parent/child relationships.

**Reason:** `server/src/work/queue.ts` already implements idempotent offers, PostgreSQL-backed leased claims, renewals, attempt caps, and multi-replica-safe claiming. Server-side consumers live in `server/src/work/loop.ts`. The separate `worker/src/` loop schedules routine work and dispatches it to the server; it is not the general queue consumer.

### Make the application own delegated tasks

Extend the existing `bot.message` handoff for app-owned delegation and give child work an explicit run identity/status if the current queue plus audit events are insufficient for the UI and recovery contract. Do not add a competing delegation path. Do not treat provider-native subagents as restart-safe tasks.

**Reason:** OpenBot already offers durable queued bot-to-bot handoffs, delivered through the platform runner and visible in its Intelligence transcript. T3's source audit found provider-native children tied to their provider process, while app-owned queued work can outlive a parent provider session.

### Keep adapter capabilities explicit

Only advertise a harness capability when the adapter implements it and the product can enforce it. The current Codex adapter supports assistant text and persisted CLI-session continuity. Computer access, app-owned delegation, approvals within the provider session, and token-level streaming remain unsupported by that adapter.

**Reason:** UI affordances must reflect executable behavior, not roadmap intent.

### Keep Codex sessions in separate per-thread workspaces

Give each Codex thread its own CLI working directory and session id, and treat that as the design. It is not yet enforced at the OS level; see the next decision. Store session ids atomically with restrictive permissions. Keep the provider call deadline and process-tree cleanup in the adapter; move cross-process concurrency and cancellation ownership into the existing app-owned work/turn layer.

**Reason:** Per-thread CLI history and files should not collide. Process-local guards protect one adapter process only.

### Keep Codex unavailable for creation

The Codex adapter (`agent-codex/`), its registry row, and its Dockerfile are kept in the tree. Creation is closed: the registry sets `desktopCreate` and `webCreate` to false, with a `desktopUnavailableReason` for the desktop. The desktop picker disables the row and Continue, and the Tauri create path rejects a direct or stale Codex choice.

**Reason:** Isolation is not established. Codex CLI 0.163 `workspace-write` caps writes but has no configured readable-root restriction. All conversations currently share one bun UID, one workspace and `CODEX_HOME/sessions` tree, and a writable `/tmp`, so a shell started by one conversation can read other workspaces and transcripts. The API key sits in a proxy sidecar. Its separation from the agent shell is assumed from `network_access=false`, not tested. Linux sandbox behaviour and proxy reachability are unverified.

**Evidence required before re-enabling:**

- Each conversation runs under its own OS identity, or an equivalent that the OS enforces, with its own workspace and `CODEX_HOME`.
- A test from a live Linux runtime, not the fake CLI, shows that a shell in one conversation cannot read another conversation's workspace, session files, or transcripts, and cannot read the shared `/tmp` contents of another.
- A test from the same runtime shows that the agent shell cannot reach the proxy sidecar or read the API key.
- The Codex registration, its port (4215, distinct from AG2's 4210), and its image build are verified on the target runtime.
- One authenticated, live turn completes through the packaged image.

Until all five hold, no desktop or web surface may offer Codex, and no document may describe Codex as isolated or available.

### Keep a clear local development fallback

Retain the no-Intelligence in-memory runner as a local development path and label its state as ephemeral. Routines, handoffs, and responsibilities already fail fast in that mode, so it cannot satisfy persistent background-work requirements. Do not describe it as a limited durable mode.

**Reason:** A helpful local startup mode is useful, but its state disappears with the process.

### Require human action for identity gates and consequential external effects

Route passwords, MFA, CAPTCHA, identity checks, payments, and external sends through explicit user approval or take-over. Record the request, decision, and execution result in the run history. Never bypass a site or provider's required human step.

**Reason:** Computer control and ordinary agent tools need a visible, auditable boundary.

## First vertical slice

1. Keep the canonical visible transcript in the existing Intelligence thread and use its cross-replica thread lock for headless delivery.
2. Extend the existing `bot.message` handoff path with an explicit app-owned run identity and visible lifecycle only where its queue key and audit events do not already answer the UI/recovery needs.
3. Preserve the current queue lease and platform runner. Do not add a second event store or a second delegation queue.
4. Define reclaim behavior: a second attempt after possible provider/tool side effects must not silently repeat unsafe work. Retry only work proven idempotent or after the user explicitly resumes it.
5. Test a worker crash after transcript persistence but before queue settlement; assert that the transcript and status remain truthful and no unsafe duplicate turn is reported as exactly-once.
6. Re-enable Codex creation only after the evidence under "Keep Codex unavailable for creation" is recorded. Alternatively use an already-registered harness only after verifying its tool restrictions and interrupt behavior.
7. Keep the no-Intelligence local fallback explicitly ephemeral; do not use it to claim durable recovery.

Then connect `agent-computer` through a capability-gated provider boundary and expose run, approval, delegation, and takeover states in the product UI.

## Not decided yet

- Exact run lifecycle extension to the existing handoff records and migration strategy.
- Whether the target product replaces the external Intelligence transcript with an app-owned PostgreSQL conversation store; the first slice retains the existing boundary.
- Whether provider session ids belong in an encrypted session table or a dedicated secret store.
- Retry policy by provider/tool category and the user-visible action after a potentially duplicated side effect.
- First computer-control provider and its allowed action categories.
- Whether provider-native text deltas can be surfaced consistently across harnesses.

## References

- [OpenBot and T3 source research](research.md)
- [T3 source audit](source-audit.md)
- [Grok Bot reference analysis](../design/reference-analysis.md)
