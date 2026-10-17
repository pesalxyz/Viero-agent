# Viero autonomous RPC — Phase 3C attribution and optimization design

**Date:** 2026-10-16
**Status:** audit/design only; no runtime implementation or deployment.

## Scope and evidence

This report attributes the Phase 3B.2 bounded read-only profile. The profile is an isolated reproduction of the relevant read paths, not a measurement of a live autonomous process. Its final run used one independently verified pool on BNB Chain (PancakeSwap V3) and one on Robinhood Chain (Uniswap V4), with a five-minute historical window.

Measured totals:

| Metric | Measured |
|---|---:|
| Physical/logical RPC attempts | 240 |
| Estimated CU | 5,824 |
| `eth_call` | 104 |
| `eth_getBlockByNumber` | 68 |
| `eth_getCode` | 33 |
| `eth_getLogs` | 14 |
| `eth_getTransactionByHash` | 11 |
| Retries/fallbacks | 0 / 0 |

CU values are method-weighted estimates, not provider billing. The harness did not record ABI selectors in its attempt rows, so function attribution below is reconstructed from the checked-in scenario code and the per-scenario logical deltas in `/tmp/phase3b-profile.json`.

## 1. Function-level `eth_call` attribution

### Cold verification before scenario A

The harness verifies both pinned pools before scenario A. This accounts for 14 calls:

| Chain | Contract/function | Calls | Purpose | Freshness |
|---|---|---:|---|---|
| BNB 56 | V3 pool `token0()` | 1 | canonical token identity | pinned block |
| BNB 56 | V3 pool `token1()` | 1 | canonical token identity | pinned block |
| BNB 56 | V3 pool `fee()` | 1 | fee-tier identity | pinned block |
| BNB 56 | V3 pool `tickSpacing()` | 1 | range/depth identity | pinned block |
| BNB 56 | V3 pool `slot0()` | 1 | current pinned price/tick | pinned block |
| BNB 56 | V3 pool `liquidity()` | 1 | active liquidity | pinned block |
| BNB 56 | token0/token1 `decimals()` | 2 | decimal normalization | immutable metadata, bytecode-bound |
| BNB 56 | V3 factory `getPool(token0,token1,fee)` | 1 | canonical factory relationship | pinned block |
| **BNB subtotal** |  | **9** |  |  |
| Robinhood 4663 | StateView `getSlot0(poolId)` | 1 | pinned price/tick/fee | pinned block |
| Robinhood 4663 | StateView `getLiquidity(poolId)` | 1 | active liquidity | pinned block |
| Robinhood 4663 | PositionManager `poolKeys(bytes25(poolId))` | 1 | complete PoolKey/PoolId identity | pinned block |
| Robinhood 4663 | currency0/currency1 `decimals()` | 2 | decimal normalization | immutable metadata, bytecode-bound |
| **Robinhood subtotal** |  | **5** |  |  |
| **Total** |  | **14** |  |  |

These are not equivalent reads: the identity and factory checks authorize later observations, while slot/liquidity reads establish the pinned state used by depth and event windows. The four decimal calls are the only metadata-shaped calls and are candidates for the existing Phase 1 verified token cache; the isolated harness intentionally does not import that runtime cache.

### Scenario B: cold creation evidence

| Chain | Function | Calls | Purpose | Classification |
|---|---|---:|---|---|
| BNB 56 | V3 pool `getBytecode` at historical blocks | 0 `eth_call` (28 `eth_getCode`) | binary-search deployment block | historical immutable evidence |
| Robinhood 4663 | StateView `getSlot0(poolId)` at historical blocks | 28 | binary-search pool initialization | historical state evidence |

The Robinhood 28 calls are the largest single `eth_call` cluster. They are not current fee, price, or depth reads and are already covered by the Phase 1 creation-evidence cache after a successful canonical creation-block check.

### Scenarios H and I: initialized-tick depth

| Chain | Scenario | Function | Calls | Purpose | Freshness |
|---|---|---|---:|---|---|
| BNB 56 | H | V3 `tickBitmap(word)` | 2 | discover initialized ticks in exact ±1% envelope | pinned state |
| BNB 56 | H | V3 `ticks(tick)` | 22 | read initialized tick liquidity | pinned state |
| BNB 56 | I | same two functions | 24 | repeated observation | pinned state; not cached |
| Robinhood 4663 | H | StateView `getTickBitmap(poolId,word)` | 1 | discover initialized ticks | pinned state |
| Robinhood 4663 | H | StateView `getTickLiquidity(poolId,tick)` | 6 | read initialized tick liquidity | pinned state |
| Robinhood 4663 | I | same two functions | 7 | repeated observation | pinned state; not cached |
| **Total** |  |  | **62** |  |  |

The depth reads are safety/economics-critical. Reusing them across cycles or across a changed pinned head would make depth stale and is a no-go optimization.

### Complete `eth_call` accounting

| Source | BNB | Robinhood | Total |
|---|---:|---:|---:|
| Pinned verification/state/identity | 9 | 5 | 14 |
| Cold creation search | 0 | 28 | 28 |
| H depth | 24 | 7 | 31 |
| I repeated depth | 24 | 7 | 31 |
| **Total** | **57** | **47** | **104** |

## 2. Historical block-read attribution

The 68 `eth_getBlockByNumber` calls are fully accounted for:

| Source | Calls | Evidence role | Existing overlap |
|---|---:|---|---|
| Pinned verification block | 2 | canonical pinned hash/timestamp, one per pool | required fresh pinned check |
| Scenario C creation-cache validation | 2 | re-read cached creation block hash, one per pool | Phase 1 cache-hit validation |
| Scenario D boundary binary searches | 54 | 27 reads per chain for exact five-minute boundary | Phase 2 cycle-scoped boundary cache; first lookup remains required |
| Scenario G event-block reads | 8 | four unique event blocks per chain | Phase 3A observation-local memo can avoid equivalent repeats |
| **Total** | **68** |  |  |

There were no additional block reads for a separate reorg pass. Reorg protection is represented by the pinned hash check, the creation-cache hash check, and the event/block identity checks in the underlying design. The 54 boundary reads are logarithmic binary-search work, not duplicate reads; repeated same-cycle requests are already handled by the Phase 2 boundary cache.

## 3. Bytecode-read attribution

The 33 `eth_getCode` calls are not token metadata calls:

| Source | Calls | Chain | Assessment |
|---|---:|---|---|
| `verifyPool()` pool/factory bytecode | 2 | BNB | fresh contract identity verification at pinned block |
| `verifyPool()` PoolManager/PositionManager/StateView bytecode | 3 | Robinhood | fresh deployment identity verification at pinned block |
| BNB cold creation binary search | 28 | BNB | historical pool existence/deployment evidence |
| **Total** | **33** |  |  |

Phase 1 token metadata caching covers verified ERC-20 `decimals`/`symbol`, not pool or deployment bytecode. No bytecode reads are hidden by that cache. The five verification reads could only be removed by a separately governed deployment-evidence policy. That policy would need to detect proxy/upgradable code changes and reorgs; the current audit has insufficient evidence to claim that reuse is safe. The 28 historical BNB reads are already avoided on a valid Phase 1 creation-evidence cache hit.

## 4. Logs and transaction reads for attribution context

- BNB E/I: one swap-log page each; F is explicitly skipped for the selected PancakeSwap V3 path.
- Robinhood E: three swap-log pages; F: three protocol-fee-log pages; I repeats six pages.
- G reads four unique event blocks and four transaction objects on BNB, and four event blocks and seven transaction objects on Robinhood.

`pagedLogs()` completeness, split behavior, event ordering, and transaction identity must remain unchanged. The profile observed no retries, fallbacks, natural row-cap splits, or provider errors.

## 5. Existing Phase 1–3A overlap

| Optimization already present | Evidence in profile/design | New savings available here? |
|---|---|---|
| Verified token metadata cache | Phase 1 bytecode-bound decimals/symbol cache | The isolated harness still counts four decimals; full runtime warm paths can avoid them. Do not double-count as Phase 3C. |
| Verified pool creation cache | BNB avoids 28 historical code reads; Robinhood avoids 28 historical slot calls after cold evidence | Already realized on warm reuse; C still performs one canonical hash read by design. |
| Cycle-scoped boundary cache | D is one exact binary search per pinned head/window | No safe saving from another cross-cycle cache. |
| Observation-local historical memo | G can share equivalent event-block/state/transaction reads within one observation | Existing Phase 3A scope; no new cross-observation reuse is justified. |
| Bounded log telemetry/pagination | E/F/I preserve complete pages | Instrumentation only; changing page semantics is out of scope. |

## 6. Before/after modeling

The following values are deterministic replay/model values, not provider billing:

| Path | Logical operations | Estimated CU | Status |
|---|---:|---:|---|
| Phase 3B.2 final cold+warm profile | 240 | 5,824 | measured by isolated harness |
| Profile excluding deliberate repeated-observation scenario I | 202 | 4,598 | replayed by subtracting I: BNB 25 operations/684 CU and Robinhood 13 operations/542 CU |
| Same first-observation path with Phase 1 creation evidence already warm | 146 | 3,310 | modeled by removing the 56 cold creation probes; canonical creation-block validation remains |
| Same path plus Phase 1 verified metadata hits | 142 | 3,206 | modeled by removing four decimal reads (104 CU); the isolated harness does not exercise this runtime cache |
| Same profile with both creation searches already warm | 184 | 4,536 | replayed counter arithmetic: remove 28 BNB `eth_getCode` probes (560 CU) and 28 Robinhood historical `eth_call`s (728 CU); canonical cache validation remains required |
| Full-runtime warm metadata path | profile-dependent | up to 4 fewer logical decimal reads | modeled from Phase 1 cache contract; harness does not exercise runtime cache |
| Proposed cross-cycle depth/state cache | lower | lower | rejected: freshness/safety violation |

The 202/146/142 rows are scenario arithmetic, not production baselines. The 184 row is also a replay model for the complete harness aggregate after removing both cold searches; it is not a per-cycle autonomous cost. A valid Phase 1 creation cache does not eliminate the canonical creation-block hash validation read; it eliminates the historical binary-search probes. The profile itself deliberately includes both a cold search and a warm validation scenario, so its 240 calls must not be used as a per-cycle autonomous cost without workload frequency assumptions.

For a repeated observation inside one pinned cycle, the measured I scenarios still issue 24 BNB and 7 Robinhood `eth_call`s for depth and repeat their logs. That is expected: Phase 1–3A do not cache mutable depth or complete event history. The measured warm scenario therefore demonstrates correctness, not a promised CU reduction.

## 7. Safety assessment and explicit no-go optimizations

Do not:

1. Cache `slot0`, active liquidity, fee growth, balances, initialized tick bitmap/tick liquidity, or prices across cycles.
2. Skip complete `pagedLogs()` pages, reduce historical ranges without a completeness proof, or replace logs with advisory DEX data.
3. Reuse PoolKey/PoolId or hook verification across an unpinned head without canonical identity checks.
4. Remove the fresh independent confirmation before signer handoff.
5. Share observation memos across positions, management ticks, authorization boundaries, or processes.
6. Treat deployment bytecode as permanently immutable without a proxy/upgrade policy and reorg-aware revalidation.
7. Replace exact LP-net fee/depth calculations with cached or estimated values.

These would reduce apparent RPC use but weaken identity, economics, reorg, or authorization guarantees.

## 8. Decision

**Decision: C — stop additional RPC optimization for now.**

The profile shows that the only large historical-search clusters are already addressed by Phase 1 creation caching and Phase 2/3A observation-local/boundary memoization. The remaining 62 depth calls, 14 pinned identity/state calls, 54 first-boundary reads on a cold pinned cycle, complete log pages, and fresh deployment checks are either freshness-critical or require additional production telemetry before any safe reduction can be quantified. The four metadata calls are already covered by Phase 1 in the full runtime and should not be counted again as a Phase 3C opportunity.

No additional runtime cache has been implemented. If optimization is revisited, first collect autonomous runtime telemetry by workflow/chain for multiple comparable cycles and separately measure cache hits, invalidations, provider splits, and candidate/position counts. Approval is required before any Phase 3C code change.

## Validation and boundaries

This audit changed documentation only. No autonomous service, management loop, signer, executor, scheduler, indexer, or manual LP workflow was started. No deployment, restart, configuration change, or blockchain transaction occurred.

The Phase 3B.2 validation remains the evidence baseline: offline safety self-tests passed; typecheck passed; 460 tests passed, 1 skipped, 0 failed; build passed. This report does not claim Alchemy-billed USD savings.
