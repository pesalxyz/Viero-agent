# Reference Analysis

## UniCrit

The private UniCrit repository was reviewed through authenticated read-only access.

- Memecoin exits use GMGN, not Relay or a direct Uniswap route.
- A close to native ends after the GMGN swap. A close to stable first exits through GMGN to native, then wraps and swaps through local Uniswap v3. Arc exits directly to its USDC predeploy.
- Relay and Across are compared for supported listed native/stable swaps and bridges. They are not the memecoin close path.
- The custom token swap command prefers the Uniswap Trading API and falls back to a local v3 route.
- Canonical pricing is GMGN first and GeckoTerminal fallback. Stablecoins use a fixed dollar peg. DexScreener is discovery-only; UniCrit does not require two concurrent independent prices.

Viero now follows that pricing order. It remains read-only, so the transaction routes were analyzed but not copied into an execution path.

## Meridian

[Meridian](https://github.com/yunus-0x/meridian) is a Solana Meteora DLMM agent. It uses the Meteora SDK for on-chain positions and bins, Meteora APIs for pool/PnL history, and Jupiter for token prices. Its useful transferable pattern is to separate live on-chain position value from API-supplied history and to fail when a price is missing. Its bin and fee implementation cannot be reused for EVM concentrated-liquidity pools.

Viero therefore implements EVM normalization directly from Uniswap/Pancake factories, PoolManager events, pool state, swap events, and tick bitmaps. Public aggregators and subgraphs can supply indicative liquidity or indexed swaps, but they do not provide one uniform, auditable LP-net fee and depth contract across all four configured chains and venues.
