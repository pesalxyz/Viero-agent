import { zeroAddress, type Address } from 'viem';
import { getChain } from '../config/chains.js';
import { type ChainId, type PoolRef, poolSchema, poolIdentity, addressSchema, errorMessage } from '../domain.js';
import { PublicClients, assertChain } from '../clients/publicClients.js';
import { Gmgn, Market, type DexPair } from '../adapters/providers.js';
import { Indexer } from '../adapters/indexer.js';
import { factoryAbi, initializeEvent } from '../adapters/abi.js';
import { firstBlockAt, pagedLogs } from '../adapters/events.js';

export type DiscoveryResult = { chainId: ChainId; pools: PoolRef[]; tokens: Address[]; pairs: DexPair[]; issues: string[]; coverage: string[] };
export async function discover(chainId: ChainId, services: { clients: PublicClients; gmgn: Gmgn; market: Market; indexer: Indexer }, options: { tokenLimit: number; seeds?: PoolRef[]; scanFrom?: bigint } = { tokenLimit: 3 }): Promise<DiscoveryResult> {
  const c = getChain(chainId), client = services.clients.get(chainId);
  const result: DiscoveryResult = { chainId, pools: [], tokens: [], pairs: [], issues: [], coverage: [] };
  await assertChain(client, chainId);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  let discoveryTokens: Address[] = [];
  try { discoveryTokens = await services.gmgn.trending(chainId, '1h', options.tokenLimit); result.coverage.push('GMGN trending 1h'); }
  catch (e) { result.issues.push(errorMessage(e)); }
  result.tokens = [...new Set([...discoveryTokens, ...c.quoteTokens])];
  const seedIds = new Set<string>();
  for (const seed of options.seeds ?? []) {
    const pool = poolSchema.parse(seed);
    if (pool.chainId === chainId) { result.pools.push(pool); seedIds.add(poolIdentity(pool)); }
  }
  for (const token of result.tokens) {
    try { result.pairs.push(...await services.market.pools(chainId, token)); }
    catch (e) { result.issues.push(errorMessage(e)); }
  }
  for (const pair of result.pairs) {
    const dex = pair.dexId === 'uniswap' ? 'uniswap' : pair.dexId === 'pancakeswap' && chainId === 56 ? 'pancakeswap' : null;
    if (!dex) continue;
    const parsed = addressSchema.safeParse(pair.pairAddress);
    if (parsed.success && pair.labels?.some(label => label.toLowerCase() === 'v3')) result.pools.push({ chainId, protocol: 'v3', dex, poolAddress: parsed.data });
  }
  // Factory lookups discover supported v3 fee tiers even when a discovery API is unavailable.
  const searchedPairs = new Set<string>();
  for (const token of discoveryTokens) for (const quote of c.quoteTokens) {
    if (token === quote) continue;
    const pairKey = [token, quote].sort().join(':');
    if (searchedPairs.has(pairKey)) continue;
    searchedPairs.add(pairKey);
    for (const [dex, deployment] of Object.entries(c.v3)) for (const fee of deployment.feeTiers) {
      try {
        const poolAddress = await client.readContract({ address: deployment.factory, abi: factoryAbi, functionName: 'getPool', args: [token, quote, fee], blockNumber: head });
        if (poolAddress !== zeroAddress) result.pools.push({ chainId, protocol: 'v3', dex: dex as 'uniswap' | 'pancakeswap', poolAddress: addressSchema.parse(poolAddress) });
      } catch (e) { result.issues.push(`${dex} factory: ${errorMessage(e)}`); }
    }
  }
  result.coverage.push('V3 factory quote pairs and configured fee tiers');
  if (services.indexer.configured(chainId)) {
    try { result.pools.push(...await services.indexer.discover(chainId)); result.coverage.push('Paginated indexer'); }
    catch (e) { result.issues.push(errorMessage(e)); }
  }
  try {
    const block = await client.getBlock({ blockNumber: head });
    const from = options.scanFrom ?? await firstBlockAt(client, head, Number(block.timestamp) - 1800);
    const logs = await pagedLogs(from, head, (fromBlock, toBlock) => client.getLogs({ address: c.v4.poolManager, event: initializeEvent, strict: true, fromBlock, toBlock }));
    for (const log of logs) {
      if (log.removed) throw new Error('REORG_DURING_V4_DISCOVERY');
      const k = log.args;
      result.pools.push(poolSchema.parse({ chainId, protocol: 'v4', dex: 'uniswap', poolId: k.id,
        poolKey: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks } }));
    }
    result.coverage.push(`V4 Initialize events, blocks ${from}-${head}`);
    if (options.scanFrom === undefined) result.issues.push('Historical v4 pools require persisted seeds, an indexer, or --scan-from; default scan covers 30 minutes');
  } catch (e) { result.issues.push(`V4 discovery: ${errorMessage(e)}`); }
  const pairLiquidity = new Map(result.pairs.map(pair => [pair.pairAddress.toLowerCase(), pair.liquidity?.usd ?? 0]));
  result.pools = [...new Map(result.pools.map(p => [poolIdentity(p), p])).values()].sort((left, right) => {
    const leftId = poolIdentity(left), rightId = poolIdentity(right);
    const seedOrder = Number(seedIds.has(rightId)) - Number(seedIds.has(leftId));
    if (seedOrder) return seedOrder;
    const leftLiquidity = left.protocol === 'v3' ? pairLiquidity.get(left.poolAddress) ?? 0 : 0;
    const rightLiquidity = right.protocol === 'v3' ? pairLiquidity.get(right.poolAddress) ?? 0 : 0;
    return rightLiquidity - leftLiquidity || leftId.localeCompare(rightId);
  });
  result.issues = [...new Set(result.issues)];
  return result;
}
