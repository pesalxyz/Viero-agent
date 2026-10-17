# Viero autonomous RPC optimization — Phase 3A implementation

**Date:** 2026-10-15
**Status:** implemented and validated locally only. No deployment, service restart, autonomous activation, manual LP change, or blockchain transaction was performed.

## Scope

This batch adds bounded, observation-local deduplication for historical event-block metadata, historical pool state, and transaction lookups. It does not change pagination, screening, management policy, fee/depth math, signer authorization, or independent confirmation.

## Files changed

- `src/viero/adapters/events.ts`
  - Added `ObservationRpcMemo`, scoped to one `rpcObservation()` call.
  - Memoized equivalent block, historical state, and transaction reads only when a canonical event block hash is available.
  - Deduplicated concurrent identical requests by sharing the in-flight promise.
  - Removed failed/nullish entries instead of caching incomplete evidence.
  - Added capacity-bounded eviction and explicit invalidation.
  - Added block-hash consistency checks; mismatch fails closed with `REORG_DURING_OBSERVATION`.
  - Reused memoized event-block timestamps, slot/state reads, and transaction sender reads without changing event ordering or fee calculations.
- `src/viero/observability/rpcTelemetry.ts`
  - Added bounded counters for block/state/transaction memo hits and misses, logical reads avoided, invalidations, and evictions.
- `tests/rpcOptimization.test.ts`
  - Added concurrent deduplication, distinct-identity, failure, capacity, eviction, and invalidation fixtures.
- `docs/audits/viero-autonomous-rpc-phase3a-implementation.md`
  - This report.

## Deduplication design

`ObservationRpcMemo` is created for each historical observation and is never shared across cycles, positions, management ticks, or signer boundaries. The maximum size defaults to 128 entries and uses bounded insertion-order eviction.

Keys are:

- block metadata: `chainId + blockNumber + event block hash`;
- historical state: `chainId + contract + function/arguments + historical block number + block hash`;
- transaction lookup: `chainId + transaction hash + event block hash`.

If the event does not carry a usable block hash, the read is performed directly rather than being cached. This avoids weakening block identity semantics.

Only successful, non-nullish results remain cached. Failed RPC calls are removed immediately. Concurrent callers for an equivalent key share the same promise, so only one physical/logical read is issued.

The final pinned-head hash check remains unchanged. Additionally, when a returned event block or transaction exposes a block hash that differs from the event identity, the observation invalidates its memo and fails closed. The memo is discarded with the observation after any error.

No latest-state, price, liquidity, fee-growth, depth, balance, signer-health, or confirmation read is cached.

## Actual duplicate patterns and measured scope

The current `rpcObservation()` already uses `Set`/`Map` structures for event blocks and transaction hashes. That means the normal path already avoids one obvious duplicate per repeated event in the same block. Phase 3A does not pretend to remove work that was already absent.

Phase 3A adds a defensive identity-aware memo for equivalent historical reads when multiple observation subpaths converge, when callers invoke equivalent reads concurrently, and for future observation-local reuse. Different blocks, contracts, functions, arguments, transaction hashes, or block identities do not collide. The existing transaction-hash `Set` remains in place; Phase 3A adds block-identity validation and in-flight/result sharing without changing transaction semantics.

Consequently, the synthetic duplicate fixtures demonstrate the memo's behavior, but the exact hit rate in the current single-path `rpcObservation()` is expected to be low until live telemetry shows additional convergence. This is intentional: no extra stale or cross-observation cache was introduced merely to manufacture savings.

## Deterministic before/after counts

The new fixtures use equivalent mocked reads and report logical operations, not Alchemy compute units:

| Fixture | Before deduplication | Phase 3A | Result |
|---|---:|---:|---|
| Two concurrent identical event-block reads | 2 | 1 | 1 read avoided; 1 memo hit |
| Two equivalent transaction lookups | 2 | 1 | 1 read avoided; 1 memo hit |
| Two distinct historical state identities | 2 | 2 | no unsafe collision |
| Failed read repeated | 2 attempts | 2 attempts | failures are not cached |
| Capacity of 2, then third key | 3 | 3 | oldest entry evicted; no stale reuse |
| Explicit reorg invalidation | cached entry | invalidated | subsequent read must recompute |

Full historical candidate counts remain provider- and event-dependent. The suite does not claim a production percentage reduction because replay fixtures do not perform live `verifyPool()`/historical enrichment. The safe production expectation is one logical read avoided per equivalent duplicate event-block/state/transaction key, subject to block-hash availability.

## Telemetry

`RpcTelemetry.snapshot().historicalMemo` now contains:

- `blockHits`, `blockMisses`;
- `stateHits`, `stateMisses`;
- `transactionHits`, `transactionMisses`;
- `logicalReadsAvoided`;
- `invalidations`;
- `evictions`.

Counters contain no URLs, credentials, request payloads, private keys, log bodies, or transaction payloads. The memo is local and bounded; telemetry failures remain swallowed and cannot alter RPC behavior.

## Safety and reorg assessment

- Memo scope ends with the observation.
- No memo is used across signer authorization or independent close confirmation.
- Unknown block identity bypasses caching.
- Failed/incomplete reads are not retained.
- A conflicting event block hash, returned block hash, or returned transaction block hash fails closed.
- Final canonical head/hash validation remains mandatory.
- `pagedLogs()` still requires complete recovery and retains its existing split/error behavior.
- Exact LP-net fee calculations, initialized-tick depth, candidate ranking, management decisions, and signer authorization are unchanged.
- Manual LP workflows are untouched.

## Validation

Commands completed successfully:

- `npm run typecheck` — passed;
- `npm test` — **460 passed, 1 skipped, 0 failed** (461 total);
- `npm run build` — passed.

The full existing suite remains green, including candidate selection, exact V3/V4 fee math, depth, management/close decisions, fresh confirmation, fail-closed behavior, and authorization boundaries.

## Remaining RPC cost drivers

1. `pagedLogs()` swap/protocol-fee scans and recursive provider splits;
2. cold or invalidated `exactPoolCreatedEvidence()` searches;
3. initialized tick bitmap/tick reads for executable depth;
4. fresh `verifyPool()` and fee-growth reads across management/card paths;
5. transport retry/fallback amplification;
6. final independent confirmation and receipt reconciliation.

These remain safety-critical or require live telemetry before further optimization.

## Rollback

No production rollout occurred. A future rollback is a release-bundle rollback to the prior version. Locally, reverting the changes in `events.ts`, `rpcTelemetry.ts`, and `tests/rpcOptimization.test.ts` removes Phase 3A; no persisted trading state or manual-LP state is affected.

## Recommendation

Phase 3A is the smallest safe next batch: it removes equivalent historical reads without sharing state across observations or relaxing evidence requirements. Before any further optimization, collect a bounded autonomous window of memo hit/miss and `pagedLogs` split telemetry by chain/workflow. The next candidate should be selected only if that data demonstrates material duplicate reads beyond this observation-local scope.
