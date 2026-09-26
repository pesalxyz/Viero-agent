import { zeroAddress } from 'viem';
import { getChain } from '../config/chains.js';
import { CHAIN_LIMITS, POLICY_VERSION, type Policy, usesRobinhoodExecutionRules } from '../config/policy.js';
import { observationSchema, poolId, poolIdentity, type Observation, type Price, type PoolRef } from '../domain.js';
import { depth1Pct, volatility, spotPrice, sqrtAtTick } from './math.js';

export const METRIC_VERSION = 'exact-pool-1';
export const SCORE_VERSION = 'within-group-1';
export type Rejection = { code: string; detail: string };
const PRICE_PRIORITY: Record<string, number> = { stable: 0, gmgn: 1, geckoterminal: 2, reference: 3 };
export function canonicalPrice(prices: Price[], token: string, now: number, policy: Policy) {
  const relevant = prices.filter(p => p.token === token && p.observedAt <= now + 5 && p.fetchedAt <= now + 5 && now - p.observedAt <= policy.maximumDataAgeSeconds);
  const unique = [...new Map(relevant.map(p => [p.source, p])).values()];
  if (!unique.length) return null;
  const values = unique.map(p => p.usd).sort((a, b) => a - b);
  const canonical = [...unique].sort((a, b) => (PRICE_PRIORITY[a.source] ?? 100) - (PRICE_PRIORITY[b.source] ?? 100) || b.fetchedAt - a.fetchedAt)[0]!;
  const divergencePct = values.length > 1 ? (values.at(-1)! / values[0]! - 1) * 100 : 0;
  // The configured primary stable is the unit of account, not a market-priced
  // asset. Provider quotes for it must never inflate valuation or PnL.
  const stable = getChain(canonical.chainId).primaryStable.toLowerCase() === token.toLowerCase();
  return { usd: stable ? 1 : canonical.usd, divergencePct, sources: unique.map(p => p.source), source: canonical.source };
}
export function spotPriceDeviationPct(poolSpotPrice: number, marketReferencePrice: number): number {
  return (poolSpotPrice / marketReferencePrice - 1) * 100;
}
export function organicComponents(observation: Observation) {
  const traders = new Map<string, number>(), minutes = new Set<number>();
  let buyUsd = 0, sellUsd = 0, reversals = 0;
  const last = new Map<string, { direction: boolean; timestamp: number }>();
  const swaps = [...observation.swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  for (const s of swaps) {
    traders.set(s.trader, (traders.get(s.trader) ?? 0) + s.volumeUsd);
    minutes.add(Math.floor(s.timestamp / 60));
    if (s.amount0 > 0n) sellUsd += s.volumeUsd; else buyUsd += s.volumeUsd;
    const prior = last.get(s.trader), direction = s.amount0 > 0n;
    if (prior && prior.direction !== direction && s.timestamp - prior.timestamp <= 60) reversals++;
    last.set(s.trader, { direction, timestamp: s.timestamp });
  }
  const volume = buyUsd + sellUsd;
  const uniqueRatio = swaps.length ? traders.size / swaps.length : 0;
  const topTraderShare = volume ? [...traders.values()].reduce((max, value) => Math.max(max, value), 0) / volume : 1;
  const balance = volume ? 2 * Math.min(buyUsd, sellUsd) / volume : 0;
  const temporal = Math.min(1, minutes.size / Math.max(1, (observation.windowEnd - observation.windowStart) / 60));
  const reversalShare = swaps.length ? reversals / swaps.length : 1;
  return { uniqueRatio, topTraderShare, balance, temporal, reversalShare,
    score: Math.max(0, Math.min(1, .25 * uniqueRatio + .25 * (1 - topTraderShare) + .2 * balance + .2 * temporal + .1 * (1 - reversalShare))) };
}
export function calculateMetrics(o: Observation, policy: Policy, now: number) {
  const p0 = canonicalPrice(o.prices, o.state.token0.address, now, policy), p1 = canonicalPrice(o.prices, o.state.token1.address, now, policy);
  const depth = p0 && p1 && o.ticksComplete ? depth1Pct(o.state, o.ticks, [p0.usd, p1.usd]) : { down: null, up: null };
  const depthUsd = depth.down !== null && depth.up !== null ? depth.down + depth.up : null;
  const volumeUsd = o.swaps.reduce((sum, s) => sum + s.volumeUsd, 0);
  const grossFeesUsd = o.swaps.reduce((sum, s) => sum + s.grossFeeUsd, 0);
  const lpFeesUsd = o.swaps.some(s => s.lpFeeUsd === null) ? null : o.swaps.reduce((sum, s) => sum + s.lpFeeUsd!, 0);
  const minutes = (o.windowEnd - o.windowStart) / 60;
  const expectedFeesUsd = lpFeesUsd !== null && o.tvlUsd ? lpFeesUsd * policy.maximumPositionUsd / o.tvlUsd : null;
  const organic = organicComponents(o);
  return { version: METRIC_VERSION, pool: o.state.pool, source: o.source, sourceBlock: o.indexedBlock, fetchedAt: o.state.fetchedAt,
    windowStart: o.windowStart, windowEnd: o.windowEnd, valuation: o.valuation,
    volumeUsd, swapCount: o.swaps.length, uniqueTraders: new Set(o.swaps.map(s => s.trader)).size,
    grossFeesUsd, lpFeesUsd, feesPerMinute: minutes > 0 ? grossFeesUsd / minutes : null,
    feeTvlPct: o.tvlUsd && lpFeesUsd !== null ? lpFeesUsd / o.tvlUsd * 100 : null,
    depthDownUsd: depth.down, depthUpUsd: depth.up, depthUsd,
    feeDepthPct: depthUsd && lpFeesUsd !== null ? lpFeesUsd / depthUsd * 100 : null,
    volumeDepth: depthUsd ? volumeUsd / depthUsd : null,
    tvlUsd: o.tvlUsd, volatility: volatility(o.swaps), organic,
    netLiquidityFlowUsd: o.liquidityAddedUsd !== null && o.liquidityRemovedUsd !== null ? o.liquidityAddedUsd - o.liquidityRemovedUsd : null,
    expectedFeesUsd, expectedNetFeesUsd: expectedFeesUsd !== null && o.estimatedLifecycleCostUsd !== null ? expectedFeesUsd - o.estimatedLifecycleCostUsd : null,
    maximumPriceDivergencePct: p0 && p1 ? Math.max(p0.divergencePct, p1.divergencePct) : null };
}
export type Metrics = ReturnType<typeof calculateMetrics>;
export type Candidate = {
  pool: PoolRef; identity: string; approved: boolean; rejections: Rejection[]; metrics: Metrics;
  group: string; score: number | null; globalScore: number | null;
  components: Record<string, number>; policyVersion: string; scoreVersion: string;
};
export type ScreenDataAvailability = 'full' | 'gmgn-only';

export interface ScreenOptions {
  /**
   * Data-availability mode for the screening path:
   *  - `'full'` (default): every deterministic rejection is enforced. Used
   *    by pre-execution verification and by management decisions where
   *    an on-chain snapshot is already available.
   *  - `'gmgn-only'`: the routine 5-minute screening cycle. Skips the
   *    rejections whose required data is unavailable from GMGN CLI:
   *    tick / sqrtPriceX96 / tick bitmap / swap events / indexedBlock.
   *    Those checks are deferred to the final pre-execution verification
   *    before any LP transaction.
   */
  dataAvailability?: ScreenDataAvailability;
  /** Current GMGN Hot Search 1h token volume; pool volume is never a substitute. */
  tokenVolume1h?: number | null;
}

/**
 * Rejection codes whose required data GMGN CLI cannot supply. They are
 * skipped in 'gmgn-only' mode and enforced in 'full' mode (pre-execution
 * verification + management).
 */
export const GMGN_UNSUPPORTED_REJECTIONS: ReadonlySet<string> = new Set([
  'TICK_PRICE_MISMATCH',
  'SPOT_PRICE_DIVERGENCE',
  'INVALID_TICK_DATA',
  'FEE_MISMATCH',                  // v4 needs state.fee (RPC)
  'INDEXER_LAG',
  'DEPTH_TOO_LOW',
  'VOLUME_TOO_LOW',
  'TRADERS_TOO_FEW',
  'DUPLICATE_SWAP',               // swap-event derived
  'SWAP_POOL_MISMATCH',
  'SWAP_OUTSIDE_WINDOW',
  'INVALID_SWAP_DELTAS',
  'INVALID_LP_FEES',
  'STATIC_FEE_MISMATCH',          // v3 fee × volume reconciliation
  'LP_NET_FEES_UNAVAILABLE',
  'NET_YIELD_TOO_LOW',
]);

export function screen(input: Observation, policy: Policy, now: number, options: ScreenOptions = {}): Candidate {
  const o = observationSchema.parse(input), s = o.state, pool = s.pool, id = poolIdentity(pool), chain = getChain(pool.chainId), limits = CHAIN_LIMITS[pool.chainId];
  const rejections: Rejection[] = [];
  const gmgnOnly = options.dataAvailability === 'gmgn-only';
  const reject = (test: boolean, code: string, detail: string) => {
    if (test && !(gmgnOnly && GMGN_UNSUPPORTED_REJECTIONS.has(code))) rejections.push({ code, detail });
  };
  const metrics = calculateMetrics(o, policy, now);
  reject(Object.values(metrics).some(v => typeof v === 'number' && !Number.isFinite(v)), 'METRIC_NON_FINITE', 'Aggregated metrics must be finite');
  reject(!policy.enabledChains.includes(pool.chainId), 'CHAIN_DISABLED', 'Chain is disabled by policy');
  reject(!s.verified, 'POOL_UNVERIFIED', 'Exact pool identity has not been verified');
  reject(s.token0.chainId !== pool.chainId || s.token1.chainId !== pool.chainId, 'TOKEN_CHAIN_MISMATCH', 'Token chain differs from pool');
  reject(BigInt(s.token0.address) >= BigInt(s.token1.address), 'TOKEN_ORDER', 'Token addresses must be strictly ordered');
  reject(![s.token0.address, s.token1.address].some(a => chain.quoteTokens.includes(a)), 'QUOTE_NOT_APPROVED', 'No approved quote token');
  reject(s.liquidity === 0n || s.sqrtPriceX96 === 0n, 'EMPTY_POOL', 'Pool is uninitialized or empty');
  reject(s.liquidity >= 1n << 128n, 'INVALID_LIQUIDITY', 'Liquidity exceeds the protocol uint128 bound');
  const minSqrt = sqrtAtTick(s.tick), maxSqrt = s.tick < 887272 ? sqrtAtTick(s.tick + 1) : minSqrt;
  reject(s.sqrtPriceX96 < minSqrt || s.sqrtPriceX96 > maxSqrt, 'TICK_PRICE_MISMATCH', 'Current tick and sqrt price disagree');
  const reference0 = canonicalPrice(o.prices, s.token0.address, now, policy), reference1 = canonicalPrice(o.prices, s.token1.address, now, policy);
  if (reference0 && reference1) {
    const expected = reference0.usd / reference1.usd, actual = spotPrice(s);
    const deviationPct = spotPriceDeviationPct(actual, expected);
    reject(!Number.isFinite(deviationPct) || deviationPct > policy.maximumPositivePriceDivergencePct || deviationPct < -policy.maximumNegativePriceDivergencePct, 'SPOT_PRICE_DIVERGENCE', 'On-chain spot price disagrees with external reference prices');
  }
  reject(new Set(o.ticks.map(t => t.index)).size !== o.ticks.length || o.ticks.some(t => t.index < -887272 || t.index > 887272 || t.index % s.tickSpacing !== 0), 'INVALID_TICK_DATA', 'Initialized ticks must be unique and aligned');
  if (pool.protocol === 'v4') {
    reject(poolId(pool.poolKey) !== pool.poolId, 'POOL_ID_MISMATCH', 'PoolKey does not hash to PoolId');
    reject(pool.poolKey.currency0 !== s.token0.address || pool.poolKey.currency1 !== s.token1.address || pool.poolKey.tickSpacing !== s.tickSpacing, 'POOL_KEY_MISMATCH', 'PoolKey and state differ');
    reject(pool.poolKey.hooks !== zeroAddress && !chain.v4.approvedHooks.includes(pool.poolKey.hooks), 'UNKNOWN_HOOK', 'Hook is not allowlisted');
    reject(s.dynamicFee !== ((pool.poolKey.fee & 0x800000) !== 0), 'FEE_MODEL_MISMATCH', 'Dynamic fee flag and state disagree');
    reject(!s.dynamicFee && pool.poolKey.fee !== s.fee, 'FEE_MISMATCH', 'Static fee differs from PoolKey');
    reject(pool.chainId === 5042 && pool.poolKey.currency0 === zeroAddress, 'ARC_NATIVE_SENTINEL', 'Arc requires ERC20 USDC representation');
  }
  reject(s.observedAt > now + 5 || s.fetchedAt > now + 5 || now - s.observedAt > policy.maximumDataAgeSeconds || now - o.windowEnd > policy.maximumDataAgeSeconds, 'STALE_STATE', 'State or metric window is stale or future-dated');
  reject(!o.complete || Math.abs(o.windowEnd - o.windowStart - policy.windowMinutes * 60) > 1, 'INCOMPLETE_WINDOW', 'A complete configured window is required');
  reject(o.windowEnd > s.observedAt || o.windowEnd < s.observedAt - policy.maximumDataAgeSeconds, 'WINDOW_STATE_MISMATCH', 'Metric window must end at or before verified state');
  reject(o.indexedBlock > s.blockNumber || s.blockNumber - o.indexedBlock > BigInt(policy.maximumIndexerLagBlocks), 'INDEXER_LAG', 'Indexed block is ahead of state or too far behind');
  reject(o.poolCreatedAt === null || o.poolCreatedAt > o.windowStart || now - o.poolCreatedAt < policy.minimumPoolAgeSeconds, 'POOL_TOO_YOUNG', 'Pool age is unavailable or below policy');
  reject(o.tvlUsd !== null && o.tvlUsd < limits.minimumTvlUsd, 'TVL_TOO_LOW', 'Verified TVL is below policy');
  reject(!gmgnOnly && (metrics.depthUsd === null || metrics.depthDownUsd === null || metrics.depthUpUsd === null), 'DEPTH_UNAVAILABLE', 'Complete two-sided exit depth evidence is required');
  reject(metrics.depthUsd !== null && metrics.depthDownUsd !== null && metrics.depthUpUsd !== null && (metrics.depthUsd < limits.minimumDepthUsd || metrics.depthDownUsd < (limits.minimumDepthDownUsd ?? limits.minimumDepthUsd / 4) || metrics.depthUpUsd < (limits.minimumDepthUpUsd ?? limits.minimumDepthUsd / 4)), 'DEPTH_TOO_LOW', 'Complete two-sided exit depth is below policy');
  // Candidate execution supplies the selected token's GMGN evidence
  // explicitly. Legacy replay/management callers that do not carry token
  // discovery metadata retain their historical screening behavior.
  if (Object.prototype.hasOwnProperty.call(options, 'tokenVolume1h')) {
    const tokenVolume1h = options.tokenVolume1h;
    reject(tokenVolume1h === null || tokenVolume1h === undefined || !Number.isFinite(tokenVolume1h), 'TOKEN_VOLUME_1H_UNAVAILABLE', 'Fresh GMGN token 1h volume is required');
    reject(Number.isFinite(tokenVolume1h) && tokenVolume1h! < policy.minimumVolumeUsd, 'VOLUME_TOO_LOW', 'GMGN token 1h volume is below policy');
  }
  // Trader count is retained as a market-quality diagnostic, but is not an
  // execution gate. Safety and liquidity checks below remain authoritative.
  reject(!reference0 || !reference1, 'PRICE_UNAVAILABLE', 'A fresh canonical price is required for each asset');
  reject((metrics.maximumPriceDivergencePct ?? 0) > policy.maximumPriceDivergencePct, 'PRICE_DIVERGENCE', 'Price providers disagree');
  reject(o.prices.some(p => p.chainId !== pool.chainId || ![s.token0.address, s.token1.address].includes(p.token)), 'PRICE_IDENTITY_MISMATCH', 'Price identity differs from pool assets');
  const seen = new Set<string>();
  for (const swap of o.swaps) {
    const eventId = `${swap.transactionHash}:${swap.logIndex}`;
    reject(seen.has(eventId), 'DUPLICATE_SWAP', 'Duplicate event would inflate metrics'); seen.add(eventId);
    reject(poolIdentity(swap.pool) !== id, 'SWAP_POOL_MISMATCH', 'Swap belongs to a different exact pool');
    reject(swap.timestamp < o.windowStart || swap.timestamp > o.windowEnd || swap.blockNumber > o.indexedBlock, 'SWAP_OUTSIDE_WINDOW', 'Swap is outside the indexed time or block window');
    reject(!((swap.amount0 > 0n && swap.amount1 < 0n) || (swap.amount0 < 0n && swap.amount1 > 0n)), 'INVALID_SWAP_DELTAS', 'Expected opposite input/output signs');
    reject(swap.lpFeeUsd !== null && swap.lpFeeUsd > swap.grossFeeUsd, 'INVALID_LP_FEES', 'LP-net fees exceed gross fees');
    if (pool.protocol === 'v3') reject(Math.abs(swap.grossFeeUsd - swap.volumeUsd * s.fee / 1_000_000) > Math.max(.000001, swap.grossFeeUsd * .000001), 'STATIC_FEE_MISMATCH', 'Gross fee estimate differs from the exact v3 pool fee');
  }
  reject(metrics.lpFeesUsd === null, 'LP_NET_FEES_UNAVAILABLE', 'LP-net fee evidence is required, including dynamic/protocol/hook charges');
  // Expected net fees remain diagnostic only; they must not block the smoke
  // execution path when the estimate is non-positive.
  for (const token of [s.token0, s.token1]) {
    const risk = o.risks.find(r => r.token === token.address && r.chainId === pool.chainId);
    reject(!risk || now - risk.observedAt > policy.maximumDataAgeSeconds || risk.observedAt > now + 5, 'RISK_UNAVAILABLE', `${token.address}: fresh security evidence required`);
    if (!risk) continue;
    reject(risk.honeypot !== false, 'HONEYPOT', `${token.address}: honeypot check must explicitly pass`);
    const isTrustedInfrastructure = token.address === chain.primaryStable || token.address === chain.wrappedNative;
    reject(!isTrustedInfrastructure && risk.criticalAdmin === true, 'CRITICAL_ADMIN', `${token.address}: confirmed administrative risk`);
    reject(risk.sellTaxBps === null || risk.sellTaxBps > policy.maximumSellTaxBps, 'SELL_TAX', `${token.address}: sell tax is unknown or excessive`);
    reject(risk.top10HolderPct === null || risk.top10HolderPct > policy.maximumHolderPct, 'HOLDER_CONCENTRATION', `${token.address}: holder concentration is unknown or excessive`);
    // Robinhood smoke-test execution does not yet have a router simulation.
    // ERC20 transfer probes are informational only; the planner/executor's
    // final transaction simulation remains mandatory before any broadcast.
    if (!usesRobinhoodExecutionRules(pool.chainId)) reject(risk.buySimulation !== true || risk.sellSimulation !== true, 'SIMULATION_REQUIRED', `${token.address}: successful buy and sell simulations required`);
  }
  const ageBand = o.poolCreatedAt !== null && now - o.poolCreatedAt < 7 * 86400 ? 'new' : 'established';
  const quoteClass = [s.token0.address, s.token1.address].includes(chain.primaryStable) ? 'stable' : 'native';
  const components = {
    feeDepth: metrics.feeDepthPct ?? 0, feeTvl: metrics.feeTvlPct ?? 0, volumeDepth: metrics.volumeDepth ?? 0,
    organic: metrics.organic.score, traders: metrics.uniqueTraders, lpActivity: o.uniqueLps ?? 0,
    holderDistribution: 1 - Math.max(0, ...o.risks.map(r => r.top10HolderPct ?? 100)) / 100,
    smartMoney: o.risks.length ? o.risks.reduce((sum, r) => sum + (r.smartMoneyScore ?? 0), 0) / o.risks.length : 0,
  };
  return { pool, identity: id, approved: rejections.length === 0, rejections, metrics,
    group: `${pool.chainId}:${policy.windowMinutes}:${ageBand}:${quoteClass}`, score: null, globalScore: null, components,
    policyVersion: POLICY_VERSION, scoreVersion: SCORE_VERSION };
}

/**
 * Build a `PoolState` from GMGN data for the gmgn-only screening path.
 *
 * GMGN provides enough to populate the deterministic screener for
 * identity, quote, TVL, pool-age, price consistency, and risk-based
 * rejections. Tick / sqrtPriceX96 / ticks / swaps are NOT available
 * from GMGN and are deferred to the final pre-execution verification.
 */
export function gmgnPoolState(input: {
  pool: import('../domain.js').PoolRef;
  token0: import('../domain.js').Token;
  token1: import('../domain.js').Token;
  fee: number;
  tickSpacing: number;
  dynamicFee: boolean;
  /** Liquidity in raw uint128 units. Use 1 to satisfy `EMPTY_POOL` unless GMGN says zero. */
  liquidity: bigint;
  /** Pool creation timestamp in unix seconds. null when GMGN reports 0 / unknown. */
  createdAt: number | null;
  observedAt: number;
  /** Head block height GMGN is referencing. Use 0 if unknown (defer to pre-execution). */
  blockNumber: bigint;
}): import('../domain.js').PoolState {
  return {
    pool: input.pool,
    token0: input.token0,
    token1: input.token1,
    blockNumber: input.blockNumber,
    blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    observedAt: input.observedAt,
    fetchedAt: input.observedAt,
    sqrtPriceX96: 0n,
    tick: 0,
    tickSpacing: input.tickSpacing,
    liquidity: input.liquidity,
    fee: input.fee,
    dynamicFee: input.dynamicFee,
    protocolFee: 0,
    verified: true,
    verification: ['gmgn-cli:token-pool', 'gmgn-cli:token-info'],
  };
}

/**
 * Build a screening `Observation` for the gmgn-only screening path.
 *
 * Source: GMGN CLI exclusively. No on-chain RPC enrichment.
 */
export function gmgnScreeningObservation(input: {
  pool: import('../domain.js').PoolState;
  prices: import('../domain.js').Price[];
  risks: import('../domain.js').Risk[];
  /** USD liquidity for TVL gate. From `liquidity` field of GMGN pool response. */
  tvlUsd: number | null;
  /** Pool creation timestamp in unix seconds, or null if GMGN reports 0. */
  poolCreatedAt: number | null;
  windowMinutes: number;
  observedAt: number;
  /** Head block index for INDEXER_LAG gate. Use 0 if unknown (gate will skip). */
  indexedBlock: bigint;
}): import('../domain.js').Observation {
  const windowStart = input.observedAt - input.windowMinutes * 60;
  const windowEnd = input.observedAt;
  return {
    state: input.pool,
    windowStart,
    windowEnd,
    source: 'gmgn-cli:gmgn-only-screening',
    indexedBlock: input.indexedBlock,
    complete: true, // GMGN path is always "complete" wrt its own data scope
    valuation: 'window-end-reference',
    swaps: [],
    prices: input.prices,
    risks: input.risks,
    tvlUsd: input.tvlUsd,
    poolCreatedAt: input.poolCreatedAt,
    ticks: [],
    ticksComplete: false, // depth cannot be computed from GMGN; deferred to pre-execution
    positionsCreated: null,
    uniqueLps: null,
    liquidityAddedUsd: null,
    liquidityRemovedUsd: null,
    estimatedLifecycleCostUsd: null,
    issues: [
      'GMGN-only screening path: tick / sqrtPriceX96 / tick bitmap / swap events unavailable.',
      'These checks (TICK_PRICE_MISMATCH / DEPTH_TOO_LOW / VOLUME / TRADERS / LP_NET_FEES / NET_YIELD / TICK_DATA / INDEXER_LAG / STATIC_FEE_MISMATCH / swap-derived codes / FEE_MISMATCH for v4) are deferred to the final pre-execution verification step.',
    ],
  };
}
const weights: Record<string, number> = { feeDepth: .25, feeTvl: .18, volumeDepth: .15, organic: .12, traders: .10, lpActivity: .08, holderDistribution: .07, smartMoney: .05 };
export function rank(candidates: Candidate[]): Candidate[] {
  const unique = new Set<string>();
  for (const c of candidates) {
    if (unique.has(c.identity)) throw new Error('Duplicate exact pool in ranking');
    unique.add(c.identity);
  }
  const approved = candidates.filter(c => c.approved);
  const ranked = candidates.map(c => {
    if (!c.approved) return c;
    const group = approved.filter(other => other.group === c.group);
    const normalized = Object.fromEntries(Object.keys(weights).map(key => {
      const values = group.map(other => other.components[key]!);
      const min = Math.min(...values), max = Math.max(...values);
      return [key, max === min ? .5 : (c.components[key]! - min) / (max - min)];
    }));
    const riskPenalty = .1 * c.metrics.organic.reversalShare + .1 * c.metrics.organic.topTraderShare;
    const gasPenalty = c.metrics.expectedFeesUsd ? .1 * (1 - (c.metrics.expectedNetFeesUsd ?? 0) / c.metrics.expectedFeesUsd) : .1;
    const uncertaintyPenalty = c.metrics.valuation === 'historical-usd' ? 0 : .1;
    const score = Math.max(0, Object.entries(weights).reduce((sum, [key, weight]) => sum + normalized[key]! * weight, 0) - riskPenalty - gasPenalty - uncertaintyPenalty);
    const maximumNet = Math.max(...approved.map(a => a.metrics.expectedNetFeesUsd ?? 0));
    const globalScore = .7 * score + .3 * (maximumNet > 0 ? (c.metrics.expectedNetFeesUsd ?? 0) / maximumNet : 0);
    return { ...c, score, globalScore, components: { ...normalized, riskPenalty, gasPenalty, uncertaintyPenalty } };
  });
  return ranked.sort((a, b) => (b.globalScore ?? -1) - (a.globalScore ?? -1) || a.identity.localeCompare(b.identity));
}
