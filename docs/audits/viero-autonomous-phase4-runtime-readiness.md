# Viero Autonomous Phase 4 Runtime Readiness Audit

Audit date: 2026-10-16
Mode: read-only local source/test audit. No VPS access, service restart, signer call, autonomous activation, or transaction was performed.

## Verdict

**B — REQUIRES TARGETED REMEDIATION.**

The deterministic screening, canonical pool verification, depth/fee calculations, signer boundary, and independent close confirmation are implemented and covered by the local test suite. This is not a production-readiness approval because live/Telegram startup has an LLM configuration contract mismatch, production service state is unverified, and a small set of recovery paths lack complete telemetry/fault-injection evidence. No critical safety bypass was proven in this audit.

## Repository baseline

The checkout is on `main` at `128ac3d` and contains a pre-existing dirty working tree with source, deployment, documentation, and generated-file changes. This audit adds documentation only and does not normalize or overwrite unrelated changes. There was no commit or push.

Validation run from the checkout:

- `npm run typecheck`: passed.
- `npm test`: 460 passed, 1 skipped, 0 failed (461 total).
- `npm run build`: completed without a reported error.

## Runtime call graph

```text
viero-agent.service
  └─ run-agent.sh → cli live
       ├─ selectedRuntimeChains / persisted controls
       ├─ Agent.cycle
       │    ├─ advisory DEX/Gecko hints
       │    ├─ canonical V3/V4 pool discovery and verifyPool
       │    ├─ targetedRpcObservation (creation evidence, logs, pinned state, depth)
       │    ├─ deterministic screening/ranking
       │    └─ planner → SignerClient.open → signer simulation/receipt/journal
       └─ management interval
            └─ manageLive
                 ├─ cycle/lightweight observation
                 ├─ policy decision
                 ├─ independent fresh confirmation
                 ├─ SignerClient.close → signer simulation/receipt
                 ├─ receipt-derived realized PnL and persisted CLOSED state
                 └─ optional Relay normalization (separate failure boundary)
```

The Telegram service is a separate presentation/control process. The optional indexer is a separate service and is not required by the agent path.

## Phase 1–3 integration result

The implementation matrix is in [the integration matrix](viero-autonomous-phase4-integration-matrix.md). In summary:

- Phase 1 evidence caches are active for verified token metadata and pool creation evidence, with canonical identity/hash invalidation.
- Phase 2 cycle block-boundary caching and complete log pagination are active; pagination behavior remains fail-closed.
- Phase 3A observation-local memoization is active and does not cross observations or authorization boundaries.
- Phase 3B was a bounded read-only profiling harness, not a production runtime budget or health check.
- Phase 3C recommended stopping further speculative RPC optimization until more attribution evidence exists; no runtime optimization from that audit is assumed here.

## RPC and cache safety

`PublicClients` uses configured per-chain RPC fallbacks with bounded viem retries and records logical/physical telemetry. The telemetry aggregation is bounded and excludes credentials and payloads. Physical counts are estimates when viem batches multiple logical calls into one HTTP request, so they must not be read as exact Alchemy billing.

The caches are appropriately narrow: immutable token metadata is bound to bytecode identity; creation evidence is bound to canonical block identity; block boundaries are head/hash/time-window scoped; observation memo entries are successful historical reads only. Mutable prices, ticks, liquidity, balances, and fee growth are not cached by these mechanisms.

One limitation remains: direct reads in close-recovery, normalization, and some receipt/position paths are not uniformly wrapped in named telemetry workflows. They remain functional, but attribution can fall into `unknown`.

## Screening and depth correctness

The screening pipeline requires canonical prices and complete initialized-tick evidence before computing depth. `depth1Pct` uses the existing ±1% price interval, traverses initialized ticks in both directions, applies signed liquidity-net transitions, and adds residual liquidity. The policy rejects when either directional depth or total depth is below the configured chain thresholds; missing evidence is rejected separately. Tests cover exact math, missing/incomplete ticks, thresholds, and policy outcomes.

External market APIs are advisory. `verifyPool` remains authoritative for chain, bytecode, token order, factory/PoolId relationship, fee/tick state, liquidity, and approved V4 hooks. An unapproved non-zero V4 hook is intentionally rejected rather than guessed or bypassed.

## Management and authorization

Open-position management evaluates fresh lightweight state on the five-minute management schedule, then performs an independent confirmation observation before a close is handed to the signer. The signer independently simulates and authorizes writes, waits for receipts, and journals outcomes. Close receipt evidence is used for realized PnL and persisted state before optional Relay normalization.

The `closing` recovery branch is a reconciliation path for previously persisted close intent/transaction evidence, not a new policy decision. It should be covered by the crash-boundary tests in F4; this audit did not invoke it against a live signer.

## Failure-injection/readiness matrix

| Scenario | Result | Evidence / limitation |
|---|---|---|
| RPC timeout, 429, 5xx | READY WITH CONDITIONS | Transport retries/fallback and provider-error tests exist; no exhaustive live fault matrix was run. |
| Partial log pagination | READY | `pagedLogs` split/recovery tests and fail-closed row caps. |
| Provider disagreement/stale advisory data | READY | Advisory integrations cannot override canonical verification; discovery tests cover identity rejection. |
| Reorg/block-hash mismatch | READY | Cache invalidation and pinned-hash tests. |
| Missing block hash/state | READY | Pinned observations and missing-evidence rejection tests. |
| Wrong token decimals/metadata identity | READY WITH CONDITIONS | Cache identity tests exist; no live incorrect-contract deployment was exercised. |
| Concurrent worker execution | READY WITH CONDITIONS | Per-chain executor serialization and sequential scheduler are present; multi-process locking was not demonstrated. |
| Process restart/crash boundary | PARTIAL | Persistence/reconciliation tests exist; no controlled kill/restart around broadcast, receipt, and state writes. |
| Duplicate scheduler invocation | PARTIAL | Scheduler tests exist; no process-level duplicate-instance lock was verified. |
| Incomplete transaction receipt | PARTIAL | Executor handles receipt outcomes, but operational reconciliation needs the F4 crash matrix. |
| Persistence/storage failure | NOT VERIFIED | No injected production-like storage failure was run. |
| Signer unavailable/socket missing | NOT VERIFIED OPERATIONALLY | Source has health checks and Unix socket handling; VPS state was not inspected. |

## Operational readiness

Deployment units include hardening, environment files, bounded writable state, and a separate signer. The repository cannot establish that the deployed agent and Telegram services are active, that `/run/viero-signer/viero.sock` exists with the expected permissions, that journals are writable, or that the indexer is inactive. Those are deployment checks, not source facts. `VIERO_INDEXER_DISABLE=1` is supported by the indexer process, but the unit's enabled state must be checked on the target host.

The largest source-level readiness issue is the LLM contract: `cli.ts` constructs `createLlmClient()` for `live` and `telegram`, while `llmClient.ts` requires `VIERO_LLM_API_KEY`; public configuration presents LLM as optional. With an empty key, those modes fail before the deterministic loop can run. This must be explicitly resolved before a controlled run.

## Findings and disposition

1. **F1 / High — LLM optionality mismatch.** Resolve the product contract and add a startup regression test. See remediation plan.
2. **F2 / High — Production service/indexer state unverified.** Perform a read-only host checklist before activation.
3. **F3 / Medium — Telemetry workflow coverage partial.** Add labels around recovery/normalization/receipt paths without changing semantics.
4. **F4 / Medium — Crash/restart evidence incomplete.** Add deterministic process-boundary and storage-failure tests.
5. **F5 / Low — Documentation drift.** Align scheduler documentation with current `cli` behavior.
6. **F6 / Low — Extreme-number precision not exercised.** Add precision fixtures before changing arithmetic.

See [the remediation plan](viero-autonomous-phase4-remediation-plan.md) for smallest safe follow-ups and acceptance tests.

## Readiness decision

The core deterministic safety path is **READY WITH CONDITIONS** for further offline/paper validation. The overall autonomous runtime is **not ready for a controlled production-like run** until F1 is explicitly resolved, F2 is verified on the target host, and the F4 crash-boundary evidence is added. No code or production state was changed by this audit.
