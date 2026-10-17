# Viero RPC cost and usage investigation

**Audit date:** 2026-10-15 (Asia/Jakarta)
**Scope:** repository `mcp-evm-server`, plus read-only inspection of the VPS configuration and service state.
**Mode:** audit only. No source, configuration, database, or running service was changed; no transaction or live RPC measurement was issued.

## Evidence labels

- **CONFIRMED** — directly established from source, service files, or safely read production state.
- **CODE-INFERRED** — follows from control flow, but was not observed in a live run.
- **ESTIMATED** — arithmetic based on code-derived call counts and stated assumptions.
- **NOT VERIFIED** — requires provider billing/telemetry that was not available.

## A. Executive summary

The largest likely RPC consumer is **targeted candidate enrichment**, not routine token screening. The live agent runs a five-minute cycle (`src/viero/cli.ts:125-156`, default `screeningIntervalSeconds=300` in `src/viero/config/policy.ts:8`) and normally performs GMGN-only token discovery. That routine path does not need EVM RPC. RPC begins when a candidate is handed to `executeCandidateToken()` (`src/viero/workers/screeningWorker.ts:460-655`): pool identity recovery, block-pinned verification, token metadata, historical event windows, depth ticks, balances, and fresh planner checks can produce tens to hundreds of requests for one candidate.

The second major consumer is **open-position management**. Every five minutes (`src/viero/cli.ts:136-145`) each open position is verified, priced, fee-enriched, and reconciled against its entry receipt (`src/viero/workers/screeningWorker.ts:683-720`, `778-796`). This creates a predictable per-position baseline even when no rule triggers. It is necessary for fresh safety decisions, but several metadata and receipt reads are repeated.

The legacy protocol indexer is a potentially very large historical consumer if enabled. It scans 50,000-block chunks over each configured V3 factory and V4 PoolManager (`src/viero/indexer/protocol.ts:14-35`, `88-106`). **CONFIRMED:** the inspected VPS had indexer checkpoint files for chains 4663, 56, 8453, and 5042, but all four services were inactive at audit time and no recent journal entries were available. Therefore those files prove historical indexing existed, not that it currently generates requests.

The reported `$2.00-$2.50/day` cannot be validated from this checkout. **NOT VERIFIED:** provider billing, compute-unit weights, request totals, and endpoint-level dashboards were unavailable. The amount may combine several endpoints or a subscription/overage calculation. It must not be treated as a measured Viero-only cost until provider exports are correlated with request counters.

Safest first optimization to investigate: add **read-only per-method/per-chain counters at the PublicClient boundary**, then compare one enabled chain for 24 hours with the indexer disabled. This does not change freshness or authorization behavior and turns the estimates below into measurements.

## B. RPC architecture map

| Component | Worker/path | Chain selection | RPC / external methods | Cadence |
|---|---|---|---|---|
| Public client factory | `src/viero/clients/publicClients.ts:5-22` | Any configured chain | viem HTTP `eth_*`; `fallback()` transports; `retryCount: 2`, 20s timeout, batching enabled | Per caller |
| Read-only preflight | `src/viero/operations/preflight.ts:44-89`, `src/viero/clients/publicClients.ts:26-38` | Every `VIERO_CHAINS` entry | `eth_chainId`, `eth_blockNumber`, `eth_getCode` for deployment contracts | Service start; agent and Telegram each have `ExecStartPre` |
| Routine discovery | `src/viero/discovery/tokenDiscovery.ts:170-178`, `src/viero/workers/screeningWorker.ts:226-238` | Enabled runtime chains | GMGN CLI/API; routine mode is `gmgnOnly`, so no EVM RPC | Every 300s in the agent cycle; the class interval is not started by CLI |
| Candidate pool discovery | `src/viero/adapters/targetedPoolDiscovery.ts` | Selected candidate chain | `eth_blockNumber`, factory `getPool`, V4 `poolKeys`, `eth_getLogs`, `eth_getBlockByNumber` | Only for selected candidate |
| Candidate verification | `src/viero/adapters/pools.ts:20-64` | Selected candidate chain | `eth_chainId`, block, bytecode, token/pool metadata, slot/liquidity, ERC-20 decimals/symbol | Once per verified pool |
| Candidate economics | `src/viero/adapters/events.ts:40-191` | Selected candidate chain | Historical `eth_getBlockByNumber`, `eth_getLogs`, `eth_getTransactionByHash`, slot reads, balances, gas price, tick bitmap/ticks | Once for the selected pool |
| Position management | `src/viero/workers/screeningWorker.ts:683-720`, `778-796` | Chains with open positions | verification + token metadata + fee-growth reads + entry receipt/transaction | Every 300s per position; fresh confirmation adds another observation when a rule fires |
| Telegram refresh/card | `src/viero/telegram.ts:613-638`, `834-880` | User-selected position chain | Same lightweight/enrichment path; read-only | On operator request; cycle cards reuse saved snapshot when available |
| Open execution | `src/viero/execution/executor.ts:255-355` | Selected candidate chain | balances, ERC-20/Permit2 allowance, `eth_estimateGas` through simulation, receipt polling, raw transaction broadcast | Only after policy approval; writes are outside this audit |
| Close/claim/normalize | `src/viero/execution/executor.ts:358-474`, `src/viero/execution/relay.ts` | Open/closed position chain | fresh state, balances, receipts, Relay API, transaction receipt polling | Only on lifecycle action |
| Legacy indexer | `src/viero/indexer/server.ts`, `src/viero/indexer/protocol.ts` | Explicit `VIERO_INDEXER_START_<chain>` entries | large-range `eth_getLogs`, block checkpoints | Startup and each `/v1/pools`/observation request; disabled in inspected production |
| MCP wallet tool | `src/viero/mcp.ts:20-39` | Requested chain | block, native balance, ERC-20 balances | On MCP request only |

Provider categories are configured through `VIERO_RPC_<chainId>` (never printed here). The chain table intentionally contains empty RPC URL arrays; production URLs are supplied through environment files. GMGN, DEX Screener, Uniswap GraphQL, GeckoTerminal, Telegram, LLM, and Relay are HTTP/external providers rather than EVM RPC, but their retries can indirectly cause repeated application work.

## C. Active versus configured chains

**CONFIRMED from the inspected VPS environment:** RPC variables existed for 4663, 56, 8453, and 5042; the persisted control file selected only chain 56 at audit time; `viero-agent`, `viero-telegram`, `viero-signer`, and `viero-indexer` were all inactive. Consequently, there was no active chain workload during this audit.

Configured support is not active usage. A chain only creates routine work when it is both in the agent's selected chain list and enabled in persisted controls (`src/viero/cli.ts:122-133`, `src/viero/runtime/chainSelection.ts`). An indexer endpoint/start block is an additional, separate opt-in. The previously present checkpoint files are not evidence of current requests.

## D. Request-level consumption model

### D1. Routine five-minute cycle, no candidate handoff and no open positions

**CODE-INFERRED:** approximately zero EVM RPC calls per active chain per cycle. `tokenFirstDiscover()` uses `TokenDiscovery.fetchAndScreenOnce()` with GMGN-only screening (`src/viero/workers/screeningWorker.ts:226-238`); the token screener explicitly performs no RPC in `screenGmgnOnly()` (`src/viero/discovery/tokenScreener.ts:140-164`). The agent still calls the repository and GMGN. A manually requested `/screen` invokes the same cycle (`src/viero/telegram.ts:613-638`).

This is an important finding: keeping the agent alive with no positions and no candidate handoff should not itself explain a large EVM RPC bill. External GMGN usage is separate.

### D2. Service startup preflight

For each chain, `smokeTest()` makes one `eth_chainId`, one `eth_blockNumber`, and one `eth_getCode` per deployment address (`src/viero/clients/publicClients.ts:26-38`). Contract count is:

| Chain | V3 deployments | Code checks per preflight | Notes |
|---|---:|---:|---|
| 4663 | 1 | 7 | factory, position manager, quoter, PoolManager, PositionManager, StateView, Permit2 |
| 56 | 2 | 10 | two V3 deployment triples plus four V4 contracts |
| 8453 | 1 | 7 | same shape as Robinhood |
| 5042 | 1 | 7 | same shape as Robinhood |

The agent and Telegram systemd units each run `ExecStartPre=... preflight` (`deploy/viero-agent.service:20-24`, `deploy/viero-telegram.service:20-27`). **CODE-INFERRED:** a restart therefore duplicates this startup read set. It is small compared with historical event scans, but avoidable when a single preflight result is shared.

### D3. Candidate execution/enrichment

For one selected candidate, the path is intentionally expensive and mostly safety-relevant:

1. `searchVerifiedPoolsForToken()` calls external shortlist providers in parallel, recovers V4 identities, and may scan Initialize events or V3 factories (`src/viero/adapters/targetedPoolDiscovery.ts:470-600`).
2. `verifyPool()` reads identity, bytecode, pool state, and token metadata (`src/viero/adapters/pools.ts:20-64`).
3. `targetedRpcObservation()` performs pool-creation binary search, gas price, swap/protocol-fee log windows, block timestamps, transaction senders, depth bitmaps/ticks, V3 balances, and a final reorg block check (`src/viero/adapters/events.ts:101-191`).

**ESTIMATED lower-bound model for one verified selected pool, with no log subdivision and no initialized depth ticks:**

- V3 verification: about 1 chain-id + 1 block + 2 bytecode + 7 contract reads (token0/token1/fee/tickSpacing, factory identity, slot0, liquidity, decimals, symbol) = roughly 11-14 logical RPC operations depending on client batching.
- V4 verification: about 1 chain-id + 1 block + 2 bytecode + 6 contract reads (slot0/liquidity, decimals, symbols) = roughly 9-11.
- Targeted observation: two historical block binary searches (pool-created and window start), two log queries at minimum, gas price, final block, and one depth bitmap; add one tick read per initialized tick and three reads per distinct swap event (block timestamp, historical slot, transaction). A quiet pool is roughly 50-80 logical operations; active pools can be materially higher.
- Discovery fallback adds one `eth_blockNumber` plus either one factory `getPool` call per `(quote,dex,feeTier)` or paginated V4 Initialize logs. BNB has two V3 deployments and three quote assets, so its fallback fan-out is larger than Robinhood/Base.

These are logical viem operations, not provider-billed request counts: `http(..., { batch: true })` may combine calls, while fallback/retry may multiply them.

### D4. Position management

Per open position and per five-minute management tick:

- `verifyPool()` refreshes block, bytecode, slot/liquidity, pool metadata, and token decimals/symbols.
- `attachV4Fees()` adds two StateView reads (`getFeeGrowthInside`, `getPositionInfo`); V3 adds one NFPM `positions` read plus four pool fee/tick reads (`src/viero/workers/screeningWorker.ts:688-716`).
- `actualEntryPrincipalUsd()` always reads the entry receipt and may read the entry transaction (`:726-769`).
- If PnL evidence is unavailable, canonical enrichment repeats the position path (`:787-795`). A close rule then performs a fresh independent confirmation (`:994-1008`) before signer handoff.

**ESTIMATED quiet-position lower bound:** V4 approximately 12-16 logical EVM operations per position per five-minute tick; V3 approximately 15-20. This is about 144-192 or 180-240 logical operations/day per position before fallback retries, provider batching, and extra close confirmations. These reads are required for fresh management safety; repeated metadata/receipt reads are optimization candidates, not permission to cache away confirmation.

### D5. Telegram

The Telegram long poll is not EVM RPC. `getUpdates` uses a 30-second Telegram long poll (`src/viero/telegram.ts:525-537`). Automatic reports poll the repository every `min(interval, 30s)` (`:346-353`) and deliver persisted notifications/snapshots; they do not call the chain. `/refresh` and `/screen` are exceptions: refresh enriches a position read-only, while `/screen` runs a full cycle.

## E. Top RPC cost drivers

The ranking below is code-derived, not billing-measured.

| Rank | Driver | Evidence | Cost confidence | Safety note |
|---:|---|---|---|---|
| 1 | Targeted historical candidate observation (logs, binary block searches, depth ticks) | `events.ts:40-191` | **HIGH** as a likely driver; USD **NOT VERIFIED** | Do not remove fresh block pin/reorg checks; consider bounded/adaptive enrichment only after measuring |
| 2 | Repeated position verification + fee accounting every 5 minutes | `screeningWorker.ts:683-720`, `778-796` | **HIGH** request pattern | Fresh state and independent close confirmation must remain |
| 3 | V4/V3 fallback discovery and identity recovery | `targetedPoolDiscovery.ts:180-240`, `390-520` | **MEDIUM-HIGH** | Cache external hints, not final on-chain identity/state |
| 4 | Indexer historical scans when enabled | `indexer/protocol.ts:14-35`, `88-106` | **HIGH if enabled; inactive in inspected VPS** | Checkpoint/reorg behavior must remain intact |
| 5 | Transport retries and fallback endpoints | `publicClients.ts:16-17` | **MEDIUM** amplification varies by failure | Preserve bounded retries; add counters/circuit-breaker telemetry |
| 6 | Duplicate service preflight | both systemd units + `preflight.ts` | **HIGH, but small absolute volume** | Share/skip only with an explicit freshness policy |
| 7 | Per-position entry receipt reconciliation | `screeningWorker.ts:726-769` | **MEDIUM** | Receipt evidence may be required for basis correctness; cache only confirmed immutable results |
| 8 | Per-tick token metadata (`decimals`, `symbol`) | `pools.ts:10-17` | **MEDIUM** | Safe to cache by token+chain after verified bytecode |
| 9 | Depth bitmap/tick reads | `pools.ts:72-95` | **MEDIUM-HIGH for dense ranges** | Depth is a screening safety input; retain fail-closed semantics |
| 10 | Execution receipt/balance/allowance reads | `executor.ts:120-170`, `255-474` | **LOW when entries are rare; high per transaction** | Must remain fresh around writes |

## F. Retry and amplification analysis

1. **RPC transport:** each HTTP transport has `retryCount: 2`; with multiple comma-separated fallback URLs, a failing logical call may reach multiple transports. Exact multiplication is provider/viem dependent and **NOT VERIFIED** without request middleware.
2. **Log pagination:** `pagedLogs()` starts at 1,000 blocks and recursively halves on range/size errors (`src/viero/adapters/events.ts:8-35`). A capped/erroring range can become many requests; this is bounded by block span but has no explicit request budget.
3. **GMGN:** up to three external CLI attempts with 0.5s/1s delays (`src/viero/adapters/providers.ts:76-90`); this does not consume EVM RPC unless the CLI itself uses the same provider, which is **NOT VERIFIED**.
4. **Management evidence retries:** up to two extra canonical observations when PnL is unavailable (`screeningWorker.ts:978-983`), plus the mandatory independent confirmation for a proposed close. This is intentional fail-closed behavior, not a runaway loop.
5. **Provider request coalescing:** `Providers.run()` coalesces identical in-flight external requests (`providers.ts:19-53`), but PublicClient reads have no application-level coalescing across worker paths.

No recursive unbounded retry was found in the EVM client code. The primary unknown is fallback transport amplification under timeout/429 conditions.

## G. Indexer audit

`ProtocolPoolIndex.syncInner()` scans from the persisted checkpoint (or configured start block) in 50,000-block chunks. Each chunk queries one PoolCreated log range per configured V3 deployment, one V4 Initialize range, and one end-block hash. It saves every 20 chunks or at the target. On a reorg it reads the checkpoint block and fails closed. This is correct but expensive on a cold start.

**CONFIRMED:** `/var/lib/viero/indexer/{4663,56,8453,5042}.json` existed on the VPS, totaling roughly 700 MB in the inspected state; `viero-indexer` was inactive. **NOT VERIFIED:** whether those checkpoints were recently synchronized or how many provider units they consumed historically. The production agent's token-first path does not require the indexer; `Indexer.configured()` is only consulted by the legacy `discover()` path (`src/viero/adapters/indexer.ts:7-37`).

## H. Idle-state analysis

| State | EVM RPC expectation |
|---|---|
| Services stopped | 0 |
| Agent live, no positions, no candidate handoff | Approximately 0 per five-minute cycle; GMGN only |
| Telegram only, no `/screen`/refresh | 0 EVM RPC; Telegram long poll + repository reads |
| Agent live, one open position | Roughly 12-20 logical reads every 5 minutes, **ESTIMATED** |
| Indexer enabled and cold | Potentially thousands of log requests, **ESTIMATED** from block span/chunks |
| `/screen` or candidate handoff | Candidate-dependent, tens to hundreds, **ESTIMATED** |

The strongest idle-cost conclusion is that **no-position routine screening is not the likely source of a $2/day EVM bill**. If the provider reports substantial usage in that state, first inspect duplicate processes, preflight loops, indexer activity, or another consumer outside this repository.

## I. Optimization matrix

Savings are intentionally expressed as ranges/unknowns until counters are installed.

| Priority | Current behavior | Safe investigation/optimization | Expected effect | Risk / complexity |
|---|---|---|---|---|
| P0 | Possible duplicate agent/Telegram/preflight processes | Verify one owner per role; expose process identity and per-method counters | Removes accidental duplicate cycles; potentially near-linear reduction | Low; preserve service boundaries |
| P0 | Indexer can cold-scan large histories if enabled | Keep disabled unless explicitly needed; alert on nonzero indexer requests | Avoids historical scan burst | Low; preserve checkpoint/reorg code |
| P1 | Candidate observation scans blocks and ticks every selection | Measure per-stage calls; cache external shortlist and immutable token metadata; bound depth tick reads without weakening threshold evidence | Candidate-dependent reduction, likely meaningful | Medium; do not cache fresh pool state |
| P1 | Management repeats pool metadata and entry receipt | Cache immutable token metadata and confirmed entry receipt/basis; retain fresh slot/liquidity/fees/prices | Reduces fixed per-position overhead | Medium; immutable-cache invalidation must be explicit |
| P1 | `pagedLogs` recursively subdivides without a request budget | Record page split count and provider response; tune safe page size per chain | Fewer failed/repeated log calls | Medium; never accept partial logs |
| P2 | Duplicate smoke preflight on agent and Telegram restart | Share a short-lived, block-pinned preflight result or run only in agent unit with Telegram dependency | Removes duplicate startup reads | Low-medium; startup freshness policy required |
| P2 | Multiple identical PublicClient reads in one operation | Add request instrumentation/coalescing for identical read-only calls | Lower logical-to-physical ratio | Medium; avoid stale values across write boundaries |
| P2 | All enabled chains may be preflighted even when operator disables them | Preflight only selected runtime chains; current controls already gate routine cycles | Lower startup cost | Low |
| P3 | Historical event metrics are computed synchronously per candidate | Optional indexer/third-party metrics with block-hash verification | Large RPC reduction | High; correctness and availability redesign |

Reject any optimization that removes the fresh verification immediately before signer handoff, weakens pool/position identity checks, skips reorg hash checks, or treats unavailable depth/fees as zero.

## J. Provider billing and measurement gap

No provider dashboard, invoice, request log, or RPC middleware counter was available. The VPS services were stopped and its journal had no entries in the inspected 48-hour window. Therefore:

- Actual requests/day: **NOT VERIFIED**.
- Compute units/day and method weights: **NOT VERIFIED**; provider-specific and not inferable from viem alone.
- `$2-$2.50/day` attribution to Viero: **NOT VERIFIED**.
- Active chain usage at audit time: **CONFIRMED NONE** because all services were inactive.

Required evidence for a billing conclusion: provider export with timestamp, API key/project redacted, chain/endpoint, method or compute-unit weight, request count, retries, and daily USD; correlate against the same UTC window with Viero counters.

## K. Verification plan before implementation

1. Add a read-only transport wrapper (or viem `onRequest`-equivalent) that counts method, chain, endpoint label, latency, success/error, retry attempt, and logical operation ID. Do not log URLs or credentials.
2. Count `eth_call` by ABI function/address class, `eth_getLogs` range/rows/splits, `eth_getBlockByNumber`, `eth_blockNumber`, `eth_getCode`, balances, receipts, gas price, and transaction lookups.
3. Emit hourly counters for agent cycle, management tick, Telegram action, preflight, and indexer separately; include process PID/release ID to detect duplicates.
4. Run a 24-hour baseline with the indexer disabled and one selected chain. Record no-position, one-position, and candidate-cycle windows separately.
5. Export provider compute units/billing for the identical UTC window; calculate `provider_units / local_logical_calls` by method class.
6. Apply one optimization at a time, repeat the same window, and assert safety invariants: block-pinned state, identity verification, independent close confirmation, fail-closed missing evidence, and unchanged transaction authorization.

## L. Final verdict

1. **Largest confirmed code-derived driver:** targeted candidate historical observation and depth/event enrichment; actual billed dollars are not measured.
2. **Three priorities:** instrument the PublicClient boundary; keep the indexer disabled/alert on accidental activation; reduce duplicate candidate/position metadata and receipt reads only after confirming which ones dominate.
3. **Is `$2-$2.50/day` justified?** Not provable from available evidence. It is plausible during frequent candidate enrichment, open-position management, or indexer scans, but not from the idle no-position routine cycle alone.
4. **Realistic savings:** cannot responsibly state a percentage before provider correlation. P0 duplicate-process/indexer elimination could approach the fraction attributable to those components; safe metadata caching should reduce only the measured fixed overhead.
5. **Requires production evidence:** all dollar/compute-unit claims, transport retry amplification, active-chain mix, and indexer historical cost. No implementation should proceed on assumed provider weights.

## Safest first action

Instrument and observe; do not change trading logic. The first low-risk experiment is a 24-hour request counter around `PublicClients.get()` with the current indexer-disabled configuration and services intentionally kept stopped or run in a controlled read-only window. This directly answers whether the reported bill is caused by Viero, another process, or provider/account-level usage while preserving every freshness and signer safety boundary.
