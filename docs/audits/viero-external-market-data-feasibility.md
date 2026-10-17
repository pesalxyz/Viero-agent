# Viero external market-data API feasibility audit

Date: 2026-10-15

Status: audit only. No runtime code, configuration, service, autonomous schedule, manual LP flow, wallet, or chain state was changed. The bounded live comparison used four unauthenticated HTTP GET requests and no blockchain RPC benchmarking or transactions.

## Executive conclusion

External APIs are useful prefilters, but they cannot replace Viero's final on-chain evidence.

- **GMGN** is the current token-discovery and security-hint source. Its official CLI documentation explicitly lists BSC and Robinhood chain slugs and token/market capabilities, but the checked documentation does not establish complete Uniswap V3/V4 identity or exact LP economics. Keep it for token discovery and risk hints only.
- **DEX Screener** is the best broad pool-discovery prefilter for both target chains in the bounded comparison. It returned Robinhood Uniswap V4 identifiers and fresh liquidity/volume/transaction fields. Its response did not provide enough V4 PoolKey data (fee, tick spacing, hooks), and its pair identifier is not an executable pool address. Keep RPC identity recovery and verification.
- **GeckoTerminal** is a useful fallback market-data source. It returned pool creation timestamps, reserves, volume, transaction counts, and fee information embedded in some pool names. It does not establish canonical V4 PoolKey/PoolId or exact fee growth, and its coverage/field shape must be treated as advisory.
- `exactPoolCreatedAt()` is **partially replaceable**: provider `pool_created_at` can prefilter or seed evidence, but the verified pool identity and canonical block hash still need on-chain confirmation before safety use.
- `firstBlockAt()` and `pagedLogs()` are **not replaceable** for Viero's current exact historical observation path. External OHLCV/trade APIs may be used as diagnostics or a prefilter, never as a substitute for complete, block-pinned swap/protocol-fee evidence.

The safe first implementation is provider-side prefiltering plus reuse of already verified evidence; do not remove final `verifyPool`, depth, simulation, identity, reorg, fee, or authorization checks.

## Existing source-code architecture

### Discovery and enrichment flow

1. `src/viero/discovery/tokenDiscovery.ts` polls GMGN Hot Search on a five-minute cadence, deduplicates by chain/address, retains the GMGN rank/market-cap/volume/liquidity fields, and invokes the GMGN-only token screener.
2. `src/viero/workers/screeningWorker.ts` ranks the passed token observations. Routine screening is intentionally GMGN-only and does not perform EVM RPC.
3. `src/viero/workers/screeningWorker.ts:executeCandidateToken()` invokes `searchVerifiedPoolsForToken()` only for the selected candidate.
4. `src/viero/adapters/targetedPoolDiscovery.ts` merges Uniswap GraphQL V4, DEX Screener, GeckoTerminal V3 fallback, and bounded RPC fallback hints. External data orders candidates; `recoverExternalV4PoolHints()` reconstructs or verifies the PoolKey/PoolId; `verifyPool()` is authoritative.
5. `src/viero/adapters/events.ts:targetedRpcObservation()` obtains exact creation evidence, historical swap/protocol-fee logs, block-pinned event state, initialized ticks, and V3 TVL. This is the expensive candidate-enrichment path.

### Field-level dependency matrix

| Field / decision | Current source | External API usefulness | Must remain on-chain? | Reason |
|---|---|---|---|---|
| Hot-search token address/rank | GMGN `market hot-searches` | Primary | No, discovery only | Candidate universe and ranking input |
| Token market cap / 1h volume / liquidity | GMGN row fields | Primary advisory | No for stage-1 prefilter; freshness/identity should be checked | Current policy uses token-level GMGN volume |
| Token honeypot/admin/holder/tax hints | GMGN `token security` | Primary hint | Final safety policy remains fail-closed | GMGN data is third-party/provider-derived |
| Token decimals/symbol | Block-pinned RPC; now verified immutable cache | APIs may expose metadata | Yes once per verified bytecode identity | Identity and raw-unit normalization |
| Pool address / V3 pair hint | DEX Screener, Gecko, GMGN pool info | Good discovery prefilter | Yes | Factory identity, bytecode, token pair, fee, state |
| V4 PoolId hint | DEX Screener/Uniswap GraphQL | Good discovery prefilter | Yes | PoolId must hash from canonical PoolKey |
| V4 currency0/1, fee, tick spacing, hooks | Uniswap GraphQL/optional provider fields | Sometimes partial | **Yes** | Executable identity and hook safety |
| V3 fee tier | Gecko pool name or RPC | Partial | **Yes** | Exact fee math and factory identity |
| Current tick/sqrt price/liquidity | RPC `verifyPool` / StateView or pool contract | Market APIs are snapshots only | **Yes** | Fresh executable economics and range branch |
| Current V3 TVL balances | RPC `balanceOf` at pinned block | External reserve USD is advisory | **Yes** for policy evidence | Exact pool and quote identity |
| ±1% depth / initialized ticks | RPC bitmap/tick reads | Not adequate for exact executable depth | **Yes** | Screening and exit-liquidity safety |
| Pool creation timestamp | `exactPoolCreatedEvidence` binary search, now cached | DEX `pairCreatedAt`, Gecko `pool_created_at` | Partially | Timestamp can seed, canonical block evidence cannot be assumed |
| Window start block | `firstBlockAt` | OHLCV timestamp can approximate only | **Yes** | Maps configured time window to chain blocks |
| Swap/protocol-fee events | `pagedLogs` + block/slot/transaction reads | Trades/OHLCV can summarize | **Yes** for exact observation | Complete event set, protocol-fee state, trader identity, reorg checks |
| LP-net fees | On-chain event/state math | No adequate replacement found | **Yes** | Exact fee and protocol/hook deductions |
| Simulation / signer authorization | RPC simulation and signer | No | **Yes** | Transaction safety boundary |

## Provider-specific findings

### GMGN

Source code:

- `src/viero/adapters/providers.ts:Gmgn.query()` invokes `gmgn-cli` with `market hot-searches`, `market trending`, `token info`, `token security`, `token pool`, and related commands.
- `src/viero/discovery/tokenDiscovery.ts` uses Hot Search and retains normalized market fields.
- `src/viero/discovery/tokenScreener.ts` uses security responses as hints and fails closed when required new-entry evidence is unavailable.
- `src/viero/adapters/providers.ts:gmgnPoolInfoToPoolRef()` can map a V3 pool address. Its V4 fallback shape is incomplete (fee/tick spacing/hooks are placeholders), so it cannot be trusted as a V4 identity source without the later RPC verification path.

The [official GMGN CLI reference](https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md) documents `token info`, `token security`, and `token pool`, and lists `bsc` and `robinhood` chain slugs. The [official Agent API overview](https://docs.gmgn.ai/index/gmgn-agent-api) describes real-time token, liquidity, security, market, and candlestick capabilities. It does not document a canonical V4 PoolKey registry or exact Uniswap fee-growth accounting. GMGN access requires an API key; no authenticated GMGN request was made in this audit, and no credential was inspected.

The repository deliberately rate-spaces GMGN calls at 1.5 seconds and retries up to three CLI attempts (`src/viero/adapters/providers.ts`). That is an application safeguard, not a confirmed GMGN commercial rate limit.

### DEX Screener

Source code:

- `src/viero/adapters/providers.ts:Market.pools()` calls `/token-pairs/v1/{chain}/{token}`.
- `src/viero/adapters/targetedPoolDiscovery.ts:dexScreenerShortlist()` filters supported chain/venue/protocol/quote pairs, sorts by external liquidity, and bounds the list to ten.

The [official API reference](https://docs.dexscreener.com/api/reference) documents token-pair and token endpoints, including `pairAddress`, base/quote token addresses, price, transactions, volume, liquidity, `pairCreatedAt`, market cap, and FDV. It documents a 300 requests/minute limit for pair/token endpoints and 60 requests/minute for profile/boost endpoints. It does not provide canonical V4 fee/tick-spacing/hooks sufficient for execution. In particular, a Robinhood V4 `pairAddress` is a bytes32 pool identifier, not a pool contract address.

### GeckoTerminal

Source code:

- `src/viero/adapters/targetedPoolDiscovery.ts:fetchGeckoV3Hints()` uses `tokens/{address}?include=top_pools` only as a Robinhood V3 fallback.
- `src/viero/adapters/providers.ts:Market.prices()` uses Gecko simple token price only after GMGN price failure.

The [official GeckoTerminal API guide](https://apiguide.geckoterminal.com/) describes real-time prices, liquidity, volume, transactions, token/pool search, and OHLCV across 1,500+ DEXes and 200+ networks. The [official changelog](https://apiguide.geckoterminal.com/changelogs) documents `pool_created_at`, reserve USD, transaction/volume intervals, trades, and OHLCV granularity. The public API is currently free/beta, requests attribution, and documents a 30 calls/minute public limit in the changelog; paid CoinGecko Onchain plans increase limits. The API is subject to change and historical retention/granularity is endpoint-dependent.

Gecko pool records are useful for age, market-quality prefiltering, and fallback V3 discovery. They do not prove V4 PoolKey identity, canonical PoolId, current executable liquidity, or exact LP-net fee growth.

## Bounded live comparison

Sample date: 2026-10-15. Sample: one stable-token query per provider/chain (four GET requests total):

- BNB: USDT `0x55d398...7955`.
- Robinhood: USDG `0x5fc536...d168`.

Only public, unauthenticated endpoints were used. Values below are observations from the bounded sample and are not a market snapshot guarantee.

### DEX Screener observations

| Query | Result | Useful fields observed | Limitations |
|---|---|---|---|
| BNB USDT | HTTP 200; top results included PancakeSwap V3/V2 pools, with liquidity, 1h volume, 1h buys/sells, pair creation time, token pair and price | Broad discovery and ordering | Sample was USDT and was dominated by PancakeSwap; no Uniswap V3 pool appeared in the first five. DEX result does not prove V3 factory identity or executable state |
| Robinhood USDG | HTTP 200; top results included Uniswap V4 pools with 32-byte pair identifiers, liquidity, 1h volume, 1h buys/sells, pair creation time and token addresses | Strong V4 discovery hint and external ranking | No complete PoolKey in the response; fee, tick spacing, hooks, current tick and active liquidity still require on-chain verification |

### GeckoTerminal observations

| Query | Result | Useful fields observed | Limitations |
|---|---|---|---|
| BNB USDT | HTTP 200; top pools included USDT/WBNB and USDT/USDC, reserve USD, 24h volume, hourly buys/sells/buyers/sellers, creation timestamps; fee appeared in some pool names | Age, reserves, market activity, fallback V3 context | Top-pool ordering is Gecko's view; exact venue identity, fee parsing, current state and depth remain unverified |
| Robinhood USDG | HTTP 200; top pools included USDG/WETH and WETH/USDG with reserve USD, 24h volume, hourly activity and creation timestamps | Fallback discovery/market context | Returned pool records are address-shaped and do not establish a V4 bytes32 PoolId/PoolKey; not sufficient for V4 identity or fee growth |

### GMGN live comparison

No live GMGN request was made because the official CLI requires an operator API key and no credential was requested, printed, or inspected. The source-code and official-documentation findings are confirmed; live latency/HTTP behavior and field completeness for this sample remain an evidence gap.

## Chain and protocol capability matrix

| Provider | BNB V3 | BNB V4 | Robinhood V3 | Robinhood V4 | Creation time | OHLCV/trades | Exact PoolKey / fees |
|---|---:|---:|---:|---:|---:|---:|---:|
| GMGN | Partial pool hints | Not established | Partial pool hints | Not established | Possible metadata, not canonical | Market/candles documented | No |
| DEX Screener | Pair discovery, labels | Pair discovery and bytes32 hint observed | Pair discovery | V4 hint observed | `pairCreatedAt` | Volume and transaction counts; not exact event history | No; RPC required |
| GeckoTerminal | Pool discovery/market data | Not established | V3 fallback in current code | Not established | `pool_created_at` | OHLCV and recent trades documented | No; RPC required |
| Alchemy/on-chain RPC | Yes | Yes | Yes | Yes | Canonical evidence | Complete logs and block-pinned state | **Yes** |

“Supported” here means the provider returned a usable advisory response in the bounded sample or documents the relevant endpoint; it does not mean Viero can safely replace final on-chain verification.

## Historical RPC replacement matrix

| Operation | Classification | Safe use of external data |
|---|---|---|
| `exactPoolCreatedAt()` / `exactPoolCreatedEvidence()` | **PARTIALLY REPLACEABLE** | Use `pairCreatedAt`/`pool_created_at` to prioritize, reject obviously young pools, or seed an indexed lookup. Keep canonical block search/hash validation for evidence used by screening. Phase 1 cache is safer and already implemented. |
| `firstBlockAt()` | **NOT REPLACEABLE** for exact metrics | An API candle boundary is not a chain block boundary. It may prefilter a candidate, but exact window metrics require block mapping. Cycle-scope memoization is safe. |
| `pagedLogs()` swap/protocol-fee logs | **NOT REPLACEABLE** for final observation | OHLCV/trades can reduce candidates or provide diagnostics. They cannot prove complete logs, event ordering, protocol fee updates, or reorg status. |
| Per-event block timestamp reads | **PARTIALLY REPLACEABLE** | API timestamps can be used for advisory display. Exact observation should keep block reads or a trusted indexed block/hash source. |
| Per-event transaction lookups | **NOT REPLACEABLE** for current trader-derived metrics | APIs may expose buy/sell counts but not necessarily exact trader identity and transaction association used by Viero. |
| Historical fee calculations | **NOT REPLACEABLE** | Exact V3/V4 LP-net fees require on-chain fee state, growth, protocol/hook deductions, and block-pinned economics. |
| Initialized tick bitmap / depth | **NOT REPLACEABLE** | External liquidity USD is not executable ±1% depth. |
| Current `verifyPool()` state | **NOT REPLACEABLE** | Identity, bytecode, current tick, liquidity, PoolKey, hooks, and canonical block hash are safety boundaries. |

## Proposed hybrid architecture

`GMGN → token discovery/security hints`

`DEX Screener → broad pool hints and external liquidity ordering`

`GeckoTerminal → fallback pool/market data and age/price context`

`Alchemy/RPC → PoolKey/PoolId identity, bytecode, fresh state, depth, exact historical evidence, fee math, simulation`

`Deterministic policy → ranking and execution authorization`

Rules:

- Merge provider hints by exact chain/protocol/identity; never let a provider override a verified identity.
- Prefer DEX Screener for initial pool ordering on BNB and Robinhood; use Gecko when DEX data is unavailable or as an independent disagreement signal.
- Use provider TTLs for discovery data (target five minutes or less for candidate selection), but require fresh block-pinned RPC state immediately before authorization.
- If providers disagree on token pair, quote asset, protocol, or identity, retain the disagreement as evidence and fail closed for execution unless RPC resolves it deterministically.
- Use external creation timestamps only as advisory age evidence until a canonical creation block/hash is verified.
- Do not substitute external TVL for V3 balances, external volume for complete swap logs, or OHLCV for exact fee growth/depth.
- Keep fallback and provider retry budgets bounded. Cache only immutable verified evidence, as in Phase 1.

### Expected request volume and savings (estimates)

Assumptions: one five-minute cycle, 20 token candidates returned by GMGN, one selected candidate enriched, ten external pool hints max, and one verified pool. DEX Screener contributes one token-pairs request for the selected token; Gecko contributes zero unless V3 fallback is needed; GMGN contributes the existing Hot Search/security calls. These are logical application requests, not provider billing units.

The most defensible savings come from avoiding RPC work for candidates that fail external ordering and from Phase 1 evidence reuse:

- no-candidate cycle: approximately zero EVM RPC remains the current architecture;
- selected candidate: external prefilter can avoid verification of non-top pools, but final verification still requires RPC;
- repeat observation of an already verified pool: token metadata calls fall from four logical metadata reads to zero, and creation-time binary search becomes a canonical block-hash check;
- historical event scans remain the dominant variable cost and are not safely removed by this audit.

Exact Alchemy CU savings are **not measurable from this bounded sample** and must not be claimed until production telemetry is correlated with provider billing.

## Ranked recommendation

1. Keep DEX Screener as the primary broad pool prefilter for BNB and Robinhood, with strict chain/venue/quote/protocol filtering and bounded top-10 ordering.
2. Keep GeckoTerminal as the primary fallback for missing DEX V3 hints and as an independent market/age disagreement source.
3. Keep GMGN as primary token discovery and security hint provider; do not use its incomplete V4 pool conversion as execution truth.
4. Continue Phase 1 immutable metadata and creation-evidence caches; add cycle-scoped `firstBlockAt` memoization next.
5. Instrument and tune `pagedLogs` page sizes and split counts before changing historical behavior.
6. Only after measurement, consider a trusted indexed historical-data service for non-safety-critical prefiltering. It must provide block/hash provenance and never replace final RPC checks.

## Minimum safe implementation roadmap

1. **Already implemented locally:** Phase 1 telemetry, verified token metadata cache, canonical creation evidence cache.
2. **Next small batch:** memoize `firstBlockAt(chain, head, window)` within one autonomous cycle and expose `pagedLogs` range/split metrics. Preserve block pinning and complete-log failure behavior.
3. **Provider adapter hardening:** normalize DEX/Gecko freshness, protocol, fee and identity fields into advisory schemas; record provider disagreement without changing authorization.
4. **Measurement period:** compare logical/physical RPC operations, cache rates, candidate counts, and provider billing across stable windows.
5. **Only with evidence:** optimize log pagination and defer non-safety-critical enrichment. Do not replace exact fee/depth/identity reads.

## Evidence gaps

- No authenticated GMGN live sample was collected.
- The four live API requests were stable-token queries, not a representative random candidate set.
- Provider commercial terms can change; rate-limit figures should be rechecked before implementation.
- External pool creation timestamps were not reconciled to RPC block hashes in this audit.
- No live RPC benchmarking was performed by design.

## Approval boundary

This document recommends architecture only. Implementation of any external-data substitution or additional caching should wait for explicit approval and a separately scoped change. No existing safety check should be removed based solely on an API field with a similar name.
