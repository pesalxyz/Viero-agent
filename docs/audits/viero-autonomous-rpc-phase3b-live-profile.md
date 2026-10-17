# Viero autonomous RPC — Phase 3B live profiling

**Date:** 2026-10-15
**Mode:** bounded, read-only preflight only. No autonomous service, scheduler, management loop, signer, executor, manual LP bot, or transaction was started.

## Result

The configured Alchemy endpoints were reachable and returned the expected chain IDs. The actual pool-profiling scenarios were **not run** because the repository contains no explicit, non-synthetic, previously verified pool manifest suitable for a live read-only experiment. The harness refused to discover or infer a pool, as required.

This is a safe stop, not evidence of zero RPC consumption.

## Preflight

Local controls reported `globalPaused: true`; no Viero runtime process was running in the local workspace. The operator context stated that the manual LP process was inactive; this local audit did not modify or start it. Remote service state was not changed.

The one-shot harness read endpoint values internally and never printed them. It performs only the allowlisted JSON-RPC methods and redacts errors to method/status information.

| Chain | Chain ID result | Head read | Status |
|---|---:|---:|---|
| Robinhood | `0x1237` (4663) | succeeded | ready for profiling if a verified pool is supplied |
| BNB | `0x38` (56) | succeeded | ready for profiling if a verified pool is supplied |
| Base | `0x2105` (8453) | succeeded | ready for profiling if a verified pool is supplied |
| Arc | `0x13b2` (5042) | succeeded | ready for profiling if a verified pool is supplied |

The checked-in `data/viero/runs` records are replay/synthetic fixtures (for example, `verification: synthetic-replay-fixture` and placeholder identities). They are not acceptable live pool identities. The persistent evidence cache has token entries but no reusable creation evidence or live pool manifest.

## Harness and budget gate

Created isolated harness:

`scripts/audits/phase3b-live-profile.mjs`

It does not import autonomous runtime code. It:

- reads configured endpoints without logging them;
- permits only read-only methods;
- reserves CU and attempt budget before dispatch;
- counts every physical request;
- enforces 500 attempts, 50,000 estimated CU, 15 minutes, concurrency limit 2, and one-retry maximum;
- refuses broad discovery and requires an operator-supplied `VIERO_PHASE3B_POOLS_FILE` manifest;
- emits only redacted method/chain/status/latency information.

Actual preflight consumption:

| Metric | Result |
|---|---:|
| Physical attempts | 8 |
| Estimated CU | 40 |
| Retries | 0 |
| Fallback attempts | 0 |
| Runtime | ~1.1 seconds |

The estimate uses Alchemy's official method table: `eth_chainId` = 0 CU and `eth_blockNumber` = 10 CU. See [Alchemy Compute Unit Costs](https://www.alchemy.com/docs/reference/compute-unit-costs) and [Compute Units](https://www.alchemy.com/docs/reference/compute-units). These are estimates, not billed usage.

## Selected pools and skipped scenarios

No pool was selected on any chain. Accordingly, scenarios A–I were skipped:

- pool identity verification;
- cold creation evidence;
- warm creation cache hit;
- exact first-block boundary;
- swap-log pagination;
- protocol-fee-log pagination;
- historical event-block and transaction reads;
- initialized tick/depth reads;
- repeated warm-cache observation.

Reason: no explicit, previously verified live pool identity was available without performing discovery or guessing from synthetic fixtures. Running a guessed pool would violate the identity and safety requirements.

## Alchemy usage reconciliation

The official `alchemy` CLI was not installed in this local environment, so no provider usage/billing snapshot was available after the preflight. No provider-reported CU or USD amount is claimed. The 40-CU figure above is only a method-weighted estimate for eight preflight requests.

The preflight cannot separate this account's traffic from other clients, and no billing attribution is attempted.

## Cache and pagination assessment

No cache effectiveness or natural pagination behavior could be measured live because the expensive scenarios were correctly skipped. Phase 1–3A deterministic tests remain the evidence for cache correctness, memo invalidation, and complete pagination recovery. No artificial provider errors or forced splits were generated.

## Current cost-driver assessment

The live experiment did not rank candidate costs. Based on the prior source and deterministic audits, the remaining candidates are:

1. `eth_getLogs` swap/protocol-fee history and natural provider splits;
2. `eth_call` depth/state and exact fee reads;
3. historical block lookups for event timestamps and window boundaries;
4. `eth_getCode`/identity verification on cold pools;
5. retry/fallback amplification and management confirmation reads.

These remain hypotheses until a verified-pool run produces method-level counters.

## Validation

- `npm run typecheck` — passed;
- `npm test` — **460 passed, 1 skipped, 0 failed** (461 total);
- `npm run build` — passed.

No production runtime or manual LP code was modified.

## Next safe action / Phase 3C recommendation

Supply a small, separately verified manifest containing at most one live pool per chain, with chain, protocol, canonical pool identity/PoolKey, and the verification block/hash. Then rerun the one-shot harness with the same gate. Do not use DEX Screener/Gecko hints or synthetic replay identities as execution truth.

Only after that run should Phase 3C be considered. The first optimization candidate should be whichever of natural `eth_getLogs`, `eth_call`, or historical block reads is confirmed by the bounded profile, while preserving complete logs, exact fees/depth, block-hash checks, and independent fresh confirmation.

## Phase 3B continuation — manifest search result

The continuation search inspected all persisted run observations and available evidence files for chains 4663 and 56. Five unique pool identities were found in the local records, but every one was rejected as synthetic or placeholder evidence. The records are marked `synthetic-replay-fixture`, use placeholder pool/token addresses, or carry synthetic transaction/block hashes. There were no non-synthetic position-history receipts, live pool verification records, or complete real V4 PoolKeys for these target chains. The persistent evidence cache contained token metadata but no creation evidence suitable for this run.

Therefore:

- verified manifest entries created: **0**;
- Robinhood profiling scenarios: **not run**;
- BNB profiling scenarios: **not run**;
- additional live RPC calls after the original preflight: **0**;
- no identity verification was attempted against a guessed or provider-only pool;
- no `VIERO_PHASE3B_POOLS_FILE` manifest was created or populated.

Exact missing evidence is a real, independently verified pool address/PoolKey plus its verification block number and canonical block hash. The continuation stopped at this point as required. Supplying that evidence separately is necessary before resuming the profiling harness.

The section above records the state before this bootstrap; the bounded bootstrap below supersedes it with two independently verified entries.

## Phase 3B verified-pool discovery bootstrap — 2026-10-16

### Bounded external discovery

The existing DEX Screener public `token-pairs/v1` integration was used as an advisory source, with one stable-token query per target chain:

- BNB: `bsc/0x55d398...7955` (USDT), filtered to PancakeSwap V3 and configured stable/native quote counterparts.
- Robinhood: `robinhood/0x5fc536...d168` (USDG), filtered to Uniswap V4 and configured USDG/WETH counterparts.

No broad token discovery or on-chain scan was performed. The bounded candidate lists were:

| Chain | Rank | Protocol | Pair identifier | Pair | External liquidity | Result |
|---|---:|---|---|---|---:|---|
| BNB | 1 | PancakeSwap V3 | `0x4f31...40eb` | USDT/USDC | $40,385,287.87 | selected and verified |
| BNB | 2 | PancakeSwap V3 | `0x92b7...3121` | USDT/USDC | $29,969,610.35 | not verified; one pool/chain manifest limit |
| BNB | 3 | PancakeSwap V3 | `0x5f69...ad13` | USDT/USDC | $106.99 | not verified; one pool/chain manifest limit |
| Robinhood | 1 | Uniswap V4 | `0x4864...fa6e` | token/USDG | $2,305,737.96 | PoolKey recovered; rejected by Viero hook allowlist |
| Robinhood | 2 | Uniswap V4 | `0x4be9...f38a` | token/USDG | $1,491,292.20 | selected and verified |
| Robinhood | 3 | Uniswap V4 | `0xff7b...fd92` | token/USDG | $1,088,764.33 | PoolKey recovered; rejected by Viero hook allowlist |

The DEX Screener pair identifier was not treated as a V4 pool address. It was used only as a PoolId hint and independently resolved through the on-chain PositionManager.

### Canonical verification

The manifest is [phase3b-verified-pools.json](/Users/pesal/Documents/Viero-agent/mcp-evm-server/docs/audits/phase3b-verified-pools.json). It contains exactly one pool per target chain and includes external provenance, the canonical identity, token pair, and pinned verification block identity.

**BNB Chain (56)**

- PancakeSwap V3 pool: `0x4f31fa980a675570939b737ebdde0471a4be40eb`.
- `verifyPool()` confirmed chain ID, pinned block, pool and factory bytecode, token0/token1, fee `500`, and the factory's canonical `getPool(token0, token1, fee)` relationship.
- Verification block: `127826650` / `0x5ca993f734758102f222f117ba8e2a1181d0b1d412d6f1d977228f90aa673c8b`.
- On-chain state at that block: tick `-14`; active liquidity `3752888612436570541524757009`.

**Robinhood Chain (4663)**

- Uniswap V4 PoolId: `0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a`.
- PositionManager `poolKeys(bytes25(poolId))` returned the complete key: currency0 `0x39db...c4571`, currency1 USDG `0x5fc5...d168`, fee `3000`, tick spacing `60`, hooks zero address.
- Recomputing `poolId(PoolKey)` produced exactly the DEX Screener PoolId.
- `verifyPool()` confirmed chain ID, pinned block, PoolManager and StateView bytecode, PoolId, and zero-hook allowlist state.
- Verification block: `89403852` / `0x6173e1d305024073afa6908514b541686c3f34040b90d3faa16b1639f419560c`.
- On-chain state at that block: tick `-286958`; active liquidity `3813269919380060632`.

The higher-liquidity Robinhood rank-1 candidate was not silently accepted: its complete key hashed correctly, but hooks `0x08E525...7A080` are not in Viero's approved-hook set, so `verifyPool()` rejected it with `UNKNOWN_V4_HOOK`. Rank 3 was similarly rejected for its non-zero unapproved hook. No hook policy was relaxed.

### Harness resume result and budget gate

The manifest was passed to the existing harness with `VIERO_PHASE3B_POOLS_FILE`. The harness preflight succeeded for all configured chains (8 physical read-only requests, 40 estimated CU, no retries/fallbacks). It then reported `MANIFEST_SCENARIOS_NOT_IMPLEMENTED_IN_SAFE_BASELINE` for both manifest entries and did not run scenarios A–I.

This is a harness limitation, not a completed profiling experiment: the checked-in script currently only performs preflight and explicitly leaves manifest scenarios unimplemented. Therefore there are no actual profiling method counts, pagination observations, cache comparisons, or method-level CU results to claim. The bootstrap's identity-verification calls were bounded to the two selected pools and three V4 PoolKey lookups; the source-level operation count is far below the 500-attempt/50,000-CU aggregate gate, but the current harness did not instrument those bootstrap calls as a shared counter.

No autonomous service, management loop, signer, executor, manual LP workflow, scheduler, or transaction was started. No deployment or service restart occurred.

### Remaining gaps and Phase 3C recommendation

The next safe step is to extend the isolated harness so it consumes this manifest and implements each intended read-only scenario while sharing one counter with manifest verification. That change needs separate approval. Until then, this manifest is verified identity evidence only; it must not be treated as proof that Phase 3B profiling completed.

## Phase 3B.2 live profiling — 2026-10-16

### Harness implementation and safety validation

The isolated harness at `scripts/audits/phase3b-live-profile.mjs` now implements scenarios A–I without importing Viero runtime entrypoints. It uses a custom viem transport whose only request path is the budget-controlled JSON-RPC function. No scheduler, storage, signer, executor, indexer, or manual-LP module is imported.

Implemented scenarios:

- A: pinned canonical identity/state verification;
- B/C: cold creation-evidence binary search and warm canonical-hash reuse;
- D: exact timestamp-to-block boundary binary search;
- E/F: protocol-specific swap and protocol-fee log pagination;
- G: unique event-block and transaction lookups;
- H: initialized bitmap/tick depth reads using the existing ±1% range semantics;
- I: repeated observation with warm creation/boundary caches.

The harness rejects unsupported methods, transaction capabilities, duplicate chain entries, missing pinned evidence, and chain/hash mismatches. It accounts for every preflight, verification, profiling, retry, and fallback attempt in one budget. Concurrency is queued at two active requests. Offline safety self-tests passed:

`node scripts/audits/phase3b-live-profile.mjs --self-test`

Checks covered manifest/budget validation, budget exhaustion, unknown-method rejection, transaction-capability absence, and deterministic PoolId hashing. The live adapter is a reproduced read-only RPC path, not a claim that the full autonomous observation function was executed.

### Live run

The run used the verified manifest with a five-minute historical window (matching Viero's cycle cadence). It completed both chains without retries, fallbacks, identity mismatches, reorg errors, or budget exhaustion.

| Metric | Result |
|---|---:|
| Physical RPC attempts | 240 |
| Logical RPC calls | 240 |
| Estimated CU | 5,824 |
| Attempt budget used | 240 / 500 |
| CU budget used | 5,824 / 50,000 |
| Retries | 0 |
| Fallbacks | 0 |
| Maximum concurrency | 2 |

Estimated CU by method:

| Method | Calls | CU estimate |
|---|---:|---:|
| `eth_chainId` | 6 | 0 |
| `eth_blockNumber` | 4 | 40 |
| `eth_getBlockByNumber` | 68 | 1,360 |
| `eth_getCode` | 33 | 660 |
| `eth_call` | 104 | 2,704 |
| `eth_getLogs` | 14 | 840 |
| `eth_getTransactionByHash` | 11 | 220 |
| **Total** | **240** | **5,824** |

These are method-weighted estimates, not provider-billed CU.

### Scenario results

#### BNB Chain 56 — PancakeSwap V3 fee 500

- Pinned identity block: `127826650`; tick `-14`; tick spacing `10`; active liquidity `3752888612436570541524757009`.
- Cold creation evidence: block `27885316`, timestamp `1683112489`; creation block hash was verified.
- Warm creation: cache hit with one canonical creation-block hash check.
- First-block boundary for the five-minute window: `127825983`.
- Swap logs: 4 logs, 1 page, 0 splits, 0 errors.
- Protocol-fee logs: skipped explicitly because the selected PancakeSwap V3 path has no supported `SetFeeProtocol` scenario in this harness.
- Event/transaction lookups: 4 block reads and 4 transaction reads.
- Depth: 2 initialized bitmap words (`-1`, `0`), exact ±1% tick envelope `-120` to `90`.
- Warm repeat: creation and boundary cache hits; 4 logs and 1 log page.

#### Robinhood Chain 4663 — Uniswap V4 fee 3000, tick spacing 60, zero hooks

- Pinned identity block: `89403852`; tick `-286958`; active liquidity `3813269919380060632`.
- Cold creation evidence: block `12594350`, timestamp `1784338933`; creation block hash was verified.
- Warm creation: cache hit with one canonical creation-block hash check.
- First-block boundary for the five-minute window: `89400853`.
- Swap logs: 7 logs, 3 pages, 0 splits, 0 errors.
- Protocol-fee logs: 0 logs, 3 pages, 0 splits, 0 errors.
- Event/transaction lookups: 4 block reads and 7 transaction reads.
- Depth: 1 initialized bitmap word (`-19`), exact ±1% tick envelope `-287100` to `-286800`.
- Warm repeat: creation and boundary cache hits; 7 logs, 3 log pages, 3 protocol-fee pages, and 1 bitmap read.

The difference in pagination is attributable to the pinned five-minute block ranges: BNB covered 668 blocks in one request, while Robinhood covered 3,000 blocks in three 1,000-block pages. No provider cap or natural split was observed.

### Findings and limitations

The largest measured logical cost was `eth_call` (2,704 estimated CU), followed by historical block reads (1,360 CU), log queries (840 CU), and bytecode verification (660 CU). Robinhood generated more historical event and transaction work than BNB despite having fewer swap logs because its three-page range produced separate protocol-fee pagination and seven transaction reads.

The run did not query provider billing, so no billed USD or Alchemy dashboard usage is claimed. It also did not exercise signer authorization, simulation, execution, autonomous management, or manual LP paths. BNB protocol-fee scenario F was skipped by protocol capability, not silently substituted.

### Phase 3C recommendation

The next safe optimization target is measurement-backed reuse of pinned block metadata and verified immutable identity/creation evidence across autonomous observations, while retaining fresh state, complete logs, exact depth, reorg checks, and independent confirmation. No Phase 3C code was implemented or deployed in this run.
