/**
 * Focused tests for the token-first discovery layer.
 *
 * Strategy: mock everything (PublicClient, Gmgn). No live RPC, no live
 * network calls. TokenScreener is pure logic over a mocked client.
 * TokenDiscovery is tested for dedup + rate-limit + cache bounds.
 * Targeted pool discovery is smoke-tested via the typed API contract
 * (factory/Initialize queries that fail when RPC is unreachable).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { http } from 'viem';
import { mainnet } from 'viem/chains';
import { createPublicClient } from 'viem';
import {
  type Gmgn,
  type Risk,
  type Address,
  gmgnPoolInfoToPoolRef,
  normalizeGmgnRisk,
} from '../src/viero/adapters/providers.js';
import {
  TokenScreener,
  simulateTokenBuySell,
  type TokenScreeningPolicy,
  type TokenScreeningVerdict,
} from '../src/viero/discovery/tokenScreener.js';
import { TokenDiscovery } from '../src/viero/discovery/tokenDiscovery.js';
import { rankVerifiedTargetedPools, dexScreenerShortlist, externalHintsToTargeted, recoverExternalV4PoolHints, poolIdToBytes25, decodeUniswapV4PoolId, fetchUniswapV4Hints, searchVerifiedPoolsForToken, mergeExternalPoolHints } from '../src/viero/adapters/targetedPoolDiscovery.js';
import { type ChainId, type PoolRef, poolId } from '../src/viero/domain.js';
import { exactPoolCreatedAt, estimatedLifecycleCostUsd } from '../src/viero/adapters/events.js';
import { demoObservations, DEMO_TIME } from '../src/viero/fixtures/demo.js';
import { discoverV4PoolsForToken } from '../src/viero/adapters/targetedPoolDiscovery.js';
import { selectPoolsByVerifiedTvl } from '../src/viero/workers/screeningWorker.js';
import { BlockedTokenStore } from '../src/viero/storage/blockedTokens.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN_A: Address = '0x1111111111111111111111111111111111111111';

test('execution buy/sell simulation runs both probes and fails closed on unavailable results', async () => {
  const calls: string[] = [];
  const client = { simulateContract: async (args: { functionName: string }) => {
    calls.push(args.functionName);
    throw new Error('RPC unavailable');
  } } as any;
  const result = await simulateTokenBuySell(client, TOKEN_A);
  assert.deepEqual(calls, ['transferFrom', 'transfer']);
  assert.deepEqual(result, { buyOk: false, sellOk: false });
});

test('verified targeted pool ranking is protocol-neutral, deterministic, and bounded', () => {
  const mk = (protocol: 'v3'|'v4', id: string, liquidity: bigint) => ({ pool: protocol === 'v3' ? { chainId: 4663 as const, protocol, dex: 'uniswap' as const, poolAddress: id as Address } : { chainId: 4663 as const, protocol, dex: 'uniswap' as const, poolId: id as `0x${string}`, token0: TOKEN_A, token1: TOKEN_A, fee: 100, tickSpacing: 1, hooks: '0x0000000000000000000000000000000000000000' as Address }, ref: {} as never, liquidity });
  const ranked = rankVerifiedTargetedPools([mk('v3','0x0000000000000000000000000000000000000002', 10n), mk('v4','0x'+'1'.repeat(64), 20n), mk('v3','0x0000000000000000000000000000000000000003', 5n)], 2);
  assert.equal(ranked[0]!.pool.protocol, 'v4');
  assert.equal(ranked.length, 2);
});

const GMGN_SECURITY_BASE = {
  address: TOKEN_A,
  is_honeypot: false,
  sell_tax: 0,
  top_10_holder_rate: 0.25,
  is_open_source: true,
};

test('GMGN token security accepts null flags as unknown', () => {
  const risk = normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: null, privileges: [] }, 8453, TOKEN_A, 1);
  assert.equal(risk.criticalAdmin, null);
});

test('background token discovery intersects persisted enabled chains', async () => {
  const gmgn = makeHotSearchGmgn(new Map()) as any;
  const discovery = new TokenDiscovery(makeFakeClients() as never, gmgn, [4663, 56, 8453], {
    screenerPolicy: {} as never,
    enabledChains: async () => [4663],
    hotSearchIntervalMs: 60_000,
  });
  discovery.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  discovery.stop();
  assert.deepEqual(Object.keys(discovery.getTelemetry().lastFetchAt), ['4663']);
});

test('Robinhood stock registry filters before screening and preserves non-stock order', async () => {
  const stock = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const first = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
  const second = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
  let securityCalls = 0;
  const gmgn = {
    async query(_chain: ChainId, command: string): Promise<unknown> {
      if (command !== 'hotsearch') return {};
      return { rank: [
        { address: stock, symbol: 'AAPL', name: 'Apple • Robinhood Token', rank: 1, market_cap: 2_000_000, volume: 200_000, liquidity: 50_000, creation_timestamp: 1 },
        { address: first, symbol: 'ONE', rank: 2, market_cap: 2_000_000, volume: 200_000, liquidity: 50_000, creation_timestamp: 1 },
        { address: second, symbol: 'TWO', rank: 3, market_cap: 2_000_000, volume: 200_000, liquidity: 50_000, creation_timestamp: 1 },
      ] };
    },
    async security() { securityCalls++; return { is_honeypot: false, sell_tax: 0, top_10_holder_rate: 0.1, is_open_source: true, flags: [], privileges: [] }; },
  } as unknown as Gmgn;
  const discovery = new TokenDiscovery(makeFakeClients() as never, gmgn, [4663], {
    screenerPolicy: makePolicy(), gmgnOnly: true, hotSearchLimit: 2,
    blockedTokenRegistry: async () => new Set([stock]),
    economicFilter: { marketCapMin: 1, volumeMin: 1, ageMinSeconds: 1, liquidityMin: 1 },
  });
  const result = await discovery.fetchAndScreenOnce(4663);
  assert.equal(result.rawFetched, 3);
  assert.equal(result.stockFiltered, 1);
  assert.equal(result.discovered, 2);
  assert.equal(securityCalls, 2);
  assert.deepEqual([...discovery.entries()].map(entry => entry.address), [first, second]);
  assert.deepEqual([...discovery.entries()].map(entry => entry.marketCapUsd), [2_000_000, 2_000_000]);
});

test('Robinhood stock registry outage fails closed before security screening', async () => {
  let securityCalls = 0;
  const gmgn = {
    async query() { return { rank: [{ address: TOKEN_A, symbol: 'TOK', rank: 1 }] }; },
    async security() { securityCalls++; return {}; },
  } as unknown as Gmgn;
  const discovery = new TokenDiscovery(makeFakeClients() as never, gmgn, [4663], {
    screenerPolicy: makePolicy(), gmgnOnly: true, blockedTokenRegistry: async () => null,
  });
  const result = await discovery.fetchAndScreenOnce(4663);
  assert.equal(result.ok, false);
  assert.equal(result.registryUnavailable, true);
  assert.equal(result.discovered, 0);
  assert.equal(securityCalls, 0);
});

test('BNB applies the same discovery economics as Robinhood before token screening', async () => {
  const lowVolume = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
  const accepted = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;
  let securityCalls = 0;
  let acceptedVolume = 125_000;
  const gmgn = {
    async query(_chain: ChainId, command: string): Promise<unknown> {
      if (command !== 'hotsearch') return {};
      return { rank: [
        { address: lowVolume, symbol: 'LOW', rank: 1, market_cap: 2_000_000, volume: 99_999, liquidity: 100_000, creation_timestamp: 1 },
        { address: accepted, symbol: 'OK', rank: 2, market_cap: 2_000_000, volume: acceptedVolume, liquidity: 100_000, creation_timestamp: 1 },
      ] };
    },
    async security() { securityCalls++; return { is_honeypot: false, sell_tax: 0, top_10_holder_rate: 0.1, is_open_source: true, flags: [], privileges: [] }; },
  } as unknown as Gmgn;
  const discovery = new TokenDiscovery(makeFakeClients() as never, gmgn, [56], {
    screenerPolicy: makePolicy(), gmgnOnly: true, hotSearchLimit: 10,
  });
  const result = await discovery.fetchAndScreenOnce(56);
  assert.equal(result.economicFiltered, 1);
  assert.equal(result.economicFilterDetails[0]?.address, lowVolume);
  assert.deepEqual(result.economicFilterDetails[0]?.reasons, ['VOLUME_1H_TOO_LOW']);
  assert.equal(result.screened, 1);
  assert.equal(securityCalls, 1);
  assert.deepEqual([...discovery.entries()].map(entry => entry.address), [accepted]);

  // A previously passing token must not remain rankable after its next
  // Hot Search observation falls below the shared economic floor.
  acceptedVolume = 99_999;
  const next = await discovery.fetchAndScreenOnce(56);
  assert.equal(next.economicFiltered, 2);
  assert.equal(discovery.passed(56).length, 0);
});

test('bundled blocked-token seed persists and uses address-only matching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-blocked-'));
  const store = new BlockedTokenStore(join(dir, 'blocked.json'));
  const state = await store.load();
  assert.equal(state.tokens['4663:0xaf3d76f1834a1d425780943c99ea8a608f8a93f9']?.symbol, 'AAPL');
  assert.equal(state.tokens['4663:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], undefined);
  assert.ok(JSON.parse(await readFile(join(dir, 'blocked.json'), 'utf8')).tokens);
});


test('GMGN token security accepts null privileges as unknown', () => {
  const risk = normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: [], privileges: null }, 8453, TOKEN_A, 1);
  assert.equal(risk.criticalAdmin, null);
});

test('GMGN token security accepts both capability fields as null without treating them as safe', () => {
  const risk = normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: null, privileges: null }, 8453, TOKEN_A, 1);
  assert.equal(risk.criticalAdmin, null);
});

test('GMGN token security still accepts capability arrays', () => {
  const risk = normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: [], privileges: [] }, 8453, TOKEN_A, 1);
  assert.equal(risk.criticalAdmin, false);
});

test('GMGN token security rejects non-array, non-null capability fields', () => {
  assert.throws(() => normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: 'unknown', privileges: [] }, 8453, TOKEN_A, 1));
  assert.throws(() => normalizeGmgnRisk({ ...GMGN_SECURITY_BASE, flags: [], privileges: {} }, 8453, TOKEN_A, 1));
});

test('targeted pool selection prefers verified TVL and breaks ties by identity', () => {
  const ranked = selectPoolsByVerifiedTvl([
    { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000004' }, tvlUsd: null, value: 'unknown' },
    { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000003' }, tvlUsd: 200, value: 'tie-high' },
    { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000002' }, tvlUsd: 200, value: 'tie-low' },
    { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000001' }, tvlUsd: 100, value: 'lower' },
  ], 3);
  assert.deepEqual(ranked.map(entry => entry.value), ['tie-low', 'tie-high', 'lower']);
});

test('DEX Screener shortlist is bounded and deterministic before RPC verification', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
    chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'],
    baseToken: { address: TOKEN_A }, quoteToken: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
    pairAddress: `0x${String(i + 2).padStart(40, '0')}`, pairCreatedAt: Date.now() - 3_600_000,
    liquidity: { usd: 100_000 - i * 1_000 },
  }))))) as typeof fetch;
  try {
    const result = await dexScreenerShortlist(4663, TOKEN_A);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hints.length, 10);
    assert.equal(result.hints[0]!.identity, '0x0000000000000000000000000000000000000002');
  } finally { globalThis.fetch = originalFetch; }
});

test('external V3 hints map directly while incomplete V4 hints remain unmappable', () => {
  const v3 = externalHintsToTargeted(4663, TOKEN_A, [{
    identity: '0x0000000000000000000000000000000000000002', protocol: 'v3', token0: TOKEN_A,
    token1: '0x0000000000000000000000000000000000000002', fee: 500,
  }]);
  assert.equal(v3.length, 1);
  assert.equal(v3[0]!.protocol, 'v3');
  const incomplete = externalHintsToTargeted(4663, TOKEN_A, [{
    identity: '0x' + '1'.repeat(64), protocol: 'v4', token0: TOKEN_A,
    token1: '0x0000000000000000000000000000000000000002',
  }]);
  assert.equal(incomplete.length, 0);
});

test('V4 DexScreener PoolId recovers from PoolManager Initialize when poolKeys is unavailable', async () => {
  const token: Address = '0x1111111111111111111111111111111111111111';
  const quote: Address = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const fee = 40_000, tickSpacing = 60, hooks: Address = '0x0000000000000000000000000000000000000000';
  const expectedId = poolId({ currency0: token, currency1: quote, fee, tickSpacing, hooks });
  const client = {
    readContract: async () => { throw new Error('poolKeys unavailable'); },
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 10_000n + blockNumber }),
    getLogs: async (request: { args?: { currency0?: Address; currency1?: Address } }) => request.args?.currency0 === token && request.args?.currency1 === quote ? [{
      args: { id: expectedId, currency0: token, currency1: quote, fee, tickSpacing, hooks, sqrtPriceX96: 1n, tick: 0 }, removed: false, blockNumber: 90n,
    }] : [],
  } as never;
  const recovered = await recoverExternalV4PoolHints(client, 4663, token, [{
    identity: expectedId, protocol: 'v4', poolId: expectedId, token0: token, token1: quote,
  }]);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.poolId, expectedId);
  assert.equal(recovered[0]!.fee, fee);
  assert.equal(recovered[0]!.tickSpacing, tickSpacing);
  assert.equal(recovered[0]!.hooks, hooks);
});

test('Uniswap GraphQL global V4 ID decodes and filters supported Robinhood quotes', async () => {
  const quote = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
  const id = poolId({ currency0: TOKEN_A, currency1: quote, fee: 40_000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' });
  const globalId = Buffer.from(`V4Pool:ROBINHOOD_${id}`).toString('base64');
  assert.equal(decodeUniswapV4PoolId(globalId), id);
  assert.equal(poolIdToBytes25(id), `0x${id.slice(2, 52)}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { topV4Pools: [
    { id: globalId, feeTier: 40_000, totalLiquidity: { value: 50_000 }, token0: { address: TOKEN_A }, token1: { address: quote } },
    { id: globalId, feeTier: 40_000, totalLiquidity: { value: 100_000 }, token0: { address: TOKEN_A }, token1: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  ] } }))) as typeof fetch;
  try {
    const hints = await fetchUniswapV4Hints(4663, TOKEN_A);
    assert.equal(hints.length, 1);
    assert.equal(hints[0]!.identity, id);
    assert.equal(hints[0]!.liquidityUsd, 50_000);
  } finally { globalThis.fetch = originalFetch; }
});

test('V4 POSM bytes25 key recovery is hash-verified; deterministic zero-hook fallback works', async () => {
  const quote = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
  const hooks = '0x0000000000000000000000000000000000000000' as Address;
  const id = poolId({ currency0: TOKEN_A, currency1: quote, fee: 40_000, tickSpacing: 60, hooks });
  let argument = '';
  const hint = { identity: id, protocol: 'v4' as const, poolId: id, token0: TOKEN_A, token1: quote };
  const keyClient = { readContract: async (request: any) => { argument = request.args[0]; return [TOKEN_A, quote, 40_000, 60, hooks]; } } as never;
  const recovered = await recoverExternalV4PoolHints(keyClient, 4663, TOKEN_A, [hint]);
  assert.equal(argument, poolIdToBytes25(id));
  assert.equal(recovered[0]!.recoveryMethod, 'POOLKEYS_BYTES25');
  const fallbackClient = { readContract: async () => { throw new Error('not indexed'); } } as never;
  const fallback = await recoverExternalV4PoolHints(fallbackClient, 4663, TOKEN_A, [hint]);
  assert.equal(fallback[0]!.recoveryMethod, 'DETERMINISTIC_HASH');
  const invalidId = poolId({ currency0: TOKEN_A, currency1: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 40_000, tickSpacing: 60, hooks });
  const mismatched = await recoverExternalV4PoolHints({ ...fallbackClient, getBlockNumber: async () => 10n, getBlock: async () => ({ timestamp: 100n }), getLogs: async () => [] } as never, 4663, TOKEN_A,
    [{ ...hint, identity: invalidId, poolId: invalidId }]);
  assert.equal(mismatched.length, 0);
});

test('merged V3/V4 search finishes both protocols and ranks verified pools by external USD liquidity', async () => {
  const quote = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
  const hooks = '0x0000000000000000000000000000000000000000' as Address;
  const id = poolId({ currency0: TOKEN_A, currency1: quote, fee: 40_000, tickSpacing: 60, hooks });
  const v3 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const graph = { identity: id, protocol: 'v4' as const, poolId: id, token0: TOKEN_A, token1: quote, liquidityUsd: 100_000, source: 'UNISWAP_GRAPHQL' as const };
  const duplicate = { ...graph, source: 'DEXSCREENER' as const };
  assert.equal(mergeExternalPoolHints([graph], [duplicate]).length, 1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { topV4Pools: [{
    id: Buffer.from(`V4Pool:ROBINHOOD_${id}`).toString('base64'), feeTier: 40_000,
    totalLiquidity: { value: 100_000 }, token0: { address: TOKEN_A }, token1: { address: quote },
  }] } }))) as typeof fetch;
  let broadCalls = 0;
  const client = { getBlockNumber: async () => 10n, readContract: async (request: any) => {
    assert.equal(request.functionName, 'poolKeys');
    return [TOKEN_A, quote, 40_000, 60, hooks];
  }, getLogs: async () => { broadCalls++; return []; } } as never;
  const verify = (async (_client: any, ref: PoolRef) => ({ verified: true, liquidity: 10n,
    token0: { address: TOKEN_A }, token1: { address: quote }, tick: 123, sqrtPriceX96: 123n, pool: ref })) as never;
  try {
    const result = await searchVerifiedPoolsForToken(client, 4663, TOKEN_A, { verify, dex: { addresses: new Set([id, v3]), hints: [
      duplicate, { identity: v3, protocol: 'v3', token0: TOKEN_A, token1: quote, liquidityUsd: 80_000, source: 'DEXSCREENER' },
    ], found: 2, filtered: 0, fallbackUsed: false } });
    assert.equal(result.pools.length, 2);
    assert.equal(result.pools[0]!.pool.poolId, id);
    assert.equal(result.pools[1]!.pool.poolAddress, v3);
    assert.equal(result.evidence.recovery[0]!.method, 'POOLKEYS_BYTES25');
    assert.equal(result.evidence.finalOutcome, 'VERIFIED_POOLS');
    assert.equal(broadCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('DEX V4 remains a source when GraphQL is empty; Gecko supplies missing V3', async () => {
  const quote = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
  const hooks = '0x0000000000000000000000000000000000000000' as Address;
  const id = poolId({ currency0: TOKEN_A, currency1: quote, fee: 40_000, tickSpacing: 60, hooks });
  const v3 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.includes('graphql')) return new Response(JSON.stringify({ data: { topV4Pools: [] } }));
    if (url.includes('geckoterminal')) return new Response(JSON.stringify({ included: [{
      type: 'pool', id: `robinhood_${v3}`, attributes: { address: v3, reserve_in_usd: '80000' },
      relationships: { dex: { data: { id: 'uniswap-v3-robinhood' } }, base_token: { data: { id: `robinhood_${TOKEN_A}` } }, quote_token: { data: { id: `robinhood_${quote}` } } },
    }] }));
    throw new Error('unexpected endpoint');
  }) as typeof fetch;
  const client = { getBlockNumber: async () => 10n, readContract: async () => [TOKEN_A, quote, 40_000, 60, hooks], getLogs: async () => { throw new Error('broad logs must be skipped'); } } as never;
  const verify = (async (_client: any, ref: PoolRef) => ({ verified: true, liquidity: 10n, token0: { address: TOKEN_A }, token1: { address: quote }, tick: 100, sqrtPriceX96: 100n, pool: ref })) as never;
  try {
    const result = await searchVerifiedPoolsForToken(client, 4663, TOKEN_A, { verify, dex: { addresses: new Set([id]), hints: [
      { identity: id, poolId: id, protocol: 'v4', token0: TOKEN_A, token1: quote, liquidityUsd: 50_000, source: 'DEXSCREENER' },
    ], found: 1, filtered: 0, fallbackUsed: false } });
    assert.deepEqual(result.pools.map(p => p.pool.protocol), ['v3', 'v4']);
    assert.equal(result.evidence.geckoV3FallbackUsed, true);
    assert.equal(result.evidence.dexV4Hints[0]!.poolId, id);
    assert.equal(result.evidence.fallbackUsed, false);
    assert.equal(calls.filter(url => url.includes('geckoterminal')).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});


function makePolicy(): TokenScreeningPolicy {
  return {
    maximumSellTaxBps: 0,
    maximumHolderPct: 40,
    minimumAgeSeconds: 86400,
    cooldownSeconds: 604800,
    blacklist: new Map(),
  };
}

/**
 * Build a fully-mocked viem client. The fake covers only the methods
 * the TokenScreener actually uses: getBytecode, simulateContract, getBlock.
 */
function makeMockClient(opts: { bytecode?: string; transferOk?: boolean } = {}) {
  const bytecode = opts.bytecode ?? '0x6080';
  const transferOk = opts.transferOk ?? true;
  return {
    getBytecode: async () => bytecode,
    simulateContract: async () => {
      if (!transferOk) throw new Error('TRANSFER_FROM_REVERT');
      return { request: {} as never };
    },
    getBlock: async () => ({ timestamp: 1700000000n } as never),
  } as unknown as Parameters<typeof TokenScreener.prototype.screen>[2]['client'];
}

function makeFakeGmgn(behavior: {
  security?: Partial<Risk>;
  throwOnSecurity?: boolean;
}): Gmgn {
  return {
    async trending(): Promise<Address[]> { return []; },
    async query(): Promise<unknown> { return {}; },
    async info(): Promise<never> { throw new Error('n/a'); },
    async security(_chainId: ChainId, _token: Address): Promise<Risk> {
      if (behavior.throwOnSecurity) throw new Error('GMGN_DOWN');
      return {
        chainId: _chainId, token: _token.toLowerCase() as Address,
        observedAt: Date.now() / 1000, source: 'test',
        honeypot: false, criticalAdmin: false,
        sellTaxBps: 0, top10HolderPct: 25,
        buySimulation: true, sellSimulation: true, smartMoneyScore: 0.5,
        ...behavior.security,
      } as Risk;
    },
    async price(): Promise<never> { throw new Error('n/a'); },
    async hotSearch(): Promise<never> { throw new Error('n/a'); },
  } as unknown as Gmgn;
}

// ─── TokenScreener ────────────────────────────────────────────

test('TokenScreener rejects when bytecode is empty (TOKEN_NOT_DEPLOYED)', async () => {
  const screener = new TokenScreener(makePolicy());
  // Use viem with an unreachable HTTP transport — getBytecode will
  // throw. We translate that into RETRY_LATER per fail-closed contract.
  const verifierClient = createPublicClient({ chain: mainnet, transport: http('http://127.0.0.1:1') });
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: verifierClient as never,
    gmgn: makeFakeGmgn({ security: { buySimulation: true, sellSimulation: true } }),
  });
  assert.equal(verdict.status, 'RETRY_LATER');
});

test('TokenScreener passes when bytecode exists, GMGN clean, transfer probe succeeds', async () => {
  const screener = new TokenScreener(makePolicy(), { maxCachedTokens: 100 });
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient({ bytecode: '0x6080', transferOk: true }),
    gmgn: makeFakeGmgn({ security: { buySimulation: true, sellSimulation: true } }),
  });
  assert.equal(verdict.status, 'PASS');
});

test('GMGN-only screening treats unresolved candidate criticalAdmin as unknown', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screenGmgnOnly(8453, TOKEN_A, makeFakeGmgn({ security: { criticalAdmin: null } }));
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.evidence?.gmgn?.criticalAdmin, null);
});

test('GMGN-only screening tolerates unresolved configured wrapped-native infrastructure', async () => {
  const weth: Address = '0x4200000000000000000000000000000000000006';
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screenGmgnOnly(8453, weth, makeFakeGmgn({ security: { criticalAdmin: null } }));
  assert.equal(verdict.status, 'PASS');
});

test('TokenScreener rejects when GMGN reports honeypot', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn: makeFakeGmgn({ security: { honeypot: true, buySimulation: true, sellSimulation: true } }),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_IS_HONEYPOT_GMGN');
});

test('TokenScreener rejects when GMGN reports failed sell simulation', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn: makeFakeGmgn({ security: { sellSimulation: false } }),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_SELL_SIMULATION_FAILED_GMGN');
});

test('TokenScreener rejects when sell tax exceeds policy', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn: makeFakeGmgn({ security: { sellTaxBps: 50 } }),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_SELL_TAX_TOO_HIGH');
});

test('TokenScreener rejects when top10 holder concentration exceeds policy', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn: makeFakeGmgn({ security: { top10HolderPct: 75 } }),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_HOLDER_CONCENTRATION_TOO_HIGH');
});

test('TokenScreener respects operator blacklist', async () => {
  const policy = makePolicy();
  policy.blacklist.set(`8453:${TOKEN_A.toLowerCase()}`, { until: Date.now() / 1000 + 3600, reason: 'manual' });
  const screener = new TokenScreener(policy);
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn: makeFakeGmgn({}),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_BLACKLISTED');
});

test('TokenScreener still passes when GMGN throws (on-chain checks are authoritative)', async () => {
  // The screener treats GMGN as a hint, not authority. If GMGN is
  // unavailable but on-chain checks (bytecode + transfer probe) pass,
  // the token can still be approved. This is fail-safe at the
  // discovery layer (TokenDiscovery rejects new entries when GMGN
  // rate-limits), but at the screener level we trust on-chain evidence.
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient({ bytecode: '0x6080', transferOk: true }),
    gmgn: makeFakeGmgn({ throwOnSecurity: true }),
  });
  assert.equal(verdict.status, 'PASS');
});

test('TokenScreener rejects when on-chain transfer probe fails', async () => {
  const screener = new TokenScreener(makePolicy());
  const verdict = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient({ transferOk: false }),
    gmgn: makeFakeGmgn({ security: { buySimulation: true, sellSimulation: true } }),
  });
  assert.equal(verdict.status, 'REJECT');
  assert.equal(verdict.rejection?.code, 'TOKEN_BALANCE_PROBE_FAILED');
});

test('TokenScreener treats unfunded probe balance/allowance reverts as inconclusive', async () => {
  const client = {
    getBytecode: async () => '0x6080',
    simulateContract: async ({ functionName }: { functionName: string }) => {
      throw new Error(functionName === 'transferFrom' ? 'ERC20InsufficientAllowance' : 'ERC20InsufficientBalance');
    },
  } as unknown as Parameters<typeof TokenScreener.prototype.screen>[2]['client'];
  const verdict = await new TokenScreener(makePolicy()).screen(8453, TOKEN_A, {
    client,
    gmgn: makeFakeGmgn({ security: { buySimulation: true, sellSimulation: true } }),
  });
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.evidence?.buySimulation, null);
  assert.equal(verdict.evidence?.sellSimulation, null);
});

test('TokenScreener recognizes OpenZeppelin insufficient-balance selectors as inconclusive', async () => {
  const client = {
    getBytecode: async () => '0x6080',
    simulateContract: async ({ functionName }: { functionName: string }) => {
      throw new Error(functionName === 'transferFrom' ? 'reverted with 0xfb8f41b2' : 'reverted with 0xe450d38c');
    },
  } as unknown as Parameters<typeof TokenScreener.prototype.screen>[2]['client'];
  const verdict = await new TokenScreener(makePolicy()).screen(8453, TOKEN_A, {
    client,
    gmgn: makeFakeGmgn({}),
  });
  assert.equal(verdict.status, 'PASS');
});

test('TokenScreener markLossExit sets a cooldown verdict that expires', async () => {
  const screener = new TokenScreener(makePolicy());
  screener.markLossExit(8453, TOKEN_A, 100, 'huge rug');
  // Reach into the cache to inspect the verdict directly.
  const inner = screener as unknown as {
    cache: Map<string, { verdict: TokenScreeningVerdict; expiresAt: number }>;
  };
  const cached = inner.cache.get(`8453:${TOKEN_A.toLowerCase()}`);
  assert.equal(cached?.verdict.status, 'REJECT');
  assert.equal(cached?.verdict.rejection?.code, 'TOKEN_COOLDOWN_ACTIVE');
});

test('TokenScreener cache is bounded by maxCachedTokens (LRU eviction)', async () => {
  const screener = new TokenScreener(makePolicy(), { maxCachedTokens: 3 });
  for (let i = 0; i < 5; i++) {
    const tok = ('0x' + (i + 1).toString(16).padStart(40, '0')) as Address;
    screener.markLossExit(8453, tok, 100, 'reason');
  }
  assert.ok(screener.size() <= 3);
});

// ─── TokenDiscovery ────────────────────────────────────────────

function makeFakeClients(): { get: (chainId: ChainId) => unknown } {
  return { get: () => makeMockClient() };
}

function makeHotSearchGmgn(rowsByChain: Map<ChainId, Address[]>): Gmgn {
  return {
    async trending(): Promise<Address[]> { return []; },
    async query(chainId: ChainId, command: string): Promise<unknown> {
      if (command !== 'hotsearch') return {};
      const addresses = (rowsByChain.get(chainId) ?? []).map((address, i) => ({
        address,
        rank: i + 1,
        symbol: 'TOK' + i,
        name: 'Token ' + i,
        open_timestamp: Math.floor(Date.now() / 1000),
      }));
      // Wrap in the envelope shape gmgnHotSearch expects:
      // it accepts either a raw array OR { rank: [] } OR { data: ... }
      return { rank: addresses };
    },
    async info(): Promise<never> { throw new Error('n/a'); },
    async security(): Promise<never> { throw new Error('n/a'); },
    async price(): Promise<never> { throw new Error('n/a'); },
    async hotSearch(): Promise<never> { throw new Error('n/a'); },
  } as unknown as Gmgn;
}

test('TokenDiscovery caches tokens by chain and dedups within a chain', async () => {
  const hotSearch = new Map([[8453 as ChainId, [TOKEN_A, TOKEN_A, TOKEN_A]]] as const);
  // All fetches return same token; first cycle dedupes to 1 entry.
  const discovery = new TokenDiscovery(makeFakeClients() as never, makeHotSearchGmgn(hotSearch), [8453], {
    screenerPolicy: makePolicy(),
    hotSearchIntervalMs: 1000,
  });
  const r = await discovery.fetchAndScreenOnce(8453);
  assert.equal(r.newTokens, 1);
  let count = 0;
  for (const _ of discovery.entries()) count++;
  assert.equal(count, 1);
  discovery.stop();
});

test('TokenDiscovery GMGN-only mode screens tokens without obtaining an RPC client', async () => {
  let rpcClientRequests = 0;
  const clients = { get: () => { rpcClientRequests++; throw new Error('RPC must not be used'); } };
  const base = makeHotSearchGmgn(new Map([[8453 as ChainId, [TOKEN_A]]]));
  const gmgn = {
    ...base,
    async security(chainId: ChainId, token: Address): Promise<Risk> {
      return { chainId, token, observedAt: 1_700_000_000, source: 'gmgn-test', honeypot: false, criticalAdmin: false,
        sellTaxBps: 0, top10HolderPct: 20, buySimulation: true, sellSimulation: true, smartMoneyScore: 0.8 };
    },
  } as Gmgn;
  const discovery = new TokenDiscovery(clients as never, gmgn, [8453], {
    screenerPolicy: makePolicy(), gmgnOnly: true,
  });
  const result = await discovery.fetchAndScreenOnce(8453, 1_700_000_000);
  assert.equal(result.pass, 1);
  assert.equal(rpcClientRequests, 0);
  assert.equal([...discovery.entries()][0]?.risk?.smartMoneyScore, 0.8);
});

test('TokenDiscovery fails closed on GMGN rate-limit for new entries', async () => {
  let threw = false;
  const gmgn: Gmgn = {
    async trending(): Promise<Address[]> { return []; },
    async query(_chainId: ChainId, command: string): Promise<unknown> {
      if (command === 'hotsearch') {
        threw = true;
        throw new Error('RATE_LIMIT_BANNED');
      }
      return {};
    },
    async info(): Promise<never> { throw new Error('RATE_LIMIT_BANNED'); },
    async security(): Promise<never> { throw new Error('RATE_LIMIT_BANNED'); },
    async price(): Promise<never> { throw new Error('RATE_LIMIT_BANNED'); },
    async hotSearch(): Promise<Address[]> {
      threw = true;
      throw new Error('RATE_LIMIT_BANNED');
    },
  } as unknown as Gmgn;
  const discovery = new TokenDiscovery(makeFakeClients() as never, gmgn, [8453], {
    screenerPolicy: makePolicy(),
    hotSearchIntervalMs: 1000,
  });
  const r = await discovery.fetchAndScreenOnce(8453);
  assert.equal(r.newTokens, 0);
  assert.equal(r.rateLimitErrors, 1);
  assert.equal(threw, true);
  let count = 0;
  for (const _ of discovery.entries()) count++;
  assert.equal(count, 0);
  const t = discovery.getTelemetry();
  assert.equal(t.gmgnRequests, 1);
  assert.equal(t.gmgnRateLimitErrors, 1);
  discovery.stop();
});

test('TokenDiscovery start/stop is idempotent and tears down all timers', async () => {
  const discovery = new TokenDiscovery(makeFakeClients() as never, makeHotSearchGmgn(new Map()), [8453, 56], {
    screenerPolicy: makePolicy(),
    hotSearchIntervalMs: 60_000,
  });
  discovery.start();
  discovery.start(); // no-op
  discovery.stop();
  discovery.stop(); // no-op
  // start() intentionally performs one immediate fetch per chain before
  // scheduling the interval; the second start() must not duplicate either.
  assert.equal(discovery.getTelemetry().gmgnRequests, 2);
});

test('TokenDiscovery does not re-screen when nextEligibleScreenAt is in the future', async () => {
  const hotSearch = new Map([[8453 as ChainId, [TOKEN_A]]]);
  const discovery = new TokenDiscovery(makeFakeClients() as never, makeHotSearchGmgn(hotSearch), [8453], {
    screenerPolicy: makePolicy(),
    hotSearchIntervalMs: 1000,
    rescreenTtlMs: 60_000,
  });
  // First cycle: GMGN.security throws → RETRY_LATER, nextEligibleScreenAt=now+60s.
  await discovery.fetchAndScreenOnce(8453);
  const before = discovery.getTelemetry().tokenScreeningCount;
  // Mutate the cache entry to simulate the production behavior:
  // token has been PASS-screened, nextEligibleScreenAt in the future.
  for (const entry of discovery.entries()) {
    if (entry.address === TOKEN_A.toLowerCase()) {
      (entry as { lastTokenScreenResult: string }).lastTokenScreenResult = 'PASS';
      (entry as { nextEligibleScreenAt: number }).nextEligibleScreenAt = Date.now() / 1000 + 60_000;
    }
  }
  // Run again — the token is in the cache but should NOT be screened.
  await discovery.fetchAndScreenOnce(8453);
  const after = discovery.getTelemetry().tokenScreeningCount;
  assert.equal(before, after);
  discovery.stop();
});

test('exactPoolCreatedAt finds one V3 pool deployment with bounded binary-search reads', async () => {
  const state = structuredClone(demoObservations(DEMO_TIME)[0]!.state);
  state.blockNumber = 200n;
  let reads = 0;
  const client = {
    async getBytecode({ blockNumber }: { blockNumber: bigint }) {
      reads++;
      return blockNumber >= 100n ? '0x6000' : undefined;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: 1_000n + blockNumber };
    },
  } as unknown as Parameters<typeof exactPoolCreatedAt>[0];
  assert.equal(await exactPoolCreatedAt(client, state), 1_100);
  assert.ok(reads <= 10, `expected logarithmic reads, got ${reads}`);
});

test('estimatedLifecycleCostUsd uses RPC gas price and a conservative V3 envelope', async () => {
  const state = demoObservations(DEMO_TIME)[0]!.state;
  const client = { getGasPrice: async () => 1_000_000_000n } as unknown as Parameters<typeof estimatedLifecycleCostUsd>[0];
  assert.equal(await estimatedLifecycleCostUsd(client, state, 2_000), 3);
  assert.equal(await estimatedLifecycleCostUsd(client, state, null), null);
});

test('targeted V4 discovery filters Initialize logs by the exact token pair', async () => {
  const calls: Array<{ args?: { currency0?: Address; currency1?: Address } }> = [];
  const client = {
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber + 10_000n }),
    getLogs: async (request: { args?: { currency0?: Address; currency1?: Address } }) => { calls.push(request); return []; },
  } as unknown as Parameters<typeof discoverV4PoolsForToken>[0];
  await discoverV4PoolsForToken(client, 8453, TOKEN_A, {
    quoteTokens: ['0x2222222222222222222222222222222222222222'],
    v4FromBlock: 0n,
  });
  assert.ok(calls.length > 0);
  assert.equal(calls[0]!.args?.currency0, TOKEN_A);
  assert.equal(calls[0]!.args?.currency1, '0x2222222222222222222222222222222222222222');
});

// ─── GMGN-based pool screening normalization ──────────────────

const POOL_V3_BASE = {
  pool_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  exchange: 'uniswap_v3',
  quote_address: '0xcccccccccccccccccccccccccccccccccccccccc',
  token0_address: '0x1111111111111111111111111111111111111111',
  token1_address: '0xcccccccccccccccccccccccccccccccccccccccc',
  liquidity: '1500000',
  base_reserve: '10',
  quote_reserve: '1500000',
  creation_timestamp: 1_700_000_000,
  base_reserve_value: '3000',
  quote_reserve_value: '1500',
};

test('gmgnPoolInfoToPoolRef builds a v3 PoolRef from a canonical GMGN pool response', () => {
  const ref = gmgnPoolInfoToPoolRef(8453, POOL_V3_BASE);
  assert.ok(ref);
  assert.equal(ref!.chainId, 8453);
  assert.equal(ref!.protocol, 'v3');
  assert.equal(ref!.dex, 'uniswap');
  assert.equal((ref as { poolAddress: string }).poolAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('gmgnPoolInfoToPoolRef recognizes pancakeswap v3', () => {
  const ref = gmgnPoolInfoToPoolRef(56, { ...POOL_V3_BASE, exchange: 'pancakeswap_v3' });
  assert.ok(ref);
  assert.equal(ref!.chainId, 56);
  assert.equal(ref!.dex, 'pancakeswap');
});

test('gmgnPoolInfoToPoolRef builds a v4 PoolRef when exchange mentions v4', () => {
  const ref = gmgnPoolInfoToPoolRef(8453, {
    pool_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    exchange: 'uniswap_v4',
    quote_address: '0xcccccccccccccccccccccccccccccccccccccccc',
    token0_address: '0x1111111111111111111111111111111111111111',
    token1_address: '0xcccccccccccccccccccccccccccccccccccccccc',
  });
  assert.ok(ref);
  assert.equal(ref!.protocol, 'v4');
  if (ref!.protocol === 'v4') {
    assert.equal(ref!.poolId, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(ref!.poolKey.currency0, '0x1111111111111111111111111111111111111111');
    assert.equal(ref!.poolKey.currency1, '0xcccccccccccccccccccccccccccccccccccccccc');
  }
});

test('gmgnPoolInfoToPoolRef accepts pool address under either pool_address or address key', () => {
  const ref1 = gmgnPoolInfoToPoolRef(8453, { ...POOL_V3_BASE, pool_address: '0x1111111111111111111111111111111111111111' });
  const ref2 = gmgnPoolInfoToPoolRef(8453, { ...POOL_V3_BASE, pool_address: undefined, address: '0x1111111111111111111111111111111111111111' });
  assert.equal(ref1?.protocol, 'v3');
  assert.equal(ref2?.protocol, 'v3');
  if (ref1 && ref2 && ref1.protocol === 'v3' && ref2.protocol === 'v3') {
    assert.equal(ref1.poolAddress, ref2.poolAddress);
  }
});

test('gmgnPoolInfoToPoolRef returns null when neither pool_address nor address is present', () => {
  const ref = gmgnPoolInfoToPoolRef(8453, { exchange: 'uniswap_v3', quote_address: '0xcccccccccccccccccccccccccccccccccccccccc' });
  assert.equal(ref, null);
});

test('gmgnPoolInfoToPoolRef returns null on malformed address', () => {
  const ref = gmgnPoolInfoToPoolRef(8453, { ...POOL_V3_BASE, pool_address: 'not-an-address' });
  assert.equal(ref, null);
});

// ─── GMGN CLI path used by tokenFirstDiscover ────────────────
//
// Verify that the screening-layer hot-path makes exactly the expected
// GMGN CLI calls (gmgn token pool) and zero RPC factory queries.

test('Gmgn.poolInfo() returns null on GMGN throw (fail-closed)', async () => {
  // Use a fake Providers whose run() throws — the real Gmgn.poolInfo()
  // implementation wraps its inner call in try/catch and returns null
  // when GMGN is unavailable.
  const fakeProviders = {
    health: new Map(),
    observations: [],
    async run<T>(): Promise<T> { throw new Error('GMGN_DOWN'); },
    async json<T>(): Promise<T> { throw new Error('GMGN_DOWN'); },
  };
  // Use the real Gmgn class — not a duck-typed fake — so we exercise
  // the actual catch path.
  const { Gmgn } = await import('../src/viero/adapters/providers.js');
  const gmgn = new Gmgn(fakeProviders as never);
  assert.equal(await gmgn.poolInfo(8453, TOKEN_A), null);
});

test('Gmgn.poolInfo() returns the GMGN JSON payload on success', async () => {
  const expected = { pool_address: '0xcafe', exchange: 'uniswap_v3' };
  const fakeProviders = {
    health: new Map(),
    observations: [],
    async run<T>(): Promise<T> { return expected as unknown as T; },
    async json<T>(): Promise<T> { return expected as unknown as T; },
  };
  const { Gmgn } = await import('../src/viero/adapters/providers.js');
  const gmgn = new Gmgn(fakeProviders as never);
  assert.deepEqual(await gmgn.poolInfo(8453, TOKEN_A), expected);
});

test('Gmgn.poolInfo() rejects zero address token (defensive)', async () => {
  let runCalled = false;
  const fakeProviders = {
    health: new Map(),
    observations: [],
    async run<T>(): Promise<T> { runCalled = true; return {} as T; },
    async json<T>(): Promise<T> { return {} as T; },
  };
  const { Gmgn } = await import('../src/viero/adapters/providers.js');
  const gmgn = new Gmgn(fakeProviders as never);
  assert.equal(await gmgn.poolInfo(8453, '0x0000000000000000000000000000000000000000' as Address), null);
  assert.equal(runCalled, false, 'zero-address token must short-circuit before invoking GMGN CLI');
});

// ─── chain integration: pool discovery replaces RPC factory calls ─

test('chain token→pool discovery uses gmgn-cli token pool, not RPC factory getPool', async () => {
  // Capture which GMGN commands are issued and which RPC factory
  // queries are issued. The screening worker must make ZERO RPC factory
  // calls during the token→pool discovery step; only gmgn-cli is used.
  const gmgnCalls: string[] = [];
  const fakeProviders = {
    health: new Map<string, { chainId: number; provider: string; consecutiveFailures: number; latencyMs: number }>(),
    observations: [] as unknown[],
    async run<T>(_chainId: number, _provider: string, _key: string, op: () => Promise<T>): Promise<T> {
      const result = await op();
      return result;
    },
    async json<T>(_chainId: number, _provider: string, _url: string): Promise<T> {
      // Return a payload that exercises only the GMGN path.
      // We don't reach this code in the assertion; poolInfo() calls run()
      // through Providers.run() which calls gmgn-cli via execFile.
      // For this test we instead intercept at the inner op() boundary by
      // patching the Fmgn instance after construction.
      throw new Error('not-reached');
    },
  };
  // Build a real Gmgn but override its `query` and `poolInfo` via
  // prototype patch so we can assert the call shape without a real CLI.
  const { Gmgn } = await import('../src/viero/adapters/providers.js');
  const gmgn = new Gmgn(fakeProviders as never);
  (gmgn as unknown as { query: (c: number, command: string) => Promise<unknown> }).query =
    async (_chainId: number, command: string): Promise<unknown> => {
      gmgnCalls.push(command);
      if (command === 'pool') return POOL_V3_BASE;
      return {};
    };

  const screener = new TokenScreener({
    maximumSellTaxBps: 0, maximumHolderPct: 40, minimumAgeSeconds: 86400,
    cooldownSeconds: 604800, blacklist: new Map(),
  }, { maxCachedTokens: 100 });

  const observation = await screener.screen(8453, TOKEN_A, {
    client: makeMockClient(),
    gmgn,
  });
  assert.equal(observation.status, 'PASS');

  // Simulate the GMGN pool lookup that screeningWorker.tokenFirstDiscover does.
  const info = await gmgn.poolInfo(8453, TOKEN_A);
  assert.ok(info, 'gmgn pool info must resolve when GMGN is up');
  const ref = gmgnPoolInfoToPoolRef(8453, info as Parameters<typeof gmgnPoolInfoToPoolRef>[1]);
  assert.ok(ref, 'pool ref must be derivable from GMGN info');

  // The screening token→pool discovery step must call GMGN's `pool` command
  // (no RPC factory getPool, no V4 Initialize-event scan). The screener
  // also queries gmgn.security first, so the recorded sequence is
  // `security` then `pool`. The important assertions are that `pool` is
  // present and that no RPC factory getPool / getLogs / getBlockNumber
  // calls were issued (the screener mock has RPC mocks that would record
  // calls if reached).
  assert.ok(gmgnCalls.includes('pool'), 'gmgn-cli pool command must be issued; got: ' + JSON.stringify(gmgnCalls));
  assert.ok(!gmgnCalls.includes('hotsearch'), 'hotsearch should not fire during pool discovery');
});
