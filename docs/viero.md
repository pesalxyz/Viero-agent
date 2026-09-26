# Viero LP Agent

This implementation follows the blueprint's first end-to-end slice: multi-chain discovery, exact-pool verification, reproducible metrics, deterministic screening, ranking, and persisted reports. It also includes bounded paper plans and lifecycle replay. The original EVM MCP server remains available separately.

The Viero entry point has **no signer, private-key reader, approvals, or transaction broadcaster**. The blueprint explicitly makes a continuously validated read-only pipeline a prerequisite for adding execution. Live execution, funded mint/claim/close tests, and capital autonomy are not implemented or represented as complete.

## Quick start

Node 20.12+ and npm are sufficient. Bun is not required for the agent or the combined build.

```sh
npm install
npm run check
npm run agent:demo -- --out data/viero/demo-report.md
npm run agent -- report
```

The demo is deterministic and makes no network calls. It covers Uniswap v3/v4 on Robinhood, BSC, Base, and Arc, plus PancakeSwap v3 on BSC. Every synthetic pool is explicitly labelled. Three consecutive 30-minute windows exercise four paper positions, fee accrual, range management, costs, and PnL. Demo token and pool addresses must never be used as live opportunities.

Full observations, source blocks, price and security snapshots, candidates, score components, rejections, model decisions, and paper positions are stored as atomic JSON files under `data/viero/runs`. All raw token amounts survive persistence as decimal strings and are rehydrated into bigints. `--out` writes a readable report; `--json` writes the complete result.

## Live read-only operation

Set environment variables from `.env.example`; the CLI reads a local `.env` if present. GMGN uses the installed `gmgn-cli` through `execFile`, with a validated argument array. GMGN requires `GMGN_API_KEY`; the agent never prints it. Credentials are not stored in run records.

```sh
npm run agent -- chains
npm run agent -- preflight
npm run agent -- smoke
npm run agent -- discover --chains 8453 --token-limit 3
npm run agent -- screen --chains 8453 --pool-limit 10 --out data/viero/live.md
npm run agent -- watch --chains 8453 --cycles 2
```

`smoke` confirms RPC chain IDs and bytecode at configured factories, position managers, quoters, and v4 state views. Live screening repeats startup checks and pins pool reads to a confirmed block. Each `VIERO_RPC_<chainId>` override accepts one URL or a comma-separated list; viem tries them in order and falls through on errors. Endpoints are never shared across chains.

`preflight` is the production startup gate. In addition to smoke checks, it verifies Node.js, initialized storage, GMGN authentication on each selected chain, and the absence of wallet private-key or mnemonic variables. See [deployment.md](deployment.md) for the versioned release and hardened systemd workflow.

Public RPC availability, rate limits, and historical log access vary. Base and Robinhood describe their public endpoints as rate limited, and BNB Chain disables `eth_getLogs` on its listed public mainnet endpoints. Complete live screening therefore needs operator-supplied RPCs with log access or the normalized indexer below. Failed checks produce nonzero exit status and explicit data gaps; missing evidence fails closed.

Discovery combines GMGN trending tokens, DEX Screener pairs, direct v3 factory lookups, optional normalized indexers, persisted/configured seed pools, and v4 Initialize logs. The default v4 event scan covers 30 minutes. Historical v4 discovery needs `--scan-from BLOCK`, complete seed PoolKeys, or a configured indexer. Coverage and pool limits are included in reports; a bounded scan is never called a full historical enumeration. Native v4 assets need an appropriate enriched price source; Arc native-sentinel pools are rejected.

`--seeds pools.json` accepts an array matching `PoolRef` in `src/viero/domain.ts`. A v3 seed contains `chainId`, `protocol`, `dex`, and `poolAddress`. A v4 seed contains `chainId`, `protocol`, `dex`, `poolId`, and the complete `poolKey`. Inputs do not bypass RPC verification.

The RPC observation path collects exact-pool swaps, unique transaction senders, one-minute candles, venue-normalized LP-net fees, and complete on-chain tick depth through the exact 1% targets. It values volume using captured window-end reference prices and identifies this valuation method. V3 TVL uses token balances; v4 TVL is unavailable without pool-aware accounting. Missing security, buy/sell simulation, and lifecycle-cost evidence intentionally reject candidates. Dynamic v4 fee overrides remain unavailable. The fallback does not manufacture those metrics or treat a quote as a transfer simulation.

For normalized historical pool enumeration and observations, run the included service described in [viero-indexer.md](viero-indexer.md). These URLs point to an operator-controlled normalized data service, not arbitrary subgraph URLs. Provider slugs are exhaustive routing configuration; availability is checked at runtime, not assumed from the blueprint.

## Policy and math

```sh
npm run agent -- demo --config config/viero.paper.json
npm run agent -- pause --chains 56
npm run agent -- resume --chains 56
npm run agent -- pause
npm run agent -- resume
```

Chain exposure, TVL, and depth defaults are in `src/viero/config/policy.ts`. They are paper placeholders from the blueprint, not investment recommendations. Every run stores the effective policy. The supervisor pauses a failing chain after three failed observation cycles; operator pauses survive restarts. Global and chain pauses are independent. The watch command rechecks them between cycles and handles SIGINT/SIGTERM. It schedules a sequential multi-chain screening cycle; independent management/risk/health schedules are future work.

All candidates require verified pool identity, approved quotes, pool age, two-sided depth, exact-pool activity, LP-net fees, a fresh canonical price, risk evidence for both tokens, successful simulation evidence, and positive lifecycle-cost-adjusted fees. Missing evidence rejects the pool. Price priority matches UniCrit: stablecoin peg, GMGN primary, GeckoTerminal fallback; DexScreener is discovery-only. Dynamic v4 pools require enriched LP-net fees; unknown hooks remain blocked. Exact pool identities include chain, protocol, and venue.

`@pancakeswap/v3-sdk` 3.9.3 provides the established concentrated-liquidity TickMath. It is pinned to avoid unrelated Solana and deprecated Hardhat dependency trees introduced by newer aggregate SDKs; the math is shared by these v3/v4 pool paths. Integer arithmetic computes amounts and traverses initialized ticks in both directions. A liquidity gap is rejected rather than extrapolated. Stored `tokensOwed` is not treated as total live fees: fee-growth helpers include modulo-2^256 accounting and Q128 accrual.

Ranking uses the blueprint's eight weights, normalizes within chain/window/age/quote groups, records penalties, and adds a global net-fee component. The implemented organic features are trader ratio, concentration, direction balance, minute coverage, and fast reversals. Common-funder clustering, bot/sandwich identification, and KOL attribution require additional indexed data and are not claimed as implemented.

Arc has one USDC balance. Its native 18-decimal and ERC20 6-decimal views must agree at the same block; the library converts by `10^12`, preserves dust, and subtracts gas reserves from the shared spendable balance. There is no wrapped-USDC abstraction.

## Paper lifecycle and model boundary

```sh
npm run agent -- replay observations.json --out data/viero/replay.md
```

The replay file is an array of time-ordered observation windows, each an array of `Observation` records. It screens all chains, creates bounded paper plans in the first window, and marks the resulting positions through subsequent windows. Fees accrue only for new swaps inside the range, avoiding double counting overlapping windows. Rules produce hold, economic claim, out-of-range rebalance, close, emergency-close, or pause decisions. Rebalance closes the paper position; a new entry must pass screening again. Replay does not automatically redeploy capital after an exit.

PnL includes marked principal, claimed/unclaimed fees, gas, swaps, and bridges; IL is measured against holding the original token amounts. Paper fees use a conservative TVL-share estimate, not a historical tick-level liquidity-share or execution-fill model. Paper exit events are hypothetical decisions, not guarantees that a live exit would succeed. Do not interpret synthetic results as expected returns.

The default decision selector is deterministic. `DecisionModel` in `agent/runtime.ts` is an injectable model interface: it receives only approved IDs and numeric summaries, returns a strict bounded action, and cannot select another contract, change policy, or sign. No external LLM service is configured or required. Chain exposure and daily loss checks are implemented in the planner; CLI previews start from an explicitly hypothetical empty portfolio. They are not authorization against a live wallet portfolio.

## MCP

```sh
npm run agent:mcp
VIERO_ROLE=manager npm run agent:mcp
```

For an MCP client, launch `node` with the absolute path to `build/viero/mcp.js` after `npm run build`. Set its working directory to this repository or use absolute data/env paths. Keep stdout reserved for MCP protocol messages.

The screener exposes chain discovery, pool verification, raw GMGN detail/security/holders, wallet balances, saved pool metrics, fresh re-screened candidates, and paper-only previews. The manager exposes saved paper positions and PnL. This manager does **not** enumerate live wallet NFTs or submit claims. The original upstream EVM server has broad write tools and is deliberately not imported into this agent process. Do not substitute `build/index.js` for the agent entry point.

## PostgreSQL and tests

```sh
docker compose -f compose.viero.yml up -d
DATABASE_URL=postgres://viero:viero@localhost:5433/viero npm run agent:demo
TEST_DATABASE_URL=postgres://viero:viero@localhost:5433/viero npm test
```

The development database binds only to loopback and uses disposable local credentials. Schema initialization is idempotent. Each run, its chain-scoped observations, and screening decisions commit in one SQL transaction. Full JSONB envelopes preserve the remaining entities without pretending the blueprint's complete normalized TimescaleDB model is present. TimescaleDB and continuous aggregates are future migrations.

`npm run check` performs TypeScript checking, offline unit/integration tests, an actual MCP stdio handshake, and both server/agent builds. Tests cover the nine protocol/venue paths, factory spoofing, v4 IDs and hooks, Arc conversions/reserves, stale and missing data, pagination, wrong-chain isolation, provider backoff, planner limits, bounded model decisions, replay accounting, and pause controls. The PostgreSQL test runs when `TEST_DATABASE_URL` is available; CI starts a PostgreSQL service for it. Read-only mainnet checks run separately with `smoke` and never require a wallet key.

## Next release gates

- Continuously validate live pipeline coverage and reproducibility against operator-controlled indexers and authenticated providers.
- Add live v3/v4 NFT enumeration, multicall position monitoring, and block-level fee reconciliation.
- Implement isolated signing, decoded transfer/approval simulation, per-wallet nonces, and receipt reconciliation.
- Test complete v3/v4/Pancake lifecycles on appropriate forks/testnets, including Arc-specific behavior.
- Add manual-approval execution with limited wallets before enabling any entry autonomy.

Deployment provenance is versioned in `config/chains.ts`, using [Uniswap's official deployment feed](https://developers.uniswap.org/deployments.json), [PancakeSwap's v3 addresses](https://developer.pancakeswap.finance/contracts/v3/addresses), [Robinhood token contracts](https://docs.robinhood.com/chain/contracts/), and [Arc network configuration](https://docs.arc.io/integrate/connect-to-arc). Arc accounting follows the [official compatibility guide](https://www.arc.io/blog/arc-compatibility-guide-for-existing-evm-apps). Addresses are validated against RPC at runtime; documentation is not proof of deployed bytecode.
