import { TickMath } from '@pancakeswap/v3-sdk';
import { formatUnits } from 'viem';
import { type InitializedTick, type PoolState, type Swap } from '../domain.js';

export const Q96 = 1n << 96n;
const PRICE_SCALE = 10n ** 18n;
export function sqrtAtTick(tick: number) { return BigInt(TickMath.getSqrtRatioAtTick(tick).toString()); }
export function amount0Delta(a: bigint, b: bigint, liquidity: bigint): bigint {
  const [lower, upper] = a < b ? [a, b] : [b, a];
  if (lower <= 0n || liquidity < 0n) throw new Error('Invalid liquidity math input');
  return liquidity * (upper - lower) * Q96 / upper / lower;
}
export function amount1Delta(a: bigint, b: bigint, liquidity: bigint): bigint {
  if (liquidity < 0n) throw new Error('Invalid liquidity');
  return liquidity * (a > b ? a - b : b - a) / Q96;
}
export function tokenValue(amount: bigint, decimals: number, priceUsd: number) {
  const value = Number(formatUnits(amount, decimals)) * priceUsd;
  if (!Number.isFinite(value)) throw new Error('Non-finite token valuation');
  return value;
}
export function spotPrice(state: Pick<PoolState, 'sqrtPriceX96' | 'token0' | 'token1'>) {
  const squared = state.sqrtPriceX96 * state.sqrtPriceX96;
  const rawScale = 10n ** BigInt(state.token0.decimals - state.token1.decimals >= 0 ? state.token0.decimals - state.token1.decimals : 0);
  const raw = Number(squared) / Number(Q96 * Q96);
  return state.token0.decimals >= state.token1.decimals
    ? raw * Number(rawScale)
    : raw / 10 ** (state.token1.decimals - state.token0.decimals);
}
function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Negative square root');
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
function tickAtSqrt(sqrtPriceX96: bigint) {
  let low = -887272, high = 887272;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sqrtAtTick(mid) <= sqrtPriceX96) low = mid; else high = mid - 1;
  }
  return low;
}
function integerSqrtRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n || denominator <= 0n) throw new Error('Invalid price ratio');
  return integerSqrt(numerator * Q96 * Q96 / denominator);
}

/** Convert human USDG-per-meme price to a raw token1/token0 tick without Number(sqrtPriceX96). */
export function tickAtHumanQuotePrice(params: {
  quotePerMeme: number;
  quoteIsToken0: boolean;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  round: 'up' | 'down';
}): number {
  const { quotePerMeme, quoteIsToken0, decimals0, decimals1, tickSpacing, round } = params;
  if (!Number.isFinite(quotePerMeme) || quotePerMeme <= 0) throw new Error('Invalid human quote price');
  const scaled = BigInt(Math.max(1, Math.round(quotePerMeme * 1e18)));
  // raw price is token1 units per token0 unit.
  let numerator = scaled * 10n ** BigInt(decimals1);
  let denominator = PRICE_SCALE * 10n ** BigInt(decimals0);
  if (quoteIsToken0) [numerator, denominator] = [PRICE_SCALE * 10n ** BigInt(decimals1), scaled * 10n ** BigInt(decimals0)];
  const sqrt = integerSqrtRatio(numerator, denominator);
  const tick = tickAtSqrt(sqrt);
  return round === 'up' ? Math.ceil(tick / tickSpacing) * tickSpacing : Math.floor(tick / tickSpacing) * tickSpacing;
}
export function humanQuotePriceFromSqrt(params: { sqrtPriceX96: bigint; quoteIsToken0: boolean; decimals0: number; decimals1: number }): number {
  const rawNumerator = params.sqrtPriceX96 * params.sqrtPriceX96;
  const rawDenominator = Q96 * Q96;
  const raw = Number(rawNumerator) / Number(rawDenominator);
  const token1PerToken0 = raw * 10 ** (params.decimals0 - params.decimals1);
  const quotePerMeme = params.quoteIsToken0 ? 1 / token1PerToken0 : token1PerToken0;
  if (!Number.isFinite(quotePerMeme) || quotePerMeme <= 0) throw new Error('Invalid sqrt price');
  return quotePerMeme;
}
export function onePercentDepthRange(state: Pick<PoolState, 'sqrtPriceX96' | 'tick'>) {
  const down = integerSqrt(state.sqrtPriceX96 ** 2n * 99n / 100n);
  const up = integerSqrt(state.sqrtPriceX96 ** 2n * 101n / 100n);
  return { down, up, lowerTick: tickAtSqrt(down), upperTick: tickAtSqrt(up) + 1 };
}
export function depth1Pct(state: PoolState, ticks: InitializedTick[], prices: [number, number]) {
  const targets = onePercentDepthRange(state);
  const calculate = (down: boolean) => {
    const target = down ? targets.down : targets.up;
    if (target <= BigInt(TickMath.MIN_SQRT_RATIO.toString()) || target >= BigInt(TickMath.MAX_SQRT_RATIO.toString())) return null;
    let current = state.sqrtPriceX96, liquidity = state.liquidity, amount = 0n;
    const boundaries = ticks.filter(t => down ? t.index <= state.tick : t.index > state.tick).sort((a, b) => down ? b.index - a.index : a.index - b.index);
    for (const boundary of boundaries) {
      const sqrt = sqrtAtTick(boundary.index);
      if (down ? sqrt < target : sqrt > target) break;
      if (liquidity <= 0n) return null;
      amount += down ? amount0Delta(sqrt, current, liquidity) : amount1Delta(current, sqrt, liquidity);
      liquidity += down ? -boundary.liquidityNet : boundary.liquidityNet;
      current = sqrt;
    }
    if (liquidity <= 0n) return null;
    amount += down ? amount0Delta(target, current, liquidity) : amount1Delta(current, target, liquidity);
    return tokenValue(amount, down ? state.token0.decimals : state.token1.decimals, prices[down ? 0 : 1]);
  };
  return { down: calculate(true), up: calculate(false) };
}
export function candles(swaps: Swap[]) {
  const byMinute = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number; volumeUsd: number }>();
  const ordered = [...swaps].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  for (const s of ordered) {
    const minute = Math.floor(s.timestamp / 60) * 60, p = s.price1Per0;
    const candle = byMinute.get(minute) ?? { timestamp: minute, open: p, high: p, low: p, close: p, volumeUsd: 0 };
    candle.high = Math.max(candle.high, p); candle.low = Math.min(candle.low, p); candle.close = p; candle.volumeUsd += s.volumeUsd;
    byMinute.set(minute, candle);
  }
  return [...byMinute.values()].sort((a, b) => a.timestamp - b.timestamp);
}
export function volatility(swaps: Swap[]) {
  const rows = candles(swaps);
  if (rows.length < 2) return null;
  let squared = 0;
  for (let i = 1; i < rows.length; i++) squared += Math.log(rows[i]!.close / rows[i - 1]!.close) ** 2;
  const open = rows[0]!.open, close = rows.at(-1)!.close;
  return { realizedPct: Math.sqrt(squared) * 100, changePct: (close / open - 1) * 100,
    rangePct: (Math.max(...rows.map(r => r.high)) - Math.min(...rows.map(r => r.low))) / open * 100 };
}
const UINT256 = 1n << 256n;
export function feeGrowthDelta(current: bigint, previous: bigint): bigint { return (current - previous + UINT256) % UINT256; }
export function liveFees(liquidity: bigint, inside: bigint, insideLast: bigint, tokensOwed: bigint): bigint {
  return tokensOwed + liquidity * feeGrowthDelta(inside, insideLast) / (1n << 128n);
}
export function feeGrowthInside(currentTick: number, lowerTick: number, upperTick: number, global: bigint, lowerOutside: bigint, upperOutside: bigint): bigint {
  const below = currentTick >= lowerTick ? lowerOutside : feeGrowthDelta(global, lowerOutside);
  const above = currentTick < upperTick ? upperOutside : feeGrowthDelta(global, upperOutside);
  return (global - below - above + 2n * UINT256) % UINT256;
}
