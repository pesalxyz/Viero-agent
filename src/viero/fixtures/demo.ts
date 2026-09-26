import { zeroAddress, type Address, type Hex } from 'viem';
import { CHAIN_IDS, observationSchema, poolId, type Observation, type PoolRef } from '../domain.js';
import { getChain } from '../config/chains.js';
import { Q96 } from '../screening/math.js';

export const DEMO_TIME = 1_789_680_000;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export function demoObservations(now = DEMO_TIME): Observation[] {
  const observations: Observation[] = [];
  let index = 0;
  for (const chainId of CHAIN_IDS) for (const path of chainId === 56 ? ['v3', 'v4', 'pancake'] : ['v3', 'v4']) {
    index++;
    const chain = getChain(chainId), decimals = chainId === 56 ? 18 : 6;
    const token0 = { chainId, address: address(index), symbol: `PAPER${index}`, decimals };
    const token1 = { chainId, address: chain.primaryStable, symbol: chainId === 4663 ? 'USDG' : chainId === 56 ? 'USDT' : 'USDC', decimals };
    const fee = path === 'pancake' ? 2500 : 3000;
    const key = { currency0: token0.address, currency1: token1.address, fee, tickSpacing: 60, hooks: zeroAddress };
    const pool: PoolRef = path === 'v4' ? { chainId, protocol: 'v4', dex: 'uniswap', poolId: poolId(key), poolKey: key }
      : { chainId, protocol: 'v3', dex: path === 'pancake' ? 'pancakeswap' : 'uniswap', poolAddress: address(1000 + index) };
    const blockNumber = BigInt(100000 + now - DEMO_TIME);
    observations.push(observationSchema.parse({
      state: { pool, token0, token1, blockNumber, blockHash: hash(Number(blockNumber)), observedAt: now, fetchedAt: now,
        sqrtPriceX96: Q96, tick: 0, tickSpacing: 60, liquidity: 6000000n * 10n ** BigInt(decimals), fee, protocolFee: 0, dynamicFee: false,
        verified: true, verification: ['synthetic-replay-fixture'] },
      windowStart: now - 1800, windowEnd: now, source: 'synthetic-demo', indexedBlock: blockNumber,
      complete: true, valuation: 'historical-usd', tvlUsd: 5_000_000, poolCreatedAt: now - 10 * 86400,
      ticks: [], ticksComplete: true, positionsCreated: 8 + index, uniqueLps: 6 + index,
      liquidityAddedUsd: 200000, liquidityRemovedUsd: 10000, estimatedLifecycleCostUsd: .004 + index * .0001,
      prices: [token0, token1].flatMap(t => ['fixture-a', 'fixture-b'].map(source => ({ chainId, token: t.address, usd: 1, source, observedAt: now, fetchedAt: now }))),
      risks: [token0, token1].map(t => ({ chainId, token: t.address, observedAt: now, source: 'synthetic-fixture', honeypot: false, criticalAdmin: false,
        sellTaxBps: 0, top10HolderPct: 15, buySimulation: true, sellSimulation: true, smartMoneyScore: .7 })),
      swaps: Array.from({ length: 120 }, (_, i) => {
        const volumeUsd = 25000 + index * 100, amount = BigInt(volumeUsd) * 10n ** BigInt(decimals);
        return { pool, blockNumber: blockNumber - BigInt(119 - i), transactionHash: hash(index * 1000 + i), logIndex: 0,
          timestamp: now - 1790 + i * 15, trader: address(10000 + i % 40), amount0: i % 2 ? amount : -amount, amount1: i % 2 ? -amount : amount,
          price1Per0: 1 + Math.sin(i / 10) * .0001, volumeUsd, grossFeeUsd: volumeUsd * fee / 1_000_000, lpFeeUsd: volumeUsd * fee / 1_000_000 * .9 };
      }), issues: ['Synthetic replay data. These addresses and returns are not live opportunities.'],
    }));
  }
  return observations;
}
