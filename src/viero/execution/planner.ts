import { type Address } from 'viem';
import { getChain } from '../config/chains.js';
import { CHAIN_LIMITS, type Policy } from '../config/policy.js';
import { type ChainId, type Observation, type PoolRef, poolIdentity } from '../domain.js';
import { canonicalPrice, type Candidate } from '../screening/pipeline.js';
import { amount0Delta, amount1Delta, humanQuotePriceFromSqrt, sqrtAtTick, tickAtHumanQuotePrice, tokenValue } from '../screening/math.js';
import { arcErc20ToNative, erc20Usdc } from '../domain/arc.js';
import type { ResolvedExecutionSettings } from '../strategy/executionSettings.js';

export type PortfolioLimits = { totalExposureUsd: number; chainExposureUsd: Partial<Record<ChainId, number>>; dailyLossUsd: number };
export type PositionPlan = {
  chainId: ChainId; pool: PoolRef; mode: 'paper' | 'live'; createdAt: number; deadline: number;
  sourceBlock: bigint; sourceBlockHash: string; tickLower: number; tickUpper: number;
  liquidity: bigint; poolFee: number; depositAssets: Array<{ token: Address; amount: bigint }>;
  expectedTransfers: Array<{ token: Address; direction: 'out'; maximumAmount: bigint }>; 
  slippageBps: number; maximumGasCostUsd: number; depositUsd: number;
  positionSizeUsd: number; rangePct: number; takeProfitPct: number; stopLossPct: number;
  sizeMode: 'AUTO' | 'FIXED'; rangeMode: 'AUTO' | 'FIXED';
};
export function orderFixedRangeTicks(a: number, b: number): { tickLower: number; tickUpper: number } {
  return a <= b ? { tickLower: a, tickUpper: b } : { tickLower: b, tickUpper: a };
}
function quoteAssetForPool(state: Observation['state']): { address: Address; isToken0: boolean } {
  const chain = getChain(state.pool.chainId), a0 = state.token0.address.toLowerCase(), a1 = state.token1.address.toLowerCase();
  const stable = chain.primaryStable.toLowerCase(), wrapped = chain.wrappedNative?.toLowerCase();
  const is0 = a0 === stable || a0 === wrapped, is1 = a1 === stable || a1 === wrapped;
  if (is0 === is1) throw new Error('UNSUPPORTED_QUOTE_ASSET');
  return { address: is0 ? state.token0.address : state.token1.address, isToken0: is0 };
}
export class InsufficientQuoteBalanceError extends Error {
  readonly code = 'INSUFFICIENT_QUOTE_BALANCE' as const;
  constructor(readonly details: { quoteAddress: Address; quoteSymbol: string; quoteDecimals: number; requiredRaw: bigint; availableRaw: bigint; requiredHuman: string; availableHuman: string; requiredUsd: number }) {
    super(`INSUFFICIENT_QUOTE_BALANCE: ${details.quoteSymbol} required ${details.requiredHuman}, available ${details.availableHuman} ($${details.requiredUsd})`);
    this.name = 'InsufficientQuoteBalanceError';
  }
}
export function refreshFixedRangePlan(plan: PositionPlan, state: Observation['state'], prices?: Observation['prices'], policy?: Policy): PositionPlan {
  if (plan.rangeMode !== 'FIXED' || state.pool.chainId !== 4663) return plan;
  const quote = quoteAssetForPool(state), stableIs0 = quote.isToken0, stableIs1 = !quote.isToken0;
  const current = humanQuotePriceFromSqrt({ sqrtPriceX96: state.sqrtPriceX96, quoteIsToken0: stableIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals });
  const lowerHuman = current * (1 - plan.rangePct / 100), upperHuman = current * 0.995;
  const lowerBound = tickAtHumanQuotePrice({ quotePerMeme: lowerHuman, quoteIsToken0: stableIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals, tickSpacing: state.tickSpacing, round: stableIs0 ? 'up' : 'down' });
  const upperBound = tickAtHumanQuotePrice({ quotePerMeme: upperHuman, quoteIsToken0: stableIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals, tickSpacing: state.tickSpacing, round: stableIs0 ? 'up' : 'down' });
  let lower = stableIs0 ? upperBound : lowerBound;
  let upper = stableIs0 ? lowerBound : upperBound;
  // Coarse fee tiers can have tick spacing wider than the 0.5% buffer. Move
  // the complete range one spacing outward when rounding would straddle the
  // current tick, preserving a quote-token-only deposit.
  if (stableIs0 && state.tick >= lower) { const shift = Math.floor((state.tick - lower) / state.tickSpacing) + 1; lower += shift * state.tickSpacing; upper += shift * state.tickSpacing; }
  if (!stableIs0 && state.tick <= upper) { const shift = Math.floor((upper - state.tick) / state.tickSpacing) + 1; lower -= shift * state.tickSpacing; upper -= shift * state.tickSpacing; }
  if (lower >= upper || (stableIs0 ? state.tick >= lower : state.tick <= upper)) throw new Error('FIXED_RANGE_NOT_SINGLE_SIDED_QUOTE');
  if (lower < -887272 || upper > 887272) throw new Error('FIXED_RANGE_TICK_INVALID');
  const lo = sqrtAtTick(lower), hi = sqrtAtTick(upper);
  const assets = stableIs0 ? [{ token: state.token0.address, amount: amount0Delta(state.sqrtPriceX96, hi, plan.liquidity) }, { token: state.token1.address, amount: 0n }] : [{ token: state.token0.address, amount: 0n }, { token: state.token1.address, amount: amount1Delta(lo, state.sqrtPriceX96, plan.liquidity) }];
  const snapshotNow = Math.max(state.observedAt, state.fetchedAt);
  const p0 = prices && policy ? canonicalPrice(prices, state.token0.address, snapshotNow, policy)?.usd : undefined;
  const p1 = prices && policy ? canonicalPrice(prices, state.token1.address, snapshotNow, policy)?.usd : undefined;
  const depositUsd = p0 != null && p1 != null
    ? tokenValue(assets[0]!.amount, state.token0.decimals, p0) + tokenValue(assets[1]!.amount, state.token1.decimals, p1)
    : plan.depositUsd;
  return { ...plan, sourceBlock: state.blockNumber, sourceBlockHash: state.blockHash, tickLower: lower, tickUpper: upper, poolFee: state.fee, depositAssets: assets, expectedTransfers: assets.map(a => ({ token: a.token, direction: 'out' as const, maximumAmount: a.amount })), depositUsd };
}
export function planPosition(observation: Observation, candidate: Candidate, budgetUsd: number, policy: Policy,
  portfolio: PortfolioLimits, now: number, wallet?: { native: bigint; tokens: Map<Address, bigint> }, mode: 'paper' | 'live' = 'paper',
  settings?: ResolvedExecutionSettings): PositionPlan {
  const legacyHalfWidth = Math.max(observation.state.tickSpacing * 2, Math.ceil((candidate.metrics.volatility?.realizedPct ?? 1) * 200));
  const legacyRangePct = Math.max(1, Math.min(99, (Math.pow(1.0001, legacyHalfWidth) - 1) * 100));
  const resolved = settings ?? { chainId: observation.state.pool.chainId, positionSizeUsd: budgetUsd,
    rangePct: legacyRangePct, takeProfitPct: 1_000_000_000,
    stopLossPct: -policy.stopLossPct, sizeMode: 'FIXED' as const, rangeMode: 'FIXED' as const };
  if (resolved.chainId !== observation.state.pool.chainId || resolved.positionSizeUsd !== budgetUsd) throw new Error('EXECUTION_SETTINGS_MISMATCH');
  if (!(resolved.takeProfitPct > 0) || !(resolved.stopLossPct < 0) || !(resolved.rangePct >= 1 && resolved.rangePct <= 99)) throw new Error('EXECUTION_SETTINGS_INVALID');
  // The candidate is the completed deterministic screening snapshot. Do not
  // re-screen that historical observation against a later wall-clock time;
  // executor-side verifyPool and transaction simulation remain mandatory.
  if (!candidate.approved || poolIdentity(candidate.pool) !== poolIdentity(observation.state.pool)) throw new Error('CANDIDATE_NOT_APPROVED');
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > policy.maximumPositionUsd) throw new Error('POSITION_LIMIT');
  const s = observation.state, chain = getChain(s.pool.chainId), id = s.pool.chainId;
  if (![portfolio.totalExposureUsd, portfolio.dailyLossUsd, portfolio.chainExposureUsd[id] ?? 0].every(n => Number.isFinite(n) && n >= 0)) throw new Error('INVALID_PORTFOLIO');
  if (portfolio.dailyLossUsd >= policy.maximumDailyLossUsd) throw new Error('DAILY_LOSS_LIMIT');
  if (portfolio.totalExposureUsd + budgetUsd > policy.maximumExposureUsd || (portfolio.chainExposureUsd[id] ?? 0) + budgetUsd > CHAIN_LIMITS[id].maximumExposureUsd) throw new Error('EXPOSURE_LIMIT');
  const snapshotNow = Math.max(observation.state.observedAt, observation.state.fetchedAt, observation.windowEnd, ...observation.prices.map(p => Math.max(p.observedAt, p.fetchedAt)));
  let tickLower: number, tickUpper: number;
  if (settings?.rangeMode === 'FIXED' && id === 4663) {
    const quote = quoteAssetForPool(s), stableIs0 = quote.isToken0, stableIs1 = !quote.isToken0;
    const meme = stableIs0 ? s.token1 : s.token0;
    const memePrice = canonicalPrice(observation.prices, meme.address, snapshotNow, policy)?.usd;
    const quotePrice = canonicalPrice(observation.prices, quote.address, snapshotNow, policy)?.usd;
    if (!(memePrice && quotePrice && memePrice > 0 && quotePrice > 0)) throw new Error('FIXED_RANGE_PRICE_UNAVAILABLE');
    const marketUsd = memePrice / quotePrice;
    const lowerUsd = marketUsd * (1 - resolved.rangePct / 100), upperUsd = marketUsd * 0.995;
    if (!(lowerUsd > 0 && lowerUsd < upperUsd)) throw new Error('FIXED_RANGE_INVALID');
    // Use the pool's raw token1/token0 price. USDG token1 requires a range
    // below current (token1-only); USDG token0 requires a range above current
    // (token0-only). Decimal normalization is applied to the raw tick price.
    const lowerTick = tickAtHumanQuotePrice({ quotePerMeme: lowerUsd, quoteIsToken0: stableIs0, decimals0: s.token0.decimals, decimals1: s.token1.decimals, tickSpacing: s.tickSpacing, round: stableIs0 ? 'up' : 'down' });
    const upperTick = tickAtHumanQuotePrice({ quotePerMeme: upperUsd, quoteIsToken0: stableIs0, decimals0: s.token0.decimals, decimals1: s.token1.decimals, tickSpacing: s.tickSpacing, round: stableIs0 ? 'up' : 'down' });
    ({ tickLower, tickUpper } = orderFixedRangeTicks(lowerTick, upperTick));
    if (stableIs0 && s.tick >= tickLower) { const shift = Math.floor((s.tick - tickLower) / s.tickSpacing) + 1; tickLower += shift * s.tickSpacing; tickUpper += shift * s.tickSpacing; }
    if (!stableIs0 && s.tick <= tickUpper) { const shift = Math.floor((tickUpper - s.tick) / s.tickSpacing) + 1; tickLower -= shift * s.tickSpacing; tickUpper -= shift * s.tickSpacing; }
    const stableOnly = stableIs0 ? s.tick < tickLower : s.tick > tickUpper;
    if (!stableOnly) throw new Error('FIXED_RANGE_NOT_SINGLE_SIDED_QUOTE');
  } else {
    const lowerWidth = settings ? Math.ceil(Math.abs(Math.log(1 - resolved.rangePct / 100) / Math.log(1.0001))) : legacyHalfWidth;
    const upperWidth = settings ? Math.ceil(Math.log(1 + resolved.rangePct / 100) / Math.log(1.0001)) : legacyHalfWidth;
    tickLower = Math.floor((s.tick - lowerWidth) / s.tickSpacing) * s.tickSpacing;
    tickUpper = Math.ceil((s.tick + upperWidth) / s.tickSpacing) * s.tickSpacing;
  }
  if (tickLower < -887272 || tickUpper > 887272 || tickUpper - tickLower > policy.maximumRangeWidthTicks || tickLower >= tickUpper) throw new Error('RANGE_LIMIT');
  const p0 = canonicalPrice(observation.prices, s.token0.address, snapshotNow, policy)!.usd;
  const p1 = canonicalPrice(observation.prices, s.token1.address, snapshotNow, policy)!.usd;
  const lower = sqrtAtTick(tickLower), upper = sqrtAtTick(tickUpper), basis = 10n ** 24n;
  const perBasis0 = amount0Delta(s.sqrtPriceX96, upper, basis), perBasis1 = amount1Delta(lower, s.sqrtPriceX96, basis);
  const value = tokenValue(perBasis0, s.token0.decimals, p0) + tokenValue(perBasis1, s.token1.decimals, p1);
  if (!(value > 0)) throw new Error('INVALID_RANGE_VALUATION');
  // USD is only a sizing estimate; all token arithmetic and transfer bounds remain integers.
  let liquidity = BigInt(Math.floor(budgetUsd / value * Number(basis)));
  if (liquidity <= 0n || liquidity >= 1n << 128n) throw new Error('INVALID_LIQUIDITY');
  const assets = () => [
    { token: s.token0.address, amount: amount0Delta(s.sqrtPriceX96, upper, liquidity) },
    { token: s.token1.address, amount: amount1Delta(lower, s.sqrtPriceX96, liquidity) },
  ];
  let depositAssets = assets();
  if (settings?.rangeMode === 'FIXED' && id === 4663) {
    const quote = quoteAssetForPool(s), stable = quote.address.toLowerCase(), stableIs0 = quote.isToken0;
    // Outside-range math is directional: mint only the quote asset and
    // explicitly zero the opposite side (no pre-mint swap).
    depositAssets = stableIs0
      ? [{ token: s.token0.address, amount: amount0Delta(s.sqrtPriceX96, upper, liquidity) }, { token: s.token1.address, amount: 0n }]
      : [{ token: s.token0.address, amount: 0n }, { token: s.token1.address, amount: amount1Delta(lower, s.sqrtPriceX96, liquidity) }];
    const stableAsset = depositAssets.find(a => a.token.toLowerCase() === stable);
    const otherAsset = depositAssets.find(a => a.token.toLowerCase() !== stable);
    if (!stableAsset || !otherAsset || otherAsset.amount !== 0n) throw new Error('FIXED_RANGE_NOT_QUOTE_ONLY');
  }
  let depositUsd = tokenValue(depositAssets[0]!.amount, s.token0.decimals, p0) + tokenValue(depositAssets[1]!.amount, s.token1.decimals, p1);
  if (depositUsd > budgetUsd) { liquidity = liquidity * 999999n / 1000000n; depositAssets = assets(); depositUsd = tokenValue(depositAssets[0]!.amount, s.token0.decimals, p0) + tokenValue(depositAssets[1]!.amount, s.token1.decimals, p1); }
  if (depositAssets.some(a => a.amount < 0n) || depositAssets.every(a => a.amount === 0n) || depositUsd <= 0 || depositUsd > budgetUsd) throw new Error('DUST_OR_OVER_BUDGET');
  if (wallet) {
    if (mode === 'paper' || mode === 'live') for (const a of depositAssets) if ((wallet.tokens.get(a.token) ?? 0n) < a.amount) {
      const quote = quoteAssetForPool(s);
      if (a.token.toLowerCase() === quote.address.toLowerCase()) {
        const token = quote.isToken0 ? s.token0 : s.token1;
        const available = wallet.tokens.get(a.token) ?? 0n;
        const human = (raw: bigint) => Number(raw) / 10 ** token.decimals;
        throw new InsufficientQuoteBalanceError({ quoteAddress: token.address, quoteSymbol: token.symbol, quoteDecimals: token.decimals,
          requiredRaw: a.amount, availableRaw: available, requiredHuman: human(a.amount).toPrecision(8), availableHuman: human(available).toPrecision(8), requiredUsd: depositUsd });
      }
      throw new Error('INSUFFICIENT_BALANCE');
    }
    const sharedSpend = id === 5042 ? arcErc20ToNative(erc20Usdc(depositAssets.find(a => a.token === chain.primaryStable)?.amount ?? 0n)) : 0n;
    if (wallet.native - sharedSpend < chain.minimumGasReserve) throw new Error('GAS_RESERVE');
  }
  return { chainId: id, pool: s.pool, mode, createdAt: now, deadline: now + 120, sourceBlock: s.blockNumber, sourceBlockHash: s.blockHash,
    tickLower, tickUpper, liquidity, poolFee: s.fee, depositAssets, expectedTransfers: depositAssets.map(a => ({ token: a.token, direction: 'out', maximumAmount: a.amount })),
    slippageBps: policy.maximumSlippageBps, maximumGasCostUsd: observation.estimatedLifecycleCostUsd!, depositUsd,
    positionSizeUsd: resolved.positionSizeUsd, rangePct: resolved.rangePct, takeProfitPct: resolved.takeProfitPct,
    stopLossPct: resolved.stopLossPct, sizeMode: resolved.sizeMode, rangeMode: resolved.rangeMode };
}
export function assertPlanIdentity(plan: PositionPlan, observation: Observation) {
  if (plan.chainId !== observation.state.pool.chainId || poolIdentity(plan.pool) !== poolIdentity(observation.state.pool)) throw new Error('PLAN_POOL_MISMATCH');
}
