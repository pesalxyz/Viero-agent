# Viero autonomous RPC optimization — Phase 1 implementation

Status: implemented and validated locally only. No VPS deployment, service restart, autonomous activation, funded test, or blockchain transaction was performed.

## Scope

This batch implements only the first safe optimizations from the RPC optimization plan:

1. bounded, best-effort RPC telemetry for autonomous workflows;
2. verified immutable ERC-20 metadata caching (decimals and symbol);
3. verified pool creation-time evidence caching.

Current-state values such as liquidity, tick, price, balances, fee growth, and position state remain uncached.

## Files changed

- `src/viero/observability/rpcTelemetry.ts` — workflow-scoped logical/physical operation aggregation, retries/fallbacks, latency/errors, candidate and management counters, and cache counters.
- `src/viero/storage/evidenceCache.ts` — atomic, mode-600 persistent JSON evidence cache with serialized access and fail-closed invalidation.
- `src/viero/clients/publicClients.ts` — instruments viem transports without changing request arguments, fallback order, retry policy, or response handling.
- `src/viero/adapters/pools.ts` — binds token metadata cache entries to verified bytecode hashes and the pinned verification block.
- `src/viero/adapters/events.ts` — caches exact pool creation block/timestamp only with a canonical creation-block hash and revalidates that hash on reuse.
- `src/viero/workers/screeningWorker.ts` — labels autonomous preflight, discovery, verification, observation, management, and confirmation workflows and records candidate/management counters.
- `tests/rpcOptimization.test.ts` — Phase 1 regression coverage.
- `docs/audits/viero-autonomous-rpc-phase1-implementation.md` — this report.

## Design and safety decisions

Telemetry is deliberately non-blocking and bounded to 2,048 operation rows per process. It never records URLs, request payloads, credentials, private keys, or response bodies. Physical HTTP attempts are observed through viem fetch hooks; the RPC method is available for logical calls and is otherwise recorded as `unknown`. A failed telemetry update is swallowed so telemetry cannot alter trading behavior.

Token metadata is keyed by `(chainId, lowercase token address)` and accepted only when the current, block-pinned bytecode hash matches the cached verified hash. A mismatch deletes the entry and forces a fresh read. No price, liquidity, balance, tick, or fee-growth data is cached.

Pool creation evidence is keyed by `(chainId, canonical pool identity)`. On every cache hit the creation block is read again and its canonical block hash is compared with the stored hash. A missing block, missing hash, hash mismatch, or identity mismatch invalidates the entry and recomputes the bounded binary search. The cache is written through a temporary mode-600 file followed by an atomic rename; concurrent access is serialized in-process.

Existing fresh block-pinned verification, pool identity checks, reorg/fail-closed behavior, policy decisions, signer authorization, and manual LP paths are unchanged.

## Deterministic validation

Local validation completed successfully:

- `npm run typecheck` — passed.
- `npm test` — **455 passed, 1 skipped, 0 failed** (456 total).
- `npm run build` — passed.

The new regression tests cover:

- token cache miss, persistence, hit, and bytecode identity invalidation;
- pool creation cache hit, canonical block-hash reorg invalidation, and recomputation;
- corrupted/missing cache recovery and concurrent writes;
- bounded telemetry, workflow/chain/method attribution, retries/fallback counters, latency/error recording, candidate/management counters, and cache counters.

The existing suite continues to cover unchanged candidate selection, management/close decisions, independent fresh confirmation, block-pinned verification, and authorization boundaries. No test uses a live RPC endpoint or sends a transaction.

## Deterministic logical RPC comparison

The cache changes only immutable evidence reads. For a verified pool whose two token bytecode identities are unchanged, the deterministic verification path remains two bytecode reads plus the normal pool-state reads, while the four metadata calls (two `decimals` and two `symbol`) become cache hits after the first observation. Pool creation evidence changes from a binary-search sequence of historical existence reads plus the creation-block read to one canonical creation-block hash read on a valid cache hit. These are logical test-path counts, not Alchemy compute-unit measurements; no real CU savings are claimed here.

## Invalidation rules

- token bytecode hash differs: delete and miss;
- pool creation block hash differs or cannot be read: delete and recompute;
- cached identity/chain key does not match the request: miss;
- malformed, missing, or unsupported-version cache file: start empty and fail closed;
- cache write failure: the current RPC operation remains authoritative; the cache is not treated as evidence.

## Known limitations

- viem’s fetch hooks do not expose a reliable RPC method for every physical HTTP attempt, so some physical rows are attributed to `unknown`; logical methods remain recorded.
- Retry counters observe configured transport fallback attempts and do not claim to distinguish every internal viem retry from a provider-side retry.
- The cache is process-local serialized and file-atomic, but it is not a multi-host coordination protocol. If multiple independent hosts share a cache file, use separate files or an external lock.
- Cache files are intentionally runtime data under the ignored `data/` directory and are not part of release source.
- Actual Alchemy CU, latency, and provider savings require production measurement after explicit approval; mocked tests cannot establish those values.

## Deployment and rollback

No deployment was performed. Before deployment, review the diff and approve a production rollout explicitly. A normal release should package the source/build and restart only the autonomous services selected by the operator; manual LP services must remain untouched. Rollback is the prior release bundle plus removal/disablement of the Phase 1 cache file if desired. Removing the cache is safe: the next run recomputes evidence. Do not delete unrelated runtime state.

## Production measurement plan

After approval and a controlled rollout, collect bounded telemetry snapshots separately for each autonomous process role. Compare candidate observations, management ticks, logical operations, physical attempts, fallback/retry counts, cache hit/miss/invalidation rates, and latency/error totals by chain and method. Compare equivalent windows before and after rollout while keeping screening cadence, enabled chains, and candidate population stable. Validate that fresh confirmation and fail-closed behavior remain intact before attributing any provider-level CU change.
