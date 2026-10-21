# T3 Code source audit

Purpose: separate what T3 Code **implements** from what it only **documents or proposes**, so OpenBot reuses designs that exist. Findings come from reading source; no T3 tests were run (see [Not verified](#not-verified)).

## Baseline

| Item | Value |
|---|---|
| Local T3 fork (`~/t3code`, branch `main`) | `bf9ae3e279fbb1fe0c7ad9679f3a5d4ab1cc354d` (2026-10-15) |
| Merge-base with upstream `origin/main` | `ec1313c8f8333292506f05a355bb72d308a455d8` (2026-10-14) |
| Upstream `origin/main` as of the local ref (not fetched) | `4af66184ef832c4939f331725585dc70f0c8a3c4` (2026-10-19) |
| Fork vs merge-base | 118 fork-only commits; 344 files, +34,800/−1,237 (`git diff --shortstat`) |
| Upstream (local ref) vs merge-base | 1,404 commits ahead; `apps/server/src/orchestration-v2`: 298 files, +33,686/−15,850 |
| OpenBot (this repo) | `c046ad6c99d5ec4ba0a35d697253e6c99875962b`, MIT (`LICENSE`, © 2026 CopilotKit) |
| Public upstream | <https://github.com/pingdotgg/t3code> · merge-base: <https://github.com/pingdotgg/t3code/commit/ec1313c8f8333292506f05a355bb72d308a455d8> (URLs built from the public repo name; not fetched) |

Consequence: the fork is a **week-old fork point and far behind upstream's orchestration-v2**. Anything below marked *fork-only* is not on upstream; anything marked *upstream* was present at the merge-base. Re-audit against current upstream before copying code.

## Status matrix

Legend: **I** implemented (code plus tests/fixtures), **P** partial, **D** documented/proposed only. T3's own `docs/orchestration-v2/README.md` calls itself the "target architecture", so its prose is not evidence; the code paths are.

| Area | Status | Evidence (repo-relative to `~/t3code`) |
|---|---|---|
| Provider adapter interface and capability matrix | **I** | `apps/server/src/orchestration-v2/Adapters/{Codex,Claude}AdapterV2.ts` (`CodexProviderCapabilitiesV2` at `CodexAdapterV2.ts:235`; Claude block near `ClaudeAdapterV2.ts:272`); registry `ProviderAdapterRegistry.ts`; spec `docs/orchestration-v2/provider-capability-system.md`. Capabilities are declarative and drive policy. |
| Adapter breadth | **I** (fork adds more) | Upstream: Codex, Claude, ACP, Cursor, Grok, OpenCode(2), Pi, Muse. Fork-only: `Adapters/ZCodeAdapterV2.ts`, omp driver commits (`a1867e250c`, `25bdc3936e`). |
| Codex session lifecycle | **I** | Long-lived app-server client (`packages/effect-codex-app-server/src/client.ts`), `CodexAdapterV2.ts` (multi-thread sessions, `thread/rollback`, fork, interrupt). Known gap noted in source at `CodexAdapterV2.ts:6513-6518`: a later-resumed subagent reads as completed between turns. |
| Claude session lifecycle | **I** | `ClaudeAdapterV2.ts` over `@anthropic-ai/claude-agent-sdk` (query runner `ClaudeAgentSdkQueryRunner`), wake buffers, session subagent registry. `backgroundTasksEndWithProcess: true` (`:9255`). |
| Session pooling, idle release | **I** | `ProviderSessionManager.ts:55-56,1270-1340` (30 min idle, 4 h max pin). |
| Model/provider switching, context handoff | **I** | `ProviderSwitchService.ts`, `ProviderSessionTransitionPolicy.ts`, `ContextHandoffService.ts`/`ContextHandoffDelivery.ts`, `ProviderSelectionTransition.test.ts`; capability flags `supportsModelSwitchInSession`, `supportsProviderSwitchingViaHandoff`. Spec: `docs/orchestration-v2/provider-switching-and-context.md`, `docs/internals/context-handoffs.md`. |
| Context-window / token usage | **P** | `getModelContextWindow` on Claude session (`:9253`); `ProviderTurnTokenUsage.test.ts`. Window accounting is per adapter, no shared budget policy found. |
| Subagent discovery | **I** (fork-extended) | Provider-native subagents projected as `subagent` turn items + child threads (`subagentProjection`); roster for MCP callers in `apps/server/src/mcp/threadSubagentRoster.ts` (fork-only); `orchestrator_capabilities` tool in `mcp/toolkits/orchestrator/tools.ts`. |
| Cross-provider delegation | **I** | `delegate_task` MCP tool → `OrchestratorMcpService.ts` → `Orchestrator.ts:~6800-6890` creates an `app_owned` subagent bound to a **new child thread** with its own `modelSelection`/provider instance. Spec `docs/orchestration-v2/orchestrator-mcp-server.md`. |
| Run/thread graph | **I** | Contracts `packages/contracts/src/orchestrationV2.ts` (thread, run, attempt, node, provider thread, turn item, subagent); lineage `ThreadForkService.ts`, `ThreadLaunchService.ts`, merge-back. |
| Durable events and projections | **I** | `EventStore.ts`, `ProjectionStore.ts`, `CommandReceiptStore.ts` (idempotent commands), `ProjectionRecovery.test.ts`. |
| Durable effect outbox | **I** (docs stale) | README lists it as "Tracked Follow-Up", but `EffectOutbox.ts` (request kinds such as `provider-runtime.continue`, `provider-session.detach`) and `EffectWorker.ts` exist. |
| Continuations / wakes | **I** | `ProviderContinuationService.ts` (adapter-buffered wake turns become runs), `RestartContinuation.ts`, `NotificationMailbox.ts`, delegated completion mailbox (`DelegatedCompletionDelivery.test.ts`, `completionWake: "always" \| "settled_only"` at `contracts/.../orchestrationV2.ts:777`). |
| Approvals / permissions | **P** | `RuntimeRequestService.ts`, `CommandPolicy.ts`, `RuntimePolicy.ts`; provider-native enforcement. Both adapters declare `pendingRequestsSurviveRestart: false` and `approvalCallbacksAreLiveOnly: true`, so pending approvals are lost on restart by design. |
| Recovery | **I** | `ProviderRuntimeRecoveryService.ts` (787 lines + regression tests), `OrphanedBackgroundWork.ts` (fork-only), `ThreadSettlementService.ts`. |
| Retries / limits | **I** (mixed) | `UsageLimitRecoveryWorker.ts` (resumes after a reported reset), `DispatchModeLimit.ts` (upstream); `ProviderFallbackWorker.ts` — one retry on a configured fallback model after two consecutive failures (**fork-only**). |
| Streaming | **I** | `assistantStreaming.ts` (fork adds provider-paced mode), `LiveStreamBudget.ts`, `ThreadStream.ts`, `ThreadLiveEventCoalescer.ts`, `ProviderTextDeltaCoalescer.ts`. |

## Key claim: do background native children outlive the parent turn?

**Answer: yes for the live process, no across process loss, and not for ownership-safe durability. The durable alternative is an app-owned child thread.**

### Provider-native children (Codex/Claude subagents)

1. **Parent terminal does not end ingestion.** `RunExecutionService.ts:1250-1320`: after the root terminal event, the run's event subscription stays open while child provider turns, child subagents, or background turn items remain non-terminal. Only a **completed** root keeps tracking; `terminal.status !== "completed"` drops it immediately (`:1253-1256`). Late completions keep landing even if a newer run took `lastRunOrdinal` ("owner loss" comment, `:1276-1281`).
2. **Ownership is recorded.** Each native child is a `subagent` row with `runId` = parent run and a child thread whose root turn is runless. The run keeps a snapshot of open owned subagents/nodes (`RunExecutionService.ts:1138-1170`) so a later interrupt can cascade to them.
3. **The session is pinned while work remains.** `ProviderSessionManager.ts:1285-1330` probes `hasPendingBackgroundWork` before idle release, re-arming every 30 min up to a 4 h cap, then releases (`idle-release-pin-expired` warning). Probes: Claude `ClaudeAdapterV2.ts:9258` (rosters, running session subagents, buffered wake messages); Codex `CodexAdapterV2.ts:6519` (running commands/tools, MCP captures, running subagent threads).
4. **Boundary — it dies with the process.** Claude declares `backgroundTasksEndWithProcess: true`. When the process or session is lost, `OrphanedBackgroundWork.ts` (header doc, `orphanedBackgroundWorkEvents`) cancels the items/nodes/subagents, and `Orchestrator.ts:~8620-8700` marks native subagents and their runless child roots `interrupted`. Interrupt/failure of the parent also terminalizes them (`Orchestrator.ts:~8805-8830`, `cascadeTerminalizeRunOwnedSubagents`). Tests: `BackgroundWorkInterrupt.integration.test.ts`, `BackgroundWorkStop.integration.test.ts`, `TaskCancelNativeSubagent.integration.test.ts`.
5. **Fork policy removes the risk.** The fork **denies** Claude's `Agent`/`Task`/`Workflow` tools and redirects to `delegate_task` because "native subagents run outside T3's task model, so T3 cannot show or cancel them" (`ClaudeAdapterV2.ts:1031-1055`, fork-only since `3a8e3af8cd`). Upstream still permits them.

### App-owned delegated children (`delegate_task`)

- Child is a separate thread with its own provider session, created durably (`Orchestrator.ts:~6800-6890`; fields `origin: "app_owned"`, `childThreadId`, parent `runId`, `completionWake`).
- It is **excluded** from the parent's interrupt cascade (`delegatedNodeIds`/`origin !== "app_owned"` filters, `Orchestrator.ts:~8810-8830`) and from orphan cancellation on session release unless the caller proves the child's process is gone (`OrphanedBackgroundWork.ts`, `settleAppOwnedSubagents`).
- Recovery treats it as independent work: `ProviderRuntimeRecoveryService.ts:100-110` ("reconciled and continued on its own and reports back through the app").
- While its own grandchildren or tasks run it waits in `waiting_for_children`, and is re-finalized when they settle (fork commit `4645c38fa2`, tests in `DelegatedCompletionDelivery.test.ts`).
- Completion returns through a durable mailbox, either steering the live parent or queuing a new run (`NotificationMailbox.ts`, `ProviderContinuationService.ts`).

**Conclusion for OpenBot:** a native child continuing after the parent run settles is a best-effort in-process behavior bounded by process life and a 4 h pin. Task ownership survives only because T3 keeps the `subagent` row and child thread in its event store. For durable background work OpenBot should model children as app-owned threads, not as provider-native subagents.

## Reuse decisions

| Decision | Reuse | Reason |
|---|---|---|
| Event-sourced thread → run → attempt → node → provider-thread model with idempotent command receipts | **Adopt the design**, reimplement | Matches the evidence above; T3's code is Effect-TS with `Orchestrator.ts` at 12,003 lines, too coupled to lift. |
| Declarative provider capability matrix | **Adopt the schema** (adapt) | Small, self-contained, makes features capability-driven. |
| App-owned child threads for delegation; deny provider-native subagents | **Adopt** | Only design shown to keep ownership and cancel/settle semantics. |
| Session pin with idle window and hard cap | **Adopt** (30 min / 4 h as starting values) | Simple and bounded. |
| Durable mailbox for completion wakes | **Adopt** | Gives at-least-once delivery with stable message ids (`NotificationMailbox.ts`). |
| Codex via long-lived app-server protocol (`packages/effect-codex-app-server`) | **Adopt as direction**; do not copy yet | OpenBot's `agent-codex` runs `codex exec` / `exec resume` per turn at `c046ad6` (`agent-codex/src/index.ts`, header comment), so a child cannot outlive a turn. The package is `private` in a monorepo with its own Effect stack. |
| Claude via Agent SDK | **Already aligned** | `agent-claude-sdk` uses `claude-agent-sdk==0.2.152` and `ag-ui-claude-sdk==0.1.5`. |
| Fork-only features (fallback worker, omp, orphan cancellation, native-subagent deny) | **Evaluate individually** | Not on upstream; useful ideas, unreviewed upstream. |
| Persistence | **Keep OpenBot's** | OpenBot owns PostgreSQL plus CopilotKit Intelligence (or `InMemoryAgentRunner`, `server/src/copilot.ts:1755`); T3 uses SQLite projections. |
| Approvals | **Keep OpenBot's** (`server/src/approvals/*`) | It already has durable approvals with policy; T3's approvals are live-only. |

## Licensing

- OpenBot is MIT (© 2026 CopilotKit). T3 Code's root `LICENSE` is MIT (© 2026 T3 Tools Inc.); `apps/server/package.json` also says MIT. I did not audit every dependency or vendored asset.
- MIT permits copying T3 code into OpenBot, **provided the T3 copyright and permission notice travel with the copied portions** (keep file headers, or add a `THIRD_PARTY_NOTICES` entry naming T3 Tools Inc. and the source path/commit). Design-only reuse (concepts, schemas re-expressed) carries no obligation, but attribution is courteous.
- Provider SDKs and CLIs (Claude Agent SDK, Codex CLI) carry their own terms; T3's MIT does not cover them.
- T3 names, brand marks, and fork-specific skills are not MIT-licensed code; don't copy marks.

## Blockers and risks

1. **Fork staleness.** The fork is 1,404 commits behind the local `origin/main` ref; behavior may have changed. Re-verify before porting.
2. **Native children are not durable.** No source path lets a provider-native child survive a process restart; only `delegate_task` children do.
3. **Codex gap.** A resumed Codex subagent can be released early (`CodexAdapterV2.ts:6513-6518`).
4. **Approvals lost on restart** in both T3 adapters.
5. **OpenBot's Codex bridge is per-turn `codex exec`**, so it cannot host background children until moved to a persistent protocol client.
6. **Concurrent edits in this repo.** At audit time `agent-codex/{package.json,src/index.ts}` were modified and `agent-codex/src/adapter.ts`, `agent-codex/tsconfig.json` untracked by someone else; this audit cites `agent-codex/src/index.ts` as of `c046ad6`.

## Not verified

- The source audit itself did not run T3 tests. After it was written, the parent independently ran `bun run --cwd agent-codex test` (14 passed, 117 assertions) and `bun run --cwd agent-codex typecheck` (passed). No broader OpenBot or T3 suite was run.
- Upstream `origin/main` was not fetched, so the 1,404-commit gap and upstream-vs-fork attributions use local refs only. "Fork-only" labels come from `git diff ec1313c… HEAD` file status and `git log -S`.
- Live runtime behavior (a real Claude or Codex child outliving a settled parent, the 4 h pin firing) was not exercised.
- Event-store durability under crash (SQLite transaction boundaries) was not inspected.
- Provider SDK terms and dependency licenses were not reviewed.

## Commands used

```
git -C ~/t3code rev-parse HEAD
git -C ~/t3code merge-base HEAD origin/main
git -C ~/t3code rev-list --left-right --count origin/main...HEAD
git -C ~/t3code diff --shortstat ec1313c8f8333292506f05a355bb72d308a455d8 HEAD
git -C ~/t3code diff --name-status ec1313c8f8333292506f05a355bb72d308a455d8 HEAD -- apps/server/src/orchestration-v2 apps/server/src/mcp packages/contracts/src
git -C ~/t3code log -S"CLAUDE_NATIVE_SUBAGENT_DENY_REASON" -- apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
grep -n "hasPendingBackgroundWork\|maxIdlePinMs\|origin === \"app_owned\"" in the files cited above
```
