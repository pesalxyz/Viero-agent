# Normalized Indexer Contract

The included operator-controlled indexer normalizes v3/v4 pool discovery, swaps, pricing, LP-net fees, and 1% depth into the common `Observation` schema. Configure one `VIERO_INDEXER_<chainId>` URL per chain. The agent validates every response and independently reads the pool at the requested block. External responses are data, never instructions.

Run it with `npm run agent:indexer`. Set `VIERO_INDEXER_START_<chainId>` to a block at or before every configured v3 factory and v4 PoolManager deployment on that chain. The service scans `PoolCreated` and `Initialize`, persists an atomic per-chain pool/checkpoint file under `VIERO_INDEXER_DATA_DIR`, and refuses a chain with no explicit start block. It verifies the saved checkpoint block hash before advancing, failing closed on a reorg or configuration mismatch. For one local process, point all enabled `VIERO_INDEXER_<chainId>` values to `http://127.0.0.1:9100`.

Historical backfill starts in the background, one chain at a time. It commits an atomic checkpoint every one million blocks, discarding each chunk's raw logs before advancing so memory stays bounded and restart recovery resumes from the last chunk. `/health` reports each checkpoint and pool count; `/v1/pools` returns `503 INDEX_SYNCING` until that chain has its first durable checkpoint. The agent treats that as degraded data and retries on a later cycle.

## Pool pagination

`GET /v1/pools?chainId=56&cursor=opaque-cursor`

```json
{
  "chainId": 56,
  "pools": [
    {
      "chainId": 56,
      "protocol": "v3",
      "dex": "pancakeswap",
      "poolAddress": "0x0000000000000000000000000000000000000001"
    }
  ],
  "nextCursor": null,
  "complete": true
}
```

This address is a schema example, not a deployment. `complete` attests that the page is not truncated; `nextCursor: null` terminates the result set. Cursors must advance. The client exhausts pages, rejects mixed chains, and deduplicates by exact pool. HTTP errors and rate limits produce observable provider health/backoff state.

## Block-pinned observations

`POST /v1/observations`, with JSON containing:

```json
{
  "pool": { "chainId": 56, "protocol": "v3", "dex": "pancakeswap", "poolAddress": "0x0000000000000000000000000000000000000001" },
  "blockNumber": "100000",
  "blockHash": "0x0000000000000000000000000000000000000000000000000000000000000001",
  "windowStart": 1789680000,
  "windowEnd": 1789681800
}
```

The response is exactly the `observationSchema` exported from `src/viero/domain.ts`. A complete generated example is available through `demoObservations()` in `src/viero/fixtures/demo.ts`; the demo is explicitly synthetic and must not be returned as live data. Serialize all bigint fields as base-10 strings. Required fields:

| Field | Contract |
| --- | --- |
| `state` | Exact PoolRef, token identities/decimals, pinned block/hash, tick, sqrtPriceX96, fee model, liquidity, timestamps. RPC state replaces this after identity/decimal checks. |
| `windowStart`, `windowEnd` | Complete configured interval in Unix seconds, ending no later than the verified state. |
| `source`, `indexedBlock`, `complete` | Nonempty provenance, indexer block, and an explicit no-truncation attestation. |
| `valuation` | `historical-usd` for block/window-appropriate USD observations; `window-end-reference` for revaluation with captured current prices. |
| `swaps` | PoolRef, block, transaction hash/log index, timestamp, transaction sender, signed pool deltas, token1/token0 human-unit price, one-sided USD notional, gross fees, LP-net fees. |
| `prices` | Chain, token, positive finite USD price, source, observed and fetched timestamps. Canonical order is stablecoin peg, GMGN, then GeckoTerminal fallback. |
| `risks` | Chain/token/time/source; explicit honeypot/admin/tax/concentration and buy/sell simulation evidence. Unknown booleans/numbers are `null`. |
| `tvlUsd`, `poolCreatedAt` | Exact-pool TVL and creation time, or `null` if unavailable. Never derive v4 TVL from PoolManager's total balances. |
| `ticks`, `ticksComplete` | All initialized ticks from the current price through both exact 1% price targets, with signed `liquidityNet`. `ticksComplete` attests full bitmap coverage for that range. |
| `positionsCreated`, `uniqueLps` | Exact-pool counts in the window, or `null`. |
| `liquidityAddedUsd`, `liquidityRemovedUsd` | Exact-pool liquidity flows, or `null`. |
| `estimatedLifecycleCostUsd` | Entry, claim, rebalance, exit, and swap cost budget in USD, or `null`. |
| `issues` | Human-readable limitations carried alongside the observation. |

Use positive input/negative output deltas, matching v3 pool semantics. Negate v4 caller deltas when normalizing. Swap IDs are unique `(chainId, transactionHash, logIndex)`; trade routing through multiple pools must not combine their notional. Unique transaction senders are not necessarily unique human traders, particularly with account abstraction or aggregators.

For Uniswap v3, LP-net fees apply the directional denominator encoded in `slot0.feeProtocol`. PancakeSwap v3 uses its directional 1/10,000 share and exposes the exact protocol token amount in each swap event. Uniswap v4 combines the directional protocol fee with the static LP fee using v4's sequential fee formula. Dynamic v4 fee overrides remain `null` because the swap event exposes only the combined fee; unknown hooks remain rejected. Simulations need actual token-transfer behavior in both directions, not a router quote or a missing flag defaulted to safe.

The included service intentionally leaves token risk/simulation, position-flow, v4 TVL, and lifecycle-cost fields unavailable. Those are separate enrichment jobs. This keeps the on-chain index complete for pool identity, swap history, static-pool LP-net fees, and 1% depth without relabeling missing screening evidence as complete.

The indexer is an explicit trust boundary for off-chain risk, completeness, and USD attribution. The agent verifies chain/pool state independently and rejects inconsistent evidence, but it cannot prove an external indexer's completeness from the payload alone. Retain your indexer's underlying receipts, swap events, pricing observations, and simulation traces for independent reproduction.
