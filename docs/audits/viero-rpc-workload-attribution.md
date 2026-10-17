# Viero RPC workload attribution (autonomous versus manual LP)

**Audit date:** 2026-10-15 (Asia/Jakarta)
**Mode:** read-only source, local-record, and previously retrieved Alchemy-usage analysis.
**Safety:** no runtime code, production configuration, service state, automation, or blockchain state was changed.

## Evidence labels

- **CONFIRMED** — directly returned by Alchemy, found in this checkout, or supplied as operational context.
- **CODE-INFERRED** — follows from a source path and its viem calls, but was not measured at runtime.
- **PLAUSIBLE** — fits the timing/method evidence but lacks operation-level correlation.
- **UNKNOWN** — not available from local records or the CLI query.

## 1. Corrected operational timeline

| Period | Autonomous Viero | Manual LP bot using the same Alchemy infrastructure | Interpretation |
|---|---|---|---|
| Oct 8–9 | Running: screening, candidate evaluation/execution, position management | Potentially active | Combined workload |
| Oct 10 | Stopped; transition day excluded from comparison | Continued | Mixed/transition usage |
| Oct 11–14 | Stopped | Continued on Robinhood (4663) and BNB (56) | Manual LP plus shared/account activity |

The prior historical report incorrectly described Oct 11–14 as a stopped/idle baseline. The corrected interpretation is: **autonomous work stopped, but Alchemy activity continued because manual LP work continued**. This makes a non-zero post-stop baseline expected.

## 2. Local-record check

Read-only inspection found no dated Oct 8–14 manual-operation journal, transaction export, or RPC counter in this checkout. The available `data/viero/` records are synthetic/replay fixtures from September and the persisted controls are paused; they do not establish a manual LP timestamp. No manual operation is asserted without supporting evidence.

This is a repository limitation, not evidence that manual activity did not occur. The supplied operational context is the evidence for continued manual LP activity.

## 3. Autonomous versus manual RPC architecture

The table describes logical viem calls. Provider compute units can differ by method, batching, response size, retries, and plan pricing.

| Workload | Trigger | Methods/source paths | Amplification and notes |
|---|---|---|---|
| Autonomous screening, token-first | Five-minute cycle in `src/viero/cli.ts:94-170` | GMGN-only discovery in `src/viero/workers/screeningWorker.ts:226-238` and `src/viero/discovery/tokenScreener.ts:140-164`; no EVM RPC in the normal path | **CODE-INFERRED:** approximately zero EVM calls when no candidate is handed off and no open position exists |
| Candidate enrichment/selection | Selected candidate from `executeCandidateToken()` (`src/viero/workers/screeningWorker.ts:452-655`) | Pool discovery/identity: `eth_blockNumber`, factory/PositionManager reads, V4 Initialize `eth_getLogs`; verification: `eth_getCode`, `eth_call`; economics: `eth_getBlockByNumber`, `eth_getLogs`, `eth_getTransactionByHash`, balances, gas, ticks/bitmap | **CODE-INFERRED:** tens to hundreds of logical calls per selected candidate; log pagination recursively subdivides on capped/erroring ranges (`src/viero/adapters/events.ts:8-35`); retries/fallback can multiply physical requests |
| Automated position monitoring | Five-minute management in `src/viero/cli.ts:136-145` and `src/viero/workers/screeningWorker.ts:660-810` | `eth_blockNumber`/block-pinned verification, `eth_getCode`, many `eth_call` reads for pool state, V3/V4 fee evidence, balances, token metadata, entry receipt/transaction | **CODE-INFERRED:** roughly 12–20 logical calls per position/tick before retries; canonical evidence fallback can repeat observations |
| Automated close | Confirmed management rule and independent confirmation (`screeningWorker.ts:978-1058`) | Fresh verification/fee reads; `eth_call` simulations; `eth_getBalance`; `eth_getTransactionReceipt`; close transaction; post-close reconciliation and optional normalization | Fresh confirmation is intentionally duplicated for safety. It is a likely burst, not a continuous baseline |
| Manual LP open | Operator/manual bot submits a new LP | In this checkout, live open is `executor.open()` (`src/viero/execution/executor.ts:250-355`): chain/block/pool verification, balances, Permit2 allowance `eth_call`, `eth_estimateGas`/simulation, approvals/wrap, `eth_sendRawTransaction`, receipt reads. A separate manual bot may use a different path | One operation can include multiple approvals, wrap, simulation, receipt polling, and final position reads |
| Manual LP close | Operator/manual bot closes a position | `executor.close()` (`src/viero/execution/executor.ts:400-450`): inspect liquidity, fresh state, simulation, decrease/collect, receipts, transfer decoding, realized-PnL reads | Close plus receipt polling; V4 `modifyLiquidities` and V3 decrease/collect paths differ |
| Manual claim | Telegram callback or manual signer action (`telegram.ts:779-812`, `screeningWorker.ts:1084-1104`) | V3/V4 `eth_call` simulation, `eth_sendRawTransaction`, receipt and transfer decoding | Low frequency but bursty; exact method count depends on token/protocol |
| Manual swap/normalization | Post-close autoswap (`executor.normalize()` and `execution/relay.ts`) | Token `balanceOf`/native balance `eth_call`, Relay HTTP quote/execute, signer transaction/receipt methods | Relay itself is HTTP, not EVM RPC; signer/client still reads balances and receipts |
| Manual position refresh | Telegram Refresh (`telegram.ts:779-826`) | Read-only pool verification/enrichment: `eth_blockNumber`, `eth_getCode`, `eth_call`, fee-growth reads, receipt/transaction lookup | One refresh is small; repeated operator refreshes can resemble management reads |
| Shared infrastructure | Service startup and every RPC caller | `src/viero/clients/publicClients.ts`: `eth_chainId`, `eth_blockNumber`, `eth_getCode`; HTTP batching, fallback transports, `retryCount: 2` | Agent and Telegram preflight each repeat deployment code checks; configured chains can amplify startup work |
| Legacy indexer | Only when explicitly enabled | `src/viero/indexer/protocol.ts`: large-range `eth_getLogs`, end-block reads, checkpoints | Potentially very expensive cold scans; prior VPS inspection found it inactive/disabled |

Telegram long-poll/report delivery itself is not EVM RPC. `/refresh`, `/screen`, and write callbacks are exceptions.

## 4. Historical Alchemy data, Oct 8–14

The official CLI returned 9,795,410 compute units and provider-reported $4.41 for the account. The grouped daily query returned only Oct 8–14; Oct 1–7 were unavailable through this CLI query.

| UTC day | Compute units | Allocated USD* | Context |
|---|---:|---:|---|
| Oct 8 | 1,179,998 | $0.5312 | Autonomous + manual potentially active |
| Oct 9 | 3,986,832 | $1.7949 | Autonomous + manual potentially active |
| Oct 10 | 2,677,818 | $1.2056 | Transition; excluded |
| Oct 11 | 266,456 | $0.1200 | Manual LP continued; autonomous stopped |
| Oct 12 | 286,454 | $0.1290 | Manual LP continued; autonomous stopped |
| Oct 13 | 528,626 | $0.2380 | Manual LP continued; autonomous stopped |
| Oct 14 | 632,096 | $0.2846 | Manual LP continued; autonomous stopped |

\*Allocated USD distributes the account-level $4.41 linearly by CU. It is not an invoice allocation.

### Method comparison

| Method | Oct 8–9 CU | Oct 11–14 CU | Likely sources |
|---|---:|---:|---|
| `eth_call` | 1,722,240 | 122,772 | Candidate verification, management/refresh, manual LP reads/simulations |
| `eth_getLogs` | 1,587,300 | 120,900 | Candidate/event enrichment, indexer if enabled, manual transaction/event inspection |
| `eth_getBlockByNumber` | 685,640 | 580 | Block-pinned enrichment and event metrics |
| `eth_getCode` | 407,960 | 0 | Preflight/verification |
| `alchemy_getAssetTransfers` | 368,160 | 1,442,400 | Not present in this checkout; manual bot/SDK or another client is plausible |
| `eth_getTransactionByHash` | 255,200 | 5,180 | Event enrichment, receipt/basis inspection, manual operation reconciliation |
| `eth_getBalance` | 109,960 | 1,660 | Execution, normalization, manual LP balance checks |
| `eth_getTransactionReceipt` | 5,920 | 6,700 | Execution and manual receipt polling |

Network totals were BNB 4,910,824 CU and Robinhood 256,006 CU pre-stop retained; BNB 1,316,932 CU and Robinhood 396,700 CU post-stop. These are account/app dimensions, not proof of which process issued the requests.

The average account usage fell from 2,583,415 CU/day on Oct 8–9 to 428,408 CU/day on Oct 11–14, an 83.42% decrease. With manual work continuing, this is consistent with autonomous workflows being the dominant incremental consumer, but the exact autonomous portion cannot be computed by subtraction because manual volume was not measured.

## 5. Manual-activity correlation

No local Oct 8–14 manual transaction journal or timestamped LP-operation record was available. Therefore:

- **Confirmed:** manual LP continued by the supplied operational context.
- **Plausible:** post-stop BNB/Robinhood `eth_call`, `eth_getLogs`, balance, receipt, and transaction-lookup activity is manual LP activity.
- **Not proven:** which individual manual open/close/claim/swap produced which daily or hourly row.

The correct next correlation is an operator export of manual bot events (UTC timestamp, chain, operation type, transaction hash) matched against Alchemy hourly usage. No private keys, RPC URLs, or credentials should be included.

## 6. Candidate-enrichment cost analysis

Candidate enrichment is the strongest code-derived explanation for the pre-stop spike. A selected candidate can cause:

1. External shortlist merge and V3/V4 identity recovery.
2. Pool bytecode/state/token metadata reads.
3. Historical pool-created and event-window block searches.
4. Swap logs, per-event block/transaction/slot reads, gas price, depth bitmap/tick reads.
5. Fresh planner/simulation checks.

This directly matches the pre-stop dominance of `eth_call`, `eth_getLogs`, block lookups, and code checks. It is also the most bursty workflow and can evaluate more than one pool before selecting a candidate. The evidence supports ranking candidate enrichment as the most likely autonomous CU driver, with position management second.

## 7. Position-management cost analysis

Each open position is refreshed every five minutes. V4 fee accounting uses StateView calls; V3 accounting reads NFPM positions, fee-growth globals, and boundary ticks. Management also reads the entry receipt/transaction to preserve the canonical entry basis. When a rule is proposed, an independent fresh confirmation is performed before signer handoff.

This creates a steady autonomous baseline proportional to open-position count. It explains `eth_call`, receipts, balances, and some block reads, but it is less likely than candidate enrichment to explain multi-million-CU event/log spikes unless many positions were open or repeated evidence fallbacks occurred.

## 8. `alchemy_getAssetTransfers` investigation

The string `alchemy_getAssetTransfers` does not occur in the checked-in source, package manifest/lockfile, or installed dependency source inspected with `rg`. Viero's direct client is viem (`src/viero/clients/publicClients.ts`) and its source-level EVM calls are standard `eth_*` methods. The Relay SDK is used for HTTP quote/normalization and does not expose this method in the inspected checkout.

Therefore:

- **Confirmed:** this method is not a direct call in the current repository/dependency tree.
- **Plausible:** the continued manual LP bot uses an Alchemy SDK/helper, an external process, or a separate deployment that calls Asset Transfers.
- **Unknown:** whether the Alchemy app ID is shared with that bot, and whether a provider-side integration generated the rows.

The post-stop dominance of Asset Transfers (1,442,400 CU of 1,713,632 post-stop CU) makes manual-bot or other-client ownership the first investigation target. It should not be attributed to autonomous Viero merely because it shares the account.

## 9. Ranked optimization opportunities

1. **Instrument by workload before changing behavior.** Add read-only counters at the PublicClient boundary keyed by process role, operation ID, chain, method, retry, and release. This is the highest-value measurement and preserves all safety checks.
2. **Reduce candidate-enrichment fan-out after measurement.** Cache immutable token metadata and verified external pool hints; retain fresh pool state, block pinning, depth evidence, reorg checks, and identity verification.
3. **Bound log pagination intelligently.** Record page splits and provider response sizes; tune safe per-chain ranges without accepting partial logs or weakening fail-closed behavior.
4. **Cache immutable position facts.** Cache verified token metadata and confirmed entry receipt/basis; keep current pool state, fee evidence, prices, and pre-close confirmation fresh.
5. **Avoid duplicate startup preflight.** Share a short-lived, block-pinned result between agent/Telegram or make the policy explicit; do not remove chain/code checks without a freshness guarantee.
6. **Keep the legacy indexer disabled unless explicitly required.** Alert on accidental activation and measure cold-start scans before enabling.
7. **Separate manual and autonomous Alchemy apps/projects if practical.** This makes attribution immediate and avoids account-level ambiguity; it does not alter trading logic.

Do not optimize by removing fresh signer-handoff confirmation, identity verification, reorg checks, missing-depth fail-closed behavior, or transaction authorization gates.

## 10. Evidence gaps

- Oct 1–7 retention was unavailable through the CLI query.
- No local Oct 8–14 manual operation journal or RPC counter exists.
- The CLI exposes an opaque app ID, not process ownership.
- Compute units do not provide exact per-workload USD without plan/credit details.
- Hourly operation hashes/timestamps were not available for correlation.
- The Asset Transfers caller is outside this checkout or hidden behind a remote/external client.

## 11. Recommended next measurement

Run a controlled, read-only 24-hour measurement with:

1. Autonomous Viero stopped and manual bot operation timestamps exported separately.
2. A PublicClient transport counter in each process (no URL, key, header, or payload logging).
3. Hourly Alchemy timeseries grouped by app/network/method.
4. Manual operation records containing only UTC time, chain, operation class, and transaction hash.
5. Correlation of method/CU changes before and after one workload is paused, without sending test transactions.

This will quantify the autonomous incremental cost while preserving fresh on-chain confirmation, deterministic policy, fail-closed behavior, position identity verification, authorization safety, and emergency-close responsiveness.
