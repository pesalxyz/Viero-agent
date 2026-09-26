/**
 * Targeted pool discovery for a SINGLE token.
 *
 * Unlike `discoveryWorker.discover` which enumerates GMGN trending
 * tokens AND scans the full indexer pool universe, this module only
 * answers the question:
 *   "For this token T, which V3/V4 pools exist with our approved
 *    quote assets on this chain?"
 *
 * External sources identify pools; on-chain reads establish their identity.
 * Recent Initialize logs and V3 factory enumeration are final fallbacks.
 *
 * The caller is expected to handle TTL / rate limiting / caching.
 */
import { zeroAddress, type Address, type PublicClient } from 'viem';
import { getChain } from '../config/chains.js';
import { type ChainId } from '../domain.js';
import { factoryAbi, initializeEvent, v4PositionManagerPoolKeyAbi } from '../adapters/abi.js';
import { addressSchema, poolId, type PoolRef } from '../domain.js';
import { pagedLogs } from '../adapters/events.js';
import { verifyPool } from './pools.js';

export type TargetedPool = {
  chainId: ChainId;
  protocol: 'v3' | 'v4';
  dex: 'uniswap' | 'pancakeswap';
  poolAddress?: Address;  // v3
  poolId?: `0x${string}`;  // v4
  token0: Address;
  token1: Address;
  fee?: number;
  tickSpacing?: number;
  hooks?: Address;
  source?: 'UNISWAP_GRAPHQL' | 'DEXSCREENER' | 'GECKOTERMINAL' | 'RPC_FALLBACK';
  recoveryMethod?: 'POOLKEYS_BYTES25' | 'DETERMINISTIC_HASH' | 'INITIALIZE_LOG';
  liquidityUsd?: number;
  /** Block number at which the pool was discovered (V4 Initialize or 'latest'). */
  discoveredAtBlock: bigint;
};

export function targetedPoolToRef(pool: TargetedPool): PoolRef {
  if (pool.protocol === 'v3' && pool.poolAddress) return { chainId: pool.chainId, protocol: 'v3', dex: pool.dex, poolAddress: pool.poolAddress };
  if (pool.protocol === 'v4' && pool.poolId && pool.hooks && pool.fee !== undefined && pool.tickSpacing !== undefined)
    return { chainId: pool.chainId, protocol: 'v4', dex: 'uniswap', poolId: pool.poolId, poolKey: { currency0: pool.token0, currency1: pool.token1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks } };
  throw new Error('TARGETED_POOL_INVALID');
}

export type VerifiedTargetedPool = { pool: TargetedPool; ref: PoolRef; liquidity: bigint };

const HEX32 = /^0x[0-9a-f]{64}$/i;
const HEX20 = /^0x[0-9a-f]{40}$/i;
const ZERO_HOOK = zeroAddress;

/** PoolManager PoolId is bytes32; POSM indexes the first 25 bytes. */
export function poolIdToBytes25(id: string): `0x${string}` {
  if (!HEX32.test(id)) throw new Error('INVALID_V4_POOL_ID');
  return `0x${id.slice(2, 52).toLowerCase()}`;
}

/** Uniswap Interface GraphQL uses base64 global IDs, not pool addresses. */
export function decodeUniswapV4PoolId(id: string): `0x${string}` | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = /^V4Pool:[A-Z0-9]+_(0x[0-9a-f]{64})$/i.exec(decoded);
    return match ? match[1]!.toLowerCase() as `0x${string}` : null;
  } catch { return null; }
}

export type ExternalPoolHint = {
  identity: string;
  protocol: 'v3' | 'v4';
  token0: Address;
  token1: Address;
  fee?: number;
  tickSpacing?: number;
  hooks?: Address;
  poolId?: `0x${string}`;
  liquidityUsd?: number;
  volume1hUsd?: number;
  pairCreatedAt?: number;
  source?: 'UNISWAP_GRAPHQL' | 'DEXSCREENER' | 'GECKOTERMINAL';
};
export type ExternalPoolShortlist = { addresses: Set<string>; hints: ExternalPoolHint[]; found: number; filtered: number; fallbackUsed: boolean; fallbackReason?: string };

/** Read-only DEX Screener hinting; never supplies execution truth. */
export async function dexScreenerShortlist(chainId: ChainId, token: Address, now = Date.now()): Promise<ExternalPoolShortlist> {
  if (chainId !== 4663) return { addresses: new Set(), hints: [], found: 0, filtered: 0, fallbackUsed: true, fallbackReason: 'UNSUPPORTED_CHAIN' };
  try {
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${token}`);
    if (!response.ok) throw new Error(`DEXSCREENER_HTTP_${response.status}`);
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows)) throw new Error('DEXSCREENER_MALFORMED');
    const candidates = rows.filter((row): row is Record<string, any> => {
      if (!row || typeof row !== 'object') return false;
      const r = row as Record<string, any>, labels = Array.isArray(r.labels) ? r.labels.map(String) : [];
      const base = String(r.baseToken?.address ?? '').toLowerCase(), quote = String(r.quoteToken?.address ?? '').toLowerCase();
      const exactPair = base === token.toLowerCase() || quote === token.toLowerCase();
      const age = Number(r.pairCreatedAt), liquidity = Number(r.liquidity?.usd);
      const chain = getChain(chainId);
      const counterpart = base === token.toLowerCase() ? quote : base;
      const allowed = [chain.primaryStable, chain.wrappedNative].filter(Boolean).some(a => a!.toLowerCase() === counterpart);
      const protocol = labels.includes('v4') ? 'v4' : labels.includes('v3') ? 'v3' : null;
      const identity = String(r.pairAddress ?? '');
      return r.chainId === 'robinhood' && r.dexId === 'uniswap' && protocol !== null && exactPair && allowed
        && (protocol === 'v4' ? HEX32.test(identity) : HEX20.test(identity))
        && Number.isFinite(liquidity) && liquidity >= 25_000 && Number.isFinite(age) && now - age >= 1_800_000;
    }).sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd) || String(a.pairAddress).localeCompare(String(b.pairAddress))).slice(0, 10);
    if (!candidates.length) return { addresses: new Set(), hints: [], found: rows.length, filtered: rows.length, fallbackUsed: true, fallbackReason: 'NO_USABLE_POOLS' };
    const hints: ExternalPoolHint[] = candidates.map(row => {
      const base = addressSchema.parse(String(row.baseToken.address));
      const quote = addressSchema.parse(String(row.quoteToken.address));
      const protocol = (Array.isArray(row.labels) && row.labels.map(String).includes('v4')) ? 'v4' : 'v3';
      const rawId = String(row.pairAddress).toLowerCase();
      const key = protocol === 'v4' && row.poolKey && typeof row.poolKey === 'object' ? row.poolKey : undefined;
      return {
        identity: rawId, protocol, token0: BigInt(base) < BigInt(quote) ? base : quote, token1: BigInt(base) < BigInt(quote) ? quote : base,
        fee: Number(key?.fee ?? row.fee), tickSpacing: Number(key?.tickSpacing), hooks: key?.hooks ? addressSchema.parse(String(key.hooks)) : undefined,
        poolId: protocol === 'v4' ? rawId as `0x${string}` : undefined,
        liquidityUsd: Number(row.liquidity.usd), volume1hUsd: Number(row.volume?.h1), pairCreatedAt: Number(row.pairCreatedAt), source: 'DEXSCREENER',
      };
    });
    return { addresses: new Set(hints.map(h => h.identity)), hints, found: rows.length, filtered: rows.length - candidates.length, fallbackUsed: false };
  } catch { return { addresses: new Set(), hints: [], found: 0, filtered: 0, fallbackUsed: true, fallbackReason: 'REQUEST_FAILED' }; }
}

/** The same bounded V4 pool index used by the Uniswap Interface. */
export async function fetchUniswapV4Hints(chainId: ChainId, token: Address, first = 25): Promise<ExternalPoolHint[]> {
  if (chainId !== 4663) return [];
  const query = 'query TopV4($chain: Chain!, $token: String!, $first: Int!) { topV4Pools(chain: $chain, tokenFilter: $token, first: $first) { id protocolVersion feeTier totalLiquidity { value } token0 { symbol address } token1 { symbol address } } }';
  const response = await fetch('https://interface.gateway.uniswap.org/v1/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
    body: JSON.stringify({ query, variables: { chain: 'ROBINHOOD', token: token.toLowerCase(), first: Math.max(1, Math.min(25, first)) } }),
  });
  if (!response.ok) throw new Error(`UNISWAP_GRAPHQL_HTTP_${response.status}`);
  const body = await response.json() as { data?: { topV4Pools?: unknown[] }; errors?: Array<{ message?: string }> };
  if (body.errors?.length) throw new Error(`UNISWAP_GRAPHQL_ERROR:${String(body.errors[0]?.message ?? 'unknown').slice(0, 100)}`);
  if (!Array.isArray(body.data?.topV4Pools)) throw new Error('UNISWAP_GRAPHQL_MALFORMED');
  const chain = getChain(chainId), allowed = new Set([chain.primaryStable, chain.wrappedNative].filter(Boolean).map(a => a!.toLowerCase()));
  const hints: ExternalPoolHint[] = [];
  for (const row of body.data.topV4Pools) {
    if (!row || typeof row !== 'object') continue;
    const p = row as Record<string, any>, id = decodeUniswapV4PoolId(String(p.id ?? ''));
    const a = p.token0?.address, b = p.token1?.address;
    if (!id || !HEX20.test(String(a ?? '')) || !HEX20.test(String(b ?? ''))) continue;
    const token0 = addressSchema.parse(a), token1 = addressSchema.parse(b);
    const counterpart = token0.toLowerCase() === token.toLowerCase() ? token1 : token1.toLowerCase() === token.toLowerCase() ? token0 : null;
    if (!counterpart || !allowed.has(counterpart.toLowerCase())) continue;
    const liquidityUsd = Number(p.totalLiquidity?.value), fee = Number(p.feeTier);
    if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0 || !Number.isInteger(fee) || fee < 0 || fee > 0xffffff) continue;
    hints.push({ identity: id, protocol: 'v4', poolId: id, token0, token1, fee, liquidityUsd, source: 'UNISWAP_GRAPHQL' });
  }
  return hints.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || a.identity.localeCompare(b.identity));
}

/** Gecko's top_pools are a V3 discovery fallback; contract identity remains RPC-owned. */
export async function fetchGeckoV3Hints(chainId: ChainId, token: Address): Promise<ExternalPoolHint[]> {
  if (chainId !== 4663) return [];
  const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}?include=top_pools`);
  if (!response.ok) throw new Error(`GECKO_HTTP_${response.status}`);
  const body = await response.json() as { included?: unknown[] };
  if (!Array.isArray(body.included)) throw new Error('GECKO_MALFORMED');
  const chain = getChain(chainId), allowed = new Set([chain.primaryStable, chain.wrappedNative].filter(Boolean).map(a => a!.toLowerCase()));
  const hints: ExternalPoolHint[] = [];
  for (const row of body.included) {
    if (!row || typeof row !== 'object') continue;
    const p = row as Record<string, any>;
    if (p.type !== 'pool' || !String(p.relationships?.dex?.data?.id ?? '').toLowerCase().includes('uniswap-v3')) continue;
    const identity = String(p.attributes?.address ?? String(p.id ?? '').split('_').pop() ?? '').toLowerCase();
    const base = String(p.relationships?.base_token?.data?.id ?? '').split('_').pop() ?? '';
    const quote = String(p.relationships?.quote_token?.data?.id ?? '').split('_').pop() ?? '';
    if (!HEX20.test(identity) || !HEX20.test(base) || !HEX20.test(quote)) continue;
    const [token0, token1] = [addressSchema.parse(base), addressSchema.parse(quote)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const counterpart = token0.toLowerCase() === token.toLowerCase() ? token1 : token1.toLowerCase() === token.toLowerCase() ? token0 : null;
    if (!counterpart || !allowed.has(counterpart.toLowerCase())) continue;
    const liquidityUsd = Number(p.attributes?.reserve_in_usd);
    if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) continue;
    hints.push({ identity, protocol: 'v3', token0, token1, liquidityUsd, source: 'GECKOTERMINAL' });
  }
  return hints.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || a.identity.localeCompare(b.identity));
}

/** Convert verified external hints into PoolRefs without doing broad discovery. */
const FEE_CANDIDATES = [100, 500, 3000, 10000, 40000];
const SPACING_CANDIDATES = [1, 10, 50, 60, 100, 200, 250, 300, 400, 500, 600, 644, 800, 1000, 2000, 16000];

export type PoolKeyRecovery = { poolId: string; method: TargetedPool['recoveryMethod'] | null; failureReason?: string };

/** Trust only a full on-chain key, or a zero-hook tuple that hashes exactly to the hint. */
export async function recoverExternalV4PoolHints(client: PublicClient, chainId: ChainId, token: Address, hints: ExternalPoolHint[], onRecovery?: (result: PoolKeyRecovery) => void, onInitializeScan?: () => void): Promise<TargetedPool[]> {
  const result: TargetedPool[] = [];
  const unresolved: ExternalPoolHint[] = [];
  for (const h of hints.filter(h => h.token0.toLowerCase() === token.toLowerCase() || h.token1.toLowerCase() === token.toLowerCase())) {
    if (h.protocol === 'v3') { result.push({ chainId, protocol: 'v3', dex: 'uniswap', poolAddress: h.identity as Address, token0: h.token0, token1: h.token1, fee: h.fee ?? 0, discoveredAtBlock: 0n, source: h.source, liquidityUsd: h.liquidityUsd }); continue; }
    if (!h.poolId || !HEX32.test(h.poolId)) { onRecovery?.({ poolId: h.identity, method: null, failureReason: 'MISSING_POOL_ID' }); continue; }
    try {
      const key = await client.readContract({ address: getChain(chainId).v4.positionManager, abi: v4PositionManagerPoolKeyAbi, functionName: 'poolKeys', args: [poolIdToBytes25(h.poolId)] });
      const record = key as unknown as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
      const tuple = Array.isArray(key) ? key : [record.currency0, record.currency1, record.fee, record.tickSpacing, record.hooks];
      const [currency0, currency1, fee, tickSpacing, hooks] = tuple;
      const candidate: TargetedPool = { chainId, protocol: 'v4', dex: 'uniswap', poolId: h.poolId, token0: addressSchema.parse(currency0), token1: addressSchema.parse(currency1), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: addressSchema.parse(hooks), discoveredAtBlock: 0n, source: h.source, liquidityUsd: h.liquidityUsd, recoveryMethod: 'POOLKEYS_BYTES25' };
      if (candidate.tickSpacing === 0) throw new Error('POOLKEYS_EMPTY');
      if (candidate.token0 !== h.token0 || candidate.token1 !== h.token1) throw new Error('TOKEN_PAIR_MISMATCH');
      if (poolId({ currency0: candidate.token0, currency1: candidate.token1, fee: candidate.fee!, tickSpacing: candidate.tickSpacing!, hooks: candidate.hooks! }).toLowerCase() !== h.poolId.toLowerCase()) throw new Error('POOL_ID_MISMATCH');
      onRecovery?.({ poolId: h.poolId, method: 'POOLKEYS_BYTES25' });
      result.push(candidate);
    } catch {
      const sorted = BigInt(h.token0) < BigInt(h.token1) ? [h.token0, h.token1] : [h.token1, h.token0];
      let matched: TargetedPool | null = null;
      for (const fee of [...new Set([h.fee, ...FEE_CANDIDATES].filter((n): n is number => Number.isInteger(n) && n! >= 0))]) {
        for (const tickSpacing of SPACING_CANDIDATES) {
          const key = { currency0: sorted[0]!, currency1: sorted[1]!, fee, tickSpacing, hooks: ZERO_HOOK };
          if (poolId(key).toLowerCase() !== h.poolId.toLowerCase()) continue;
          matched = { chainId, protocol: 'v4', dex: 'uniswap', poolId: h.poolId, token0: key.currency0, token1: key.currency1, fee, tickSpacing, hooks: ZERO_HOOK, discoveredAtBlock: 0n, source: h.source, liquidityUsd: h.liquidityUsd, recoveryMethod: 'DETERMINISTIC_HASH' };
          break;
        }
        if (matched) break;
      }
      if (matched) { result.push(matched); onRecovery?.({ poolId: h.poolId, method: 'DETERMINISTIC_HASH' }); }
      else unresolved.push(h);
    }
  }
  if (unresolved.length) {
    onInitializeScan?.();
    const allowedQuotes = new Set(getChain(chainId).quoteTokens.map(a => a.toLowerCase()));
    const quoteTokens = [...new Set(unresolved
      .map(h => h.token0.toLowerCase() === token.toLowerCase() ? h.token1 : h.token0)
      .filter(a => allowedQuotes.has(a.toLowerCase())))] as Address[];
    let initialized: TargetedPool[] = [];
    let initializeError: string | null = null;
    try {
      initialized = await discoverV4PoolsForToken(client, chainId, token, { quoteTokens });
    } catch (error) {
      initializeError = `INITIALIZE_RPC_FAILURE:${error instanceof Error ? error.message : String(error)}`;
      initialized = [];
    }
    const byPoolId = new Map(initialized.filter(p => p.poolId).map(p => [p.poolId!.toLowerCase(), p]));
    for (const h of unresolved) {
      const candidate = h.poolId ? byPoolId.get(h.poolId.toLowerCase()) : undefined;
      try {
        if (!candidate || !candidate.poolId || candidate.fee === undefined || candidate.tickSpacing === undefined || !candidate.hooks) throw new Error('INITIALIZE_NOT_FOUND');
        if (candidate.token0.toLowerCase() !== h.token0.toLowerCase() || candidate.token1.toLowerCase() !== h.token1.toLowerCase()) throw new Error('TOKEN_PAIR_MISMATCH');
        const recomputed = poolId({ currency0: candidate.token0, currency1: candidate.token1, fee: candidate.fee, tickSpacing: candidate.tickSpacing, hooks: candidate.hooks });
        if (recomputed.toLowerCase() !== h.poolId!.toLowerCase()) throw new Error('POOL_ID_MISMATCH');
        result.push({ ...candidate, source: h.source, liquidityUsd: h.liquidityUsd, recoveryMethod: 'INITIALIZE_LOG' });
        onRecovery?.({ poolId: h.identity, method: 'INITIALIZE_LOG' });
      } catch (error) {
        onRecovery?.({ poolId: h.identity, method: null, failureReason: initializeError ?? (error instanceof Error ? error.message : 'RECOVERY_FAILED') });
      }
    }
  }
  return result;
}

/** Backwards-compatible pure conversion for callers with complete metadata. */
export function externalHintsToTargeted(chainId: ChainId, token: Address, hints: ExternalPoolHint[]): TargetedPool[] {
  const complete = hints.filter(h => h.protocol === 'v3' || (h.poolId && h.fee !== undefined && h.tickSpacing !== undefined && h.hooks));
  const result: TargetedPool[] = [];
  for (const h of complete) {
    if (h.protocol === 'v3') result.push({ chainId, protocol: 'v3', dex: 'uniswap', poolAddress: h.identity as Address, token0: h.token0, token1: h.token1, fee: h.fee ?? 0, discoveredAtBlock: 0n });
    else result.push({ chainId, protocol: 'v4', dex: 'uniswap', poolId: h.poolId!, token0: h.token0, token1: h.token1, fee: h.fee!, tickSpacing: h.tickSpacing!, hooks: h.hooks!, discoveredAtBlock: 0n });
  }
  return result;
}

/** Deterministic liquidity ordering used before bounded pool enrichment. */
export function rankVerifiedTargetedPools(pools: VerifiedTargetedPool[], limit = 10): VerifiedTargetedPool[] {
  return [...pools].sort((a, b) => (b.pool.liquidityUsd ?? -1) - (a.pool.liquidityUsd ?? -1) || (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0)
    || (a.pool.poolAddress ?? a.pool.poolId ?? '').localeCompare(b.pool.poolAddress ?? b.pool.poolId ?? '')).slice(0, limit);
}

export type PoolDiscoveryEvidence = {
  graphqlV4Hints: Array<{ poolId: string; liquidityUsd: number | null }>;
  dexV4Hints: Array<{ poolId: string; liquidityUsd: number | null }>;
  dexV3Hints: Array<{ poolAddress: string; liquidityUsd: number | null }>;
  geckoV3FallbackUsed: boolean;
  geckoV3Hints: Array<{ poolAddress: string; liquidityUsd: number | null }>;
  recovery: PoolKeyRecovery[];
  verification: Array<{ identity: string; protocol: 'v3' | 'v4'; source: string; verified: boolean; reason?: string; activeLiquidity?: string; tick?: number; sqrtPriceX96?: string }>;
  fallbackUsed: boolean;
  fallbackReason?: string;
  providerErrors: string[];
  finalOutcome?: 'VERIFIED_POOLS' | 'NO_SUPPORTED_POOL' | 'PROVIDER_FAILURE';
  ranked: Array<{ identity: string; protocol: 'v3' | 'v4'; source: string; liquidityUsd: number | null; activeLiquidity: string; recoveryMethod?: string }>;
  selectedPool?: string;
};

export function mergeExternalPoolHints(...sources: ExternalPoolHint[][]): ExternalPoolHint[] {
  const seen = new Set<string>(), merged: ExternalPoolHint[] = [];
  for (const source of sources) for (const hint of source) {
    const key = `${hint.protocol}:${hint.identity.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key); merged.push(hint);
  }
  return merged.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || a.identity.localeCompare(b.identity));
}

/** Finish both protocol searches before choosing a pool. Provider data is advisory. */
export async function searchVerifiedPoolsForToken(
  client: PublicClient, chainId: ChainId, token: Address,
  options: { dex?: ExternalPoolShortlist; verify?: typeof verifyPool; head?: bigint } = {},
): Promise<{ pools: VerifiedTargetedPool[]; evidence: PoolDiscoveryEvidence }> {
  const evidence: PoolDiscoveryEvidence = { graphqlV4Hints: [], dexV4Hints: [], dexV3Hints: [], geckoV3FallbackUsed: false, geckoV3Hints: [], recovery: [], verification: [], fallbackUsed: false, providerErrors: [], ranked: [] };
  const verify = options.verify ?? verifyPool;
  const [graphqlResult, dexResult] = await Promise.allSettled([
    fetchUniswapV4Hints(chainId, token),
    options.dex ? Promise.resolve(options.dex) : dexScreenerShortlist(chainId, token),
  ]);
  const graphql = graphqlResult.status === 'fulfilled' ? graphqlResult.value : [];
  const dex = dexResult.status === 'fulfilled' ? dexResult.value : null;
  if (graphqlResult.status === 'rejected') evidence.providerErrors.push(`GRAPHQL:${String(graphqlResult.reason).slice(0, 120)}`);
  if (dexResult.status === 'rejected' || dex?.fallbackReason === 'REQUEST_FAILED') evidence.providerErrors.push(`DEXSCREENER:${dexResult.status === 'rejected' ? String(dexResult.reason).slice(0, 120) : 'REQUEST_FAILED'}`);
  const dexHints = dex?.hints ?? [];
  evidence.graphqlV4Hints = graphql.map(h => ({ poolId: h.identity, liquidityUsd: h.liquidityUsd ?? null }));
  evidence.dexV4Hints = dexHints.filter(h => h.protocol === 'v4').map(h => ({ poolId: h.identity, liquidityUsd: h.liquidityUsd ?? null }));
  evidence.dexV3Hints = dexHints.filter(h => h.protocol === 'v3').map(h => ({ poolAddress: h.identity, liquidityUsd: h.liquidityUsd ?? null }));
  let gecko: ExternalPoolHint[] = [];
  if (chainId === 4663 && evidence.dexV3Hints.length === 0) {
    evidence.geckoV3FallbackUsed = true;
    try { gecko = await fetchGeckoV3Hints(chainId, token); }
    catch (error) { evidence.providerErrors.push(`GECKO:${String(error).slice(0, 120)}`); }
    evidence.geckoV3Hints = gecko.map(h => ({ poolAddress: h.identity, liquidityUsd: h.liquidityUsd ?? null }));
  }
  const hints = mergeExternalPoolHints(graphql, dexHints, gecko);
  let initializeAlreadySearched = false;
  const mapped = await recoverExternalV4PoolHints(client, chainId, token, hints, r => evidence.recovery.push(r), () => { initializeAlreadySearched = true; });
  if (initializeAlreadySearched) { evidence.fallbackUsed = true; evidence.fallbackReason = 'V4_IDENTITY_RECOVERY'; }
  for (const recovery of evidence.recovery) if (recovery.failureReason?.startsWith('INITIALIZE_RPC_FAILURE')) evidence.providerErrors.push(recovery.failureReason);
  const verified: VerifiedTargetedPool[] = [], seen = new Set<string>();
  const head = options.head ?? await client.getBlockNumber({ cacheTime: 0 });
  const check = async (pool: TargetedPool) => {
    const identity = (pool.poolId ?? pool.poolAddress ?? '').toLowerCase(), key = `${pool.protocol}:${identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const ref = targetedPoolToRef(pool), state = await verify(client, ref, head);
      if (!state.verified || state.liquidity <= 0n) throw new Error('POOL_NOT_LIVE');
      if (state.token0.address.toLowerCase() !== pool.token0.toLowerCase() || state.token1.address.toLowerCase() !== pool.token1.toLowerCase()) throw new Error('TOKEN_PAIR_MISMATCH');
      verified.push({ pool, ref, liquidity: state.liquidity });
      evidence.verification.push({ identity, protocol: pool.protocol, source: pool.source ?? 'RPC_FALLBACK', verified: true, activeLiquidity: state.liquidity.toString(), tick: state.tick, sqrtPriceX96: state.sqrtPriceX96.toString() });
    } catch (error) { evidence.verification.push({ identity, protocol: pool.protocol, source: pool.source ?? 'RPC_FALLBACK', verified: false, reason: error instanceof Error ? error.message : 'VERIFICATION_FAILED' }); }
  };
  await Promise.all(mapped.map(check));

  // No external V4 hint: a recent Initialize scan remains the final V4 source.
  // A verified V3 pool never suppresses this search or unresolved V4 recovery.
  if (!verified.some(p => p.pool.protocol === 'v4') && !initializeAlreadySearched) {
    evidence.fallbackUsed = true; evidence.fallbackReason = hints.some(h => h.protocol === 'v4') ? 'NO_VERIFIED_EXTERNAL_V4' : 'NO_EXTERNAL_V4_HINT';
    try { for (const pool of await discoverV4PoolsForToken(client, chainId, token)) await check({ ...pool, source: 'RPC_FALLBACK', recoveryMethod: 'INITIALIZE_LOG' }); }
    catch (error) { evidence.providerErrors.push(`V4_RPC_FAILURE:${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!verified.some(p => p.pool.protocol === 'v3')) {
    evidence.fallbackUsed = true; evidence.fallbackReason ??= hints.some(h => h.protocol === 'v3') ? 'NO_VERIFIED_EXTERNAL_V3' : 'NO_EXTERNAL_V3_HINT';
    try { for (const pool of await discoverV3PoolsForToken(client, chainId, token)) await check({ ...pool, source: 'RPC_FALLBACK' }); }
    catch (error) { evidence.providerErrors.push(`V3_RPC_FAILURE:${error instanceof Error ? error.message : String(error)}`); }
  }
  const ranked = rankVerifiedTargetedPools(verified, 10);
  evidence.ranked = ranked.map(p => ({ identity: p.pool.poolId ?? p.pool.poolAddress ?? '', protocol: p.pool.protocol, source: p.pool.source ?? 'RPC_FALLBACK', liquidityUsd: p.pool.liquidityUsd ?? null, activeLiquidity: p.liquidity.toString(), recoveryMethod: p.pool.recoveryMethod }));
  evidence.selectedPool = evidence.ranked[0]?.identity;
  evidence.finalOutcome = ranked.length ? 'VERIFIED_POOLS' : evidence.providerErrors.length ? 'PROVIDER_FAILURE' : 'NO_SUPPORTED_POOL';
  return { pools: ranked, evidence };
}

/**
 * Maximum lookback window (in seconds) for V4 Initialize event scan.
 * 7 days is enough to catch the long tail of newly trending tokens
 * without scanning the entire chain history.
 */
export const DEFAULT_V4_LOOKBACK_SECONDS = 7 * 86400;

export interface TargetedPoolDiscoveryOptions {
  /** Quote tokens to pair `token` with. Defaults to chain's `quoteTokens`. */
  quoteTokens?: Address[];
  /** V3 fee tiers to query. Defaults to chain config. */
  v3FeeTiers?: number[];
  /** V4 Initialize-event lookback window in seconds. Defaults to 7 days. */
  v4LookbackSeconds?: number;
  /** Override the head block for V4 scan. Defaults to RPC head. */
  v4FromBlock?: bigint;
}

/**
 * Discover V3 pools for (token, quote) pairs using the on-chain factory.
 * Returns one entry per (dex, feeTier) where the factory reports a
 * non-zero pool. The caller is responsible for downstream screening
 * (verification, depth, tick range, etc.).
 */
export async function discoverV3PoolsForToken(
  client: PublicClient,
  chainId: ChainId,
  token: Address,
  options: TargetedPoolDiscoveryOptions = {},
): Promise<TargetedPool[]> {
  const chain = getChain(chainId);
  token = addressSchema.parse(token);
  const quotes = (options.quoteTokens && options.quoteTokens.length > 0 ? options.quoteTokens : chain.quoteTokens)
    .map((q) => addressSchema.parse(q));
  if (token === zeroAddress) return [];

  const head = await client.getBlockNumber({ cacheTime: 0 });
  const results: TargetedPool[] = [];

  for (const quote of quotes) {
    if (quote === token) continue;
    for (const [dexKey, deployment] of Object.entries(chain.v3)) {
      const feeTiers = options.v3FeeTiers ?? deployment.feeTiers;
      for (const fee of feeTiers) {
        try {
          const poolAddress = await client.readContract({
            address: deployment.factory, abi: factoryAbi,
            functionName: 'getPool', args: [token, quote, fee], blockNumber: head,
          });
          if (!poolAddress || poolAddress.toLowerCase() === zeroAddress) continue;
          results.push({
            chainId, protocol: 'v3', dex: dexKey as 'uniswap' | 'pancakeswap',
            poolAddress: addressSchema.parse(poolAddress),
            token0: token < quote ? token : quote,
            token1: token < quote ? quote : token,
            fee, discoveredAtBlock: head,
          });
        } catch { /* ignore factory errors per (token, quote, fee) */ }
      }
    }
  }
  return results;
}

/**
 * Discover V4 pools for (token, quote) pairs by scanning Initialize
 * events backwards from the head block within a small window. Pools
 * discovered this way are returned with their full PoolKey so the
 * caller can `verifyPool()` them on-chain.
 */
export async function discoverV4PoolsForToken(
  client: PublicClient,
  chainId: ChainId,
  token: Address,
  options: TargetedPoolDiscoveryOptions = {},
): Promise<TargetedPool[]> {
  const chain = getChain(chainId);
  token = addressSchema.parse(token);
  const quotes = (options.quoteTokens && options.quoteTokens.length > 0 ? options.quoteTokens : chain.quoteTokens)
    .map((q) => addressSchema.parse(q));
  if (token === zeroAddress) return [];

  const head = await client.getBlockNumber({ cacheTime: 0 });
  const lookback = options.v4LookbackSeconds ?? DEFAULT_V4_LOOKBACK_SECONDS;
  // Block timestamp -> block height (binary search over head)
  const headBlock = await client.getBlock({ blockNumber: head });
  const targetTs = Number(headBlock.timestamp) - lookback;
  let low = 0n, high = head;
  while (low < high) {
    const mid = (low + high) / 2n;
    const ts = Number((await client.getBlock({ blockNumber: mid })).timestamp);
    if (ts < targetTs) low = mid + 1n;
    else high = mid;
  }
  const fromBlock = options.v4FromBlock ?? low;

  const logs = (await Promise.all(quotes.filter(quote => quote !== token).map(quote => {
    const currency0 = BigInt(token) < BigInt(quote) ? token : quote;
    const currency1 = currency0 === token ? quote : token;
    return pagedLogs(fromBlock, head, (start, end) => client.getLogs({
      address: chain.v4.poolManager,
      event: initializeEvent,
      args: { currency0, currency1 },
      strict: true,
      fromBlock: start,
      toBlock: end,
    }), 50_000n);
  }))).flat();

  const results: TargetedPool[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    if (log.removed) continue;
    const args = log.args;
    const { currency0, currency1 } = args;
    if (currency0.toLowerCase() !== token.toLowerCase() && currency1.toLowerCase() !== token.toLowerCase()) continue;
    if (!quotes.some((q) => q.toLowerCase() === currency0.toLowerCase() || q.toLowerCase() === currency1.toLowerCase())) continue;
    const id = `${currency0.toLowerCase()}-${currency1.toLowerCase()}-${args.fee}-${args.tickSpacing}-${args.hooks.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      chainId, protocol: 'v4', dex: 'uniswap',
      poolId: args.id,
      token0: addressSchema.parse(currency0),
      token1: addressSchema.parse(currency1),
      fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks,
      discoveredAtBlock: log.blockNumber ?? head,
    });
  }
  return results;
}

/**
 * Combined: discover all pools (V3 + V4) for a single token on a
 * single chain, using only on-chain RPC calls. No indexer.
 *
 * Quote tokens default to the chain's `quoteTokens`. Override via
 * `options.quoteTokens` (e.g. allow only USDC, or only WETH, for
 * tighter selection).
 */
export async function discoverPoolsForToken(
  client: PublicClient,
  chainId: ChainId,
  token: Address,
  options: TargetedPoolDiscoveryOptions = {},
): Promise<TargetedPool[]> {
  token = addressSchema.parse(token);
  const [v3, v4] = await Promise.all([
    discoverV3PoolsForToken(client, chainId, token, options),
    discoverV4PoolsForToken(client, chainId, token, options),
  ]);
  return [...v3, ...v4];
}
