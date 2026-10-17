# Viero autonomous RPC optimization plan

**Audit date:** 2026-10-15 (Asia/Jakarta)
**Scope:** autonomous Viero workflows only. Manual LP operations are intentionally out of scope and are not changed or optimized.
**Mode:** source-level audit and design only. No runtime code, production configuration, service, manual bot, or blockchain state was changed.

## Evidence labels and assumptions

- **CONFIRMED:** directly visible in the checked-in source.
- **CODE-INFERRED:** derived from source control flow; not measured against a live provider.
- **ESTIMATE:** arithmetic based on logical call counts, not Alchemy billing units.
- **SAFETY-CRITICAL:** must remain fresh or independently verified.

The Alchemy historical reports show an 83.42% account-level CU/day decrease after autonomous shutdown, while manual LP continued. That supports autonomous workflows as the dominant incremental consumer, but this document does not assign account CU to manual operations.

## 1. Autonomous RPC call graph

```text
five-minute watch cycle
  -> GMGN token-first discovery (normally no EVM RPC)
  -> selected candidate only
     -> pool shortlist / V3 factory or V4 identity recovery
     -> smoke preflight (first use per chain)
     -> verifyPool(block-pinned)
     -> prices/risk (external providers)
     -> targetedRpcObservation
        -> exactPoolCreatedAt binary search
        -> firstBlockAt binary search
        -> swap/protocol-fee logs
        -> per-event block + slot + transaction reads
        -> depth bitmap/tick reads
        -> balances + final reorg hash check
     -> deterministic screen/plan/simulation
     -> signer write only after policy approval

five-minute position management
  -> verifyPool(block-pinned)
  -> token prices (external)
  -> V3/V4 exact fee-growth reads
  -> entry receipt/transaction basis reconciliation
  -> policy decision
  -> independent fresh confirmation before signer handoff
  -> close/claim/normalize reads and receipts if triggered
```

Primary source locations:

- Watch cadence and management handoff: `src/viero/cli.ts:94-170`, `src/viero/workers/screeningWorker.ts:930-1070`.
- Candidate handoff: `src/viero/workers/screeningWorker.ts:452-655`.
- Pool verification and metadata: `src/viero/adapters/pools.ts:5-69`.
- Historical observation: `src/viero/adapters/events.ts:40-192`.
- Pool identity recovery: `src/viero/adapters/targetedPoolDiscovery.ts:180-520`.
- Public transport/retries/batching: `src/viero/clients/publicClients.ts:5-38`.

## 2. Call inventory and optimization classification

| Component/function | Trigger/frequency | Logical operations per invocation | Data class | Safe treatment |
|---|---|---:|---|---|
| `smokeTest()` / `assertChain()` / `requireCode()` | First candidate per chain; agent and Telegram preflight on service start | 1 `eth_chainId` + 1 block + one `eth_getCode` per deployment (7 on 4663/8453/5042; 10 on BNB) | Deployment identity, mostly immutable | Share a short-lived block-pinned result across autonomous processes; preserve freshness/error checks |
| `verifyPool()` V3 | Selected candidate or each management tick | ~16 logical reads: chain/head/block, 2 code, 4 pool metadata, factory identity, slot/liquidity, 4 token metadata | Current state + immutable metadata | Cache token metadata and verified factory identity; retain fresh block/slot/liquidity and identity check |
| `verifyPool()` V4 | Selected candidate or each management tick | ~14–16: chain/head/block, 2 code, StateView slot/liquidity, 4 token metadata, hook/PoolId checks | Current state + immutable metadata | Cache token metadata; retain current StateView reads and PoolId/hook validation |
| `exactPoolCreatedAt()` | Every `targetedRpcObservation()` | Initial existence check + ~log2(block) `eth_getBytecode`/V4 slot reads + final block timestamp | Historical/immutable after initialization | Cache by verified pool identity and creation block; revalidate block hash, not every candidate |
| `firstBlockAt()` | Every `rpcObservation()` | ~log2(head) `eth_getBlock` timestamp reads | Historical chain-time mapping | Reuse a per-chain `(head/windowStart)` result during one cycle; retain block pinning |
| Swap/protocol-fee `pagedLogs()` | Every selected-candidate full observation | At least 2 log queries; more if capped/erroring | Historical event evidence | Tune page size from telemetry; never accept partial logs |
| Per-swap event reads in `rpcObservation()` | One set per unique event block/hash | One block timestamp + one historical slot + one transaction per unique block/hash; up to 20 concurrent | Historical, required for metrics | Deduplicate block/hash reads; cache within observation and short-lived cycle scope |
| `readDepthTicks()` | Every full candidate observation | One bitmap read per 256-word + one tick read per initialized tick | Block-pinned safety evidence | Keep complete evidence; avoid re-reading the same word/tick within one observation |
| V3 TVL balances | Every full candidate observation | 2 ERC-20 `balanceOf` calls | Block-pinned economics | Keep at selected block; do not use stale balances for screening |
| Final reorg check | Every full candidate observation | 1 `eth_getBlock` | Safety-critical | Never remove |
| `attachV4Fees()` | Every management tick/card enrichment | 2 StateView `eth_call`s | Fresh exact fee evidence | Keep fresh; share with the same observation used by card/management |
| `attachV3Fees()` | Every management tick/card enrichment | NFPM `positions` + 4 fee/tick calls | Fresh exact fee evidence | Keep fresh; share observation; do not estimate fees |
| `actualEntryPrincipalUsd()` | Every management observation and enrichment fallback | 1 receipt, optionally 1 transaction lookup | Confirmed immutable entry basis | Persist once after success; reuse immutable result unless receipt evidence is absent |
| `observeManagementPosition()` fallback | PnL evidence unavailable; up to two bounded retries | Repeats lightweight + fee/entry reads, then full enrichment path | Fresh safety/evidence | Keep bounded fail-closed retry; instrument and avoid retrying known immutable failures |
| Independent close confirmation | Only proposed close | A complete fresh management observation plus decision | Safety-critical | Never eliminate or use stale cycle data at signer handoff |
| Transport fallback/retry | Any RPC error/timeout | Up to `retryCount: 2` per HTTP transport plus fallback URLs | Physical amplification | Instrument attempts; tune timeouts/ranges, but retain bounded retry/failover |

The counts are logical viem operations. HTTP batching can reduce physical requests; fallback and retry can increase them.

## 3. Top 10 expensive or redundant patterns

1. **Per-candidate `exactPoolCreatedAt()` binary search.** A ~100M-block head means roughly 27 historical existence calls plus a timestamp read. It is historical and reusable after verified identity.
2. **Per-candidate `firstBlockAt()` binary search.** Another ~27 block timestamp reads for the same chain/window; reusable when multiple candidates share a cycle/head.
3. **Historical log pagination without measured page sizing.** `pagedLogs()` starts at 1,000 blocks and recursively halves on caps/errors, potentially multiplying calls.
4. **Per-swap duplicate block reads.** Event blocks are deduplicated by set, but the same block can still be read independently in timestamp and other paths unless scoped caching is introduced.
5. **Per-swap historical slot reads.** Required for protocol-fee interpretation, but can be cached once per event block/pool within the observation.
6. **Per-swap transaction lookups.** Required for trader extraction, but deduplication by transaction hash should be explicit and observable.
7. **Repeated token `decimals`/`symbol` reads.** `verifyPool()` reads both for every candidate/management tick despite immutable token identity.
8. **Repeated entry receipt/transaction reads.** Management, card enrichment, and fallback paths can all call `actualEntryPrincipalUsd()` for the same immutable entry hash.
9. **Repeated V3/V4 verification between cycle snapshot and management.** A cycle observation can be available, but fallback/confirmation can re-read metadata and state. Reuse is safe only before the independent close confirmation boundary.
10. **Fallback/retry amplification.** `retryCount: 2`, multiple configured HTTP transports, and capped log retries can turn one logical call into several provider requests.

## 4. Candidate-enrichment opportunities

### 4.1 Cache immutable verified metadata

Cache token metadata keyed by `(chainId,address,bytecodeHash)` and verified factory/pool identity keyed by `(chainId,poolId/poolAddress,identityBlockHash)`. Reuse decimals, symbol, token ordering, factory match, and recovered PoolKey. Invalidate on bytecode or identity mismatch.

**Expected savings (estimate):** 4 token metadata calls per `verifyPool()` plus repeated identity reads per candidate/management refresh. If 10 candidates are enriched in a day, this removes roughly 40 logical calls before batching/retries.

### 4.2 Reuse creation evidence

Persist `poolCreatedAt` with the verified pool identity and the block hash used to establish it. A later observation can verify the current pool identity and reuse the historical timestamp instead of running `exactPoolCreatedAt()` again. Recompute only when identity, chain, or reorg evidence changes.

**Expected savings (estimate):** approximately 20–30 historical reads per full candidate observation. This is the highest-confidence small reduction because creation time is immutable once established.

### 4.3 Reuse cycle-scoped block-time mapping

Memoize `firstBlockAt(chain, headBlock, windowStart)` during one autonomous cycle. If multiple candidate observations share the same head/window, use the same boundary. Do not reuse across a changed head without an explicit block-hash/freshness key.

**Expected savings (estimate):** approximately 20–30 `eth_getBlock` calls per reused candidate.

### 4.4 Instrument and tune `pagedLogs()`

Record requested range, response row count, split count, error class, and final page count. Select a safe chain/provider page size from observed caps. Keep the current fail-closed rule: a capped/erroring page is subdivided, and partial logs are never accepted.

**Expected savings:** unknown until split telemetry exists; potentially large on ranges that repeatedly hit provider caps.

### 4.5 Bound candidate fan-out without weakening ordering

Continue external liquidity ordering and verify candidates in order. Avoid full historical observations for pools that already fail immutable identity, unsupported hook, quote, age, or bytecode checks. Only the selected verified pool needs expensive historical economics.

**Expected savings:** proportional to rejected pools skipped before event enrichment; requires preserving evidence for why each pool was skipped.

## 5. Position-management opportunities

### 5.1 Persist confirmed entry basis and receipt-derived owner

`actualEntryPrincipalUsd()` currently reads the receipt and may read the transaction during management/card paths. Once a confirmed receipt-derived principal and owner are persisted, subsequent management ticks can reuse them. On-chain current pool state, fee growth, price, and identity remain fresh.

**Expected savings (estimate):** 1 receipt plus possible 1 transaction lookup per position per tick. For 3 positions at 12 ticks/day, that is up to 36–72 logical calls/day before batching.

### 5.2 Share one lightweight observation

The cycle snapshot, Telegram card, and the first management decision should consume the same observation object/persisted projection. The independent confirmation must still execute a fresh read immediately before signer handoff.

**Expected savings:** one duplicate `verifyPool()`/fee set per position per cycle, depending on current scheduling and fallback behavior.

### 5.3 Keep fee reads fresh but avoid duplicate metadata

V4 `getFeeGrowthInside`/`getPositionInfo` and V3 NFPM/fee-growth reads are freshness-critical for fee-inclusive PnL. They may share token metadata and verified pool identity, but must not be replaced by stale fees or estimated values.

### 5.4 Do not cache policy-critical state

Current tick/sqrt price, liquidity, fee growth, prices, depth evidence, signer health, balances before writes, and the independent confirmation must remain fresh. Missing evidence must continue to suppress PnL-dependent actions or reject candidates.

## 6. Expected savings model

These are planning ranges, not provider billing promises. Let:

- `C` = selected candidate full observations/day.
- `P` = open positions.
- `R` = average retry/split amplification.
- `B` = physical-to-logical batching factor.

Approximate logical savings from the first safe batch:

```text
creation-cache:        C × 20–30
window-boundary reuse: (C−1) × 20–30  [only same chain/head/window]
entry receipt cache:   P × managementTicks × 1–2
metadata cache:        (candidate + management verifies) × 4–6
```

Physical CU savings are approximately the logical savings multiplied by observed method weights and `R/B`; neither is known from source alone. No autonomous/manual USD split is claimed.

## 7. Safety impact assessment

| Optimization | Safety impact | Required invariant |
|---|---|---|
| Immutable token metadata cache | Low | Key by chain/address and invalidate on bytecode mismatch |
| Persist creation timestamp | Low | Tie to verified pool identity and block hash; recompute on reorg suspicion |
| Cycle-scoped `firstBlockAt` cache | Low | Key by chain/head/window; never cross a changed head |
| Entry receipt/basis cache | Low | Only persist after confirmed receipt parsing; fallback to fresh read if missing |
| Log page-size tuning | Medium | Never accept capped/partial pages; retain complete evidence |
| Shared cycle observation | Medium | Independent fresh confirmation remains mandatory before signer handoff |
| Removing historical reads outright | High/unsafe | Not recommended unless equivalent verified evidence exists |
| Reducing retry count globally | High/unsafe | Not recommended; measure per-provider failures first |

## 8. Implementation priority

### P0 — instrumentation and cache design (no policy change)

Add read-only counters around the PublicClient transport and workflow boundaries. Record logical operation ID, chain, method, retry/fallback attempt, log range/splits, candidate ID, and position ID. Keep manual processes in a separate process-role namespace.

### P1 — immutable evidence reuse

Implement a repository-scoped cache for verified token metadata, PoolKey/factory identity, creation timestamp, and confirmed entry receipt/basis. Add block-hash/reorg invalidation and tests.

### P2 — cycle boundary and log efficiency

Memoize `firstBlockAt` within a cycle and tune `pagedLogs` based on measured split/error telemetry. Preserve complete-log and reorg checks.

### P3 — broader architecture

Only after measurement, consider a block-pinned normalized observation service/indexer for historical metrics. This is higher risk and must independently verify returned block hashes and identity.

## 9. Required tests and regression coverage

- Cache hit/miss and invalidation for token metadata, PoolKey, factory identity, and creation timestamp.
- Reorg or block-hash mismatch forces a fresh historical read.
- `firstBlockAt` cache is reused only for identical chain/head/window keys.
- `pagedLogs` preserves all rows, ordering, and fail-closed behavior under caps/errors.
- Duplicate event blocks/hashes issue one block/slot/transaction read each.
- Candidate ordering and selected-pool result are unchanged.
- Missing depth/fee/price evidence still rejects or suppresses policy decisions.
- Cycle Telegram snapshot and first management decision remain identical.
- Independent close confirmation still performs fresh reads and cannot consume a stale cached state.
- Entry receipt cache produces the same canonical basis/PnL as a fresh parse.
- Transport retry/fallback metrics are accurate and contain no URLs, keys, headers, or payload secrets.

## 10. Measurement strategy

Instrument only autonomous process roles (`agent`, `telegram-autonomous`, `indexer` if enabled), never the manual LP bot. For each logical operation record:

- chain ID;
- workflow (`preflight`, `candidate-discovery`, `candidate-verify`, `candidate-observation`, `management`, `confirmation`, `execution-receipt`);
- RPC method;
- logical operation count;
- physical request count when transport hooks expose it;
- retry/fallback attempt;
- log range, row count, and split count;
- candidate count and selected candidate;
- open-position count and operations per management tick;
- estimated Alchemy CU using a versioned method-weight table, explicitly labeled as an estimate.

Emit hourly aggregates locally without RPC URLs or credentials. Correlate with Alchemy hourly timeseries only after mapping the autonomous app/process. Do not issue extra live RPC calls merely to measure the current stopped deployment.

## 11. Recommended first implementation batch

The smallest safe code change is **immutable verified token metadata plus creation-time evidence reuse**, implemented behind a read-only cache with block-hash validation. It avoids approximately 20–30 historical existence reads and four metadata reads per applicable full observation, without changing screening thresholds, freshness-critical pool state, fee evidence, policy decisions, or signer authorization.

Do not begin by caching current tick, liquidity, prices, fee growth, depth, balances, or confirmation state. Those are required for correctness and close safety.

## Final recommendation

Instrument first, then implement P1 immutable evidence reuse. Candidate enrichment is the most likely excessive autonomous consumer because it combines binary historical searches, event pagination, per-event reads, and depth enumeration. Position management is the next target and should be optimized only around immutable entry/metadata evidence. Manual LP operations remain outside this plan.
