# Viero autonomous RPC optimization — Phase 2 implementation

Status: implemented and validated locally only. No deployment, service restart, autonomous activation, manual LP change, funded test, or blockchain transaction was performed.

## Files changed

- `src/viero/adapters/events.ts`
  - Added a cycle-scoped `BlockBoundaryCache` keyed by chain, pinned head number, pinned head hash, and requested timestamp.
  - Added non-invasive pagination telemetry to `pagedLogs()`.
  - Passed pagination telemetry through targeted discovery, discovery-worker, indexer, and historical observation paths.
  - Kept pagination ranges, row-cap handling, split behavior, and fail-closed errors unchanged.
- `src/viero/observability/rpcTelemetry.ts`
  - Added bounded pagination counters and range samples to the existing telemetry snapshot.
- `src/viero/workers/screeningWorker.ts`
  - Creates a fresh block-boundary cache per autonomous cycle and passes it into candidate historical observation.
- `src/viero/adapters/targetedPoolDiscovery.ts`
  - Preserves canonical identity recovery while retaining advisory provider hints with missing-field/freshness notes.
  - Adds provider disagreement evidence without changing execution authorization.
  - DEX Screener/Gecko missing liquidity, volume, or creation timestamps no longer discard a structurally valid advisory pool hint; final on-chain screening remains authoritative.
- `src/viero/workers/discoveryWorker.ts` and `src/viero/indexer/protocol.ts`
  - Added pagination telemetry to their existing historical log scans.
- `tests/rpcOptimization.test.ts`
  - Added Phase 2 block-boundary, pagination, and advisory-field regression tests.
- `docs/audits/viero-autonomous-rpc-phase2-implementation.md`
  - This report.

## 1. Cycle-scoped block-boundary cache

`BlockBoundaryCache` is intentionally not a process-wide or cross-cycle cache. Its key contains:

`chainId + pinned head block number + pinned head block hash + requested window timestamp`

The autonomous `Agent.cycle()` creates a new cache. A hit is therefore valid only for the same pinned head identity and exact requested window. A changed head number or hash creates a miss. Existing `firstBlockAt()` binary-search semantics are unchanged, including repeated timestamp handling and the returned earliest block boundary.

This cache currently benefits any same-cycle repeated observation that shares a pinned head/window. It does not reuse a boundary across cycles or across a changed head.

## 2. Historical log telemetry

`pagedLogs()` now records, when a chain ID and telemetry instance are supplied:

- requested range;
- logical page requests;
- successful/attempted page count;
- split count;
- returned log count;
- provider/splitting errors;
- aggregate latency.

The telemetry is bounded: operation rows remain capped, and pagination range samples are capped at 256. It never records URLs, credentials, request bodies, private keys, log payloads, or transaction data. It does not alter page size, retry behavior, recursion, ordering, row caps, or error handling.

Expected provider range-limit errors that cause a split are recorded as telemetry errors for diagnosis, while the existing complete-recovery algorithm continues. A non-splittable error is recorded and rethrown exactly as before.

## 3. Provider prefilter hardening

The existing DEX Screener and GeckoTerminal integrations remain advisory. Structurally valid pair/pool hints are retained when advisory liquidity, volume, or creation-time fields are absent or fresh, with `advisoryIssues` such as `LIQUIDITY_UNAVAILABLE`, `VOLUME_1H_UNAVAILABLE`, `CREATION_TIME_UNAVAILABLE`, or `CREATION_TIME_FRESH`.

Hints still require a valid chain, supported venue/protocol, approved quote relationship, token pair, and correctly shaped V3 address or V4 bytes32 identifier. Incomplete V4 hints remain unmappable until PoolKey/PoolId recovery succeeds. `verifyPool()` and final on-chain policy checks remain unchanged.

When multiple providers describe the same identity, the discovery evidence records disagreement for token-pair or materially different liquidity values. This is shadow evidence only; it does not reorder, approve, or reject a pool by itself.

No provider field is used as a substitute for current tick, active liquidity, initialized ticks, exact fees, simulation, PoolKey identity, canonicality, or transaction authorization.

## 4. Deterministic RPC counts

These are logical deterministic test-path comparisons, not Alchemy compute-unit measurements:

| Path | Before Phase 2 | After Phase 2 |
|---|---:|---:|
| First exact block-boundary lookup | `O(log2(head))` historical `eth_getBlockByNumber` reads | Same `O(log2(head))` reads |
| Repeated identical lookup in one pinned cycle | Another `O(log2(head))` reads | 0 additional block-boundary reads (cache hit) |
| Changed head number/hash | Could reuse only by caller mistake | Cache miss; recomputes exact boundary |
| `pagedLogs` logical calls | Unchanged | Unchanged; telemetry added around them |
| Pagination split recovery | Same complete recursive page set | Same complete recursive page set plus counters |
| Candidate selection/ranking | Existing deterministic behavior | Unchanged; advisory issues are evidence only |

No real CU savings are claimed from mocked or deterministic counts.

## 5. Validation

- `npm run typecheck` — passed.
- `npm test` — **458 passed, 1 skipped, 0 failed** (459 total).
- `npm run build` — passed.

New regression coverage verifies:

- boundary cache hit for the same pinned head/hash/window;
- invalidation on a changed head hash;
- exact boundary semantics remain intact;
- complete log recovery after pagination splits;
- split/error/page/log-count telemetry;
- provider hints retained when advisory fields are missing;
- existing pool identity/recovery tests;
- unchanged candidate ranking, exact fee/depth math, management/close decisions, fresh confirmation, and fail-closed safety behavior through the existing suite.

No manual LP workflow was modified or invoked.

## 6. Remaining RPC cost drivers

The largest remaining autonomous costs are still:

1. selected-candidate `verifyPool()` and fresh state reads;
2. exact historical swap/protocol-fee `pagedLogs()` scans;
3. per-event block timestamps, historical slot reads, and transaction sender lookups;
4. initialized tick bitmap/tick reads for exact depth;
5. fresh independent management confirmation and receipt reconciliation.

These remain intentionally on-chain because external APIs cannot establish complete block-pinned LP economics or execution safety.

## 7. Rollback plan

No production rollout occurred. If approved later and a rollback is needed, deploy the prior release bundle. Removing the cycle cache changes no persisted trading state; pagination telemetry can be disabled by reverting the instrumentation changes. Provider advisory notes are additive and can be ignored by older readers. Do not delete unrelated runtime state or evidence caches.

## 8. Recommended Phase 3 optimizations

1. Use the new telemetry to measure actual page split/error distributions by chain and workflow before changing page sizes.
2. Add cycle-scoped memoization for other immutable block metadata only when keyed to the same pinned head hash.
3. Deduplicate same-block timestamp and historical-slot reads within one observation while preserving the final block-hash/reorg check.
4. Add bounded, shadow-only provider freshness/disagreement dashboards before allowing external data to affect ordering.
5. Consider a trusted indexed historical source only for non-safety-critical prefiltering; keep RPC confirmation for identity, exact fees, depth, simulation, and authorization.

Phase 3 should not replace `pagedLogs()`, exact fee growth, initialized-tick depth, or independent confirmation without evidence that the replacement preserves completeness, block provenance, and fail-closed behavior.
