# Viero autonomous RPC efficiency — Phase 1–2 validation audit

**Date:** 2026-10-15
**Scope:** autonomous Viero workflows only. Manual LP workflows are excluded.
**Mode:** offline deterministic validation; no live RPC scan, deployment, service restart, autonomous activation, or transaction.

## Executive result

Phase 1–2 behavior is effective for the paths that can be exercised offline:

- token metadata cache: verified hit, miss, persistence, and bytecode-mismatch invalidation;
- pool creation evidence cache: verified reuse and canonical creation-block-hash invalidation;
- cycle block-boundary cache: verified same-head/window hits and head-hash misses;
- `pagedLogs()`: verified complete recovery after recursive provider-cap splits, with telemetry.

The repository's replay fixtures are policy/observation fixtures and do not drive real `verifyPool()`, historical logs, or management RPC reads. Therefore the full scenario table below distinguishes **measured fixture counts** from **code-derived modeled counts**. No Alchemy CU or USD savings are claimed.

## 1. Real autonomous call graph

```text
five-minute autonomous cycle
  -> GMGN token discovery/screening (normally no EVM RPC)
  -> stage-1 ranking and eligibility
  -> selected token only
     -> DEX/Gecko advisory hints
     -> canonical V3/V4 pool identity recovery
     -> verifyPool() at pinned head
     -> targetedRpcObservation()
        -> exactPoolCreatedEvidence()
        -> firstBlockAt() / cycle boundary cache
        -> pagedLogs() swap + protocol-fee evidence
        -> event block/slot/transaction reads
        -> initialized tick/depth reads
        -> balances and final reorg check
     -> deterministic screening/planning/simulation
     -> signer handoff only after fresh confirmation

management tick
  -> fresh/lightweight position observation
  -> exact fee evidence and entry-basis reconciliation
  -> policy decision
  -> independent fresh confirmation before close/claim
```

Primary source functions:

- cadence: `src/viero/cli.ts` (`live` loop);
- cycle and candidate handoff: `src/viero/workers/screeningWorker.ts` (`cycle`, `executeCandidateToken`);
- pool identity/current state: `src/viero/adapters/pools.ts:verifyPool`;
- historical evidence: `src/viero/adapters/events.ts:targetedRpcObservation`, `rpcObservation`, `exactPoolCreatedEvidence`, `firstBlockAt`, `pagedLogs`;
- management: `src/viero/workers/screeningWorker.ts:manageLive`;
- transport retry/fallback: `src/viero/clients/publicClients.ts`.

No-candidate cycles stop before EVM enrichment. A first-time selected candidate reaches the full pool/observation path. Repeated candidates still verify fresh state, while Phase 1 immutable evidence and Phase 2 same-cycle boundary evidence may be reused. Management never reuses stale state across the independent confirmation boundary.

## 2. Measurement method and confidence

The validation used:

1. existing mocked-viem regression fixtures;
2. direct deterministic calls to `firstBlockAt`, `BlockBoundaryCache`, and `pagedLogs`;
3. source tracing of `cycle()` and `manageLive()`;
4. the existing bounded `RpcTelemetry` snapshot.

The following labels are used:

- **MEASURED:** observed by an offline test with a mocked transport;
- **MODELED:** derived from the current source call graph and equivalent logical operations;
- **UNKNOWN:** requires a live autonomous run and provider billing/transport correlation.

The harness counts logical viem operations. Physical HTTP batching, retries, and fallback amplification are only measured when a mocked transport exposes them. Alchemy compute units and USD are not inferred from logical counts.

## 3. Scenario results

| Scenario | Baseline | Phase 1–2 | Evidence / confidence |
|---|---:|---:|---|
| A. First candidate, cold caches | ~16–30 `verifyPool`/historical setup reads plus event/depth reads | same reads; cache misses recorded | MODELED from `verifyPool`/`targetedRpcObservation`; high call-path confidence, exact count provider-dependent |
| B. Repeated candidate, warm immutable caches | creation binary search + metadata reads repeated | metadata hits; creation evidence canonical-hash check; fresh state unchanged | MEASURED cache invariants + MODELED path |
| C. Multiple hints for one token | advisory hints then canonical verification of selected path | same ordering/identity behavior; advisory disagreements recorded | MEASURED selection regressions; exact RPC count UNKNOWN |
| D. Same-cycle repeated historical observations | each uncached `firstBlockAt` repeats ~`log2(head)` block reads | first identical chain/head/hash/window is a cache hit | MEASURED directly: second lookup adds 0 block reads |
| E. One open position over ticks | fresh management/fee/entry reads each tick | no broad new management cache; Phase 2 cycle observation can be consumed by first decision | MODELED; management safety intentionally keeps fresh reads |
| F. Three open positions over ticks | approximately 3× E | same; no unsafe cross-position sharing introduced | MODELED |
| G. Logs without splits | one page per requested page | same pages + telemetry | MEASURED by `pagedLogs` fixture |
| H. Logs with provider cap/splits | failed large page followed by recursive pages | same complete rows; split/error/latency telemetry | MEASURED: all 8 fixture rows recovered |
| I. Reorg/hash mismatch | cached evidence could be reused only if unchecked | cache invalidates and recomputes | MEASURED for token bytecode, pool creation hash, and boundary head hash |
| J. Timeout/fallback | logical call may produce multiple physical attempts | telemetry records retries/fallback when transport exposes them; semantics unchanged | MEASURED at telemetry unit level; live provider amplification UNKNOWN |

The only direct before/after zero-read result measured in this audit is the same-cycle boundary cache hit. Creation-cache tests also show that the binary search is avoided on a valid hit. Exact production hit rates require autonomous telemetry over representative cycles.

## 4. Cold versus warm cache analysis

### Token metadata

Phase 1 keys metadata by chain/address and verified bytecode identity. A warm hit avoids repeated decimals/symbol reads; a bytecode mismatch invalidates the entry. Persistence across reopening the cache was tested. Current tick, liquidity, price, balances, fees, and depth are never cached.

### Pool creation evidence

The warm path avoids the historical binary search, but re-reads the creation block and compares its canonical hash. That validation read is intentional reorg protection. A changed hash invalidates and recomputes the evidence.

### `firstBlockAt`

Phase 2 is cycle-scoped only. The key includes chain, pinned head number, pinned head hash, and timestamp. A changed head/hash or a new cycle misses. This means savings are greatest only when multiple full observations share the same pinned cycle boundary; the normal selected-candidate path may produce few or no hits.

## 5. Net savings after validation overhead

Measured logical effects:

- repeated same-cycle `firstBlockAt`: **one full binary search avoided**, with no validation RPC because the caller supplies the already pinned head identity;
- valid creation evidence hit: **binary search avoided**, plus one canonical creation-block read/hash check;
- token metadata hit: decimals/symbol reads avoided, with bytecode identity validation retained by the existing adapter;
- paged logs: **no request reduction by design**; telemetry only.

Net production savings are **not yet quantifiable** because cache hit rates, provider batching, and retry/fallback rates have not been captured from a live autonomous window. The correct next measurement is telemetry export grouped by workflow, chain, and cache state—not a CU estimate from mocked calls.

## 6. Historical enrichment cost breakdown

The largest logical consumers remain:

1. `exactPoolCreatedEvidence()` binary search on cold/invalidated pools;
2. `firstBlockAt()` binary search on each uncached observation;
3. two `pagedLogs()` families (swaps and protocol-fee updates), including recursive splits;
4. per-event block timestamp, historical slot, and transaction sender reads;
5. initialized tick bitmap/tick reads for executable depth;
6. fresh `verifyPool()` and fee-growth reads during management;
7. independent confirmation and receipt reconciliation before signer handoff.

High logical call count is not equivalent to high Alchemy CU: `eth_getLogs`, historical contract calls, and block/receipt lookups may have different provider weights. No USD attribution is made.

## 7. Cache effectiveness assessment

| Cache | Effective now? | Reason |
|---|---|---|
| Verified token metadata | Yes, when the same verified token is revisited | Avoids immutable decimals/symbol reads; invalidation is explicit |
| Pool creation evidence | Yes for revisited verified pools | Avoids historical binary search; retains canonical hash validation |
| Cycle `firstBlockAt` | Potentially, but hit rate is currently unmeasured | Safe key is narrow; one selected candidate often means one lookup |
| Pagination telemetry | Diagnostic, not an optimization | Behavior and request count intentionally unchanged |

BNB and Robinhood use the same cache semantics. Chain-specific provider limits may change hit value or split frequency, but no chain-specific relaxation exists.

## 8. Top five remaining consumers and Phase 3 recommendation

1. historical log pagination and per-event historical reads;
2. cold `exactPoolCreatedEvidence` searches;
3. initialized tick/depth reads;
4. repeated fresh verification/fee reads across card, cycle, and management paths;
5. transport retry/fallback amplification.

Recommended smallest safe Phase 3 batch:

- add an observation-local memo for event-block timestamps, historical slots, and transaction sender lookups inside `rpcObservation()`;
- expose telemetry counters for those memo hits/misses;
- preserve the final block-hash/reorg check and independent confirmation;
- use measured `pagedLogs` split distributions before changing page size.

This targets duplicate historical reads without changing candidate selection, exact fee/depth math, or execution safety. The expected reduction is **one read per unique event block/hash that is currently fetched redundantly**, with the exact percentage left as UNKNOWN until live telemetry confirms duplication.

## 9. Regression validation

Commands run locally:

- `npm run typecheck` — passed;
- `npm test` — **458 passed, 1 skipped, 0 failed** (459 total);
- `npm run build` — passed.

The existing suite covers unchanged candidate ranking, exact fee/depth math, management/close rules, fresh confirmation, fail-closed behavior, manual workflow boundaries, cache persistence/invalidation, pagination completeness, and provider advisory behavior.

## 10. Limitations and next measurement

- No live RPC or Alchemy billing data was queried.
- Replay observations do not execute full RPC enrichment.
- Exact physical-request counts depend on viem batching and provider transport behavior.
- Manual LP activity is intentionally not included.
- Cache hit rates by chain and workflow are not yet persisted/exported for longitudinal analysis.

Before Phase 3 implementation, run one bounded autonomous observation window with process-role-separated telemetry and collect:

`chain, workflow, candidate/position id, method, logical, physical, retries, fallback, cache state, log range, splits, latency, and error class`.

Then compare cold/warm candidates and one-versus-three-position management ticks. Keep the agent stopped unless explicitly authorized for that measurement, and do not use live funds or transactions.

## Conclusion

Phase 1–2 preserve all required safety boundaries and demonstrably eliminate selected immutable rework. The strongest measured wins are creation-evidence and metadata cache hits; the Phase 2 boundary cache is correct but likely lower-yield until repeated same-cycle observations are observed. The next safe optimization is observation-local deduplication of event-block historical reads, validated by telemetry before and after.
