import { type Policy } from '../config/policy.js';
import { getChain } from '../config/chains.js';
import { type Observation } from '../domain.js';
import { canonicalPrice } from '../screening/pipeline.js';
import { type LivePosition } from '../execution/liveState.js';
import { amount0Delta, amount1Delta, sqrtAtTick, tokenValue, humanQuotePriceFromSqrt } from '../screening/math.js';
import { effectivePnlDepositUsd, pnlPctFromValues } from './pnl.js';

export type LiveManagementDecision = {
  action: 'hold' | 'claim' | 'rebalance' | 'close' | 'emergency-close' | 'pause';
  reason: string;
};

export function normalizeHumanRange(boundaryA: number, boundaryB: number): { lower: number; upper: number } {
  return { lower: Math.min(boundaryA, boundaryB), upper: Math.max(boundaryA, boundaryB) };
}

/**
 * Calculate the current principal without requiring a price for a zero-sized
 * side of an out-of-range position.  This is intentionally separate from
 * fee-inclusive management PnL: FAR_ABOVE_RANGE is a range rule and still
 * needs a truthful principal-only close value when fee evidence is missing.
 */
export function managementPrincipalValue(
  position: LivePosition,
  observation: Observation,
  policy: Policy,
  now: number,
): { amount0: bigint; amount1: bigint; valueUsd: number; depositUsd: number | null } | null {
  const state = observation.state;
  const price0 = canonicalPrice(observation.prices, state.token0.address, now, policy);
  const price1 = canonicalPrice(observation.prices, state.token1.address, now, policy);
  const lower = sqrtAtTick(position.plan.tickLower), upper = sqrtAtTick(position.plan.tickUpper);
  const current = state.sqrtPriceX96 < lower ? lower : state.sqrtPriceX96 > upper ? upper : state.sqrtPriceX96;
  // V3 fee accounting already reads positions(tokenId), which returns the
  // actual minted NFT liquidity. Reuse it when present; the planned liquidity
  // is only a compatibility fallback for older/synthetic observations.
  const liquidity = observation.positionLiquidity ?? position.plan.liquidity;
  const amount0 = amount0Delta(current, upper, liquidity);
  const amount1 = amount1Delta(lower, current, liquidity);
  if ((amount0 > 0n && !price0) || (amount1 > 0n && !price1)) return null;
  const valueUsd = tokenValue(amount0, state.token0.decimals, price0?.usd ?? 0)
    + tokenValue(amount1, state.token1.decimals, price1?.usd ?? 0);
  if (!Number.isFinite(valueUsd)) return null;
  const depositUsd = effectivePnlDepositUsd({
    persistedDepositUsd: position.plan.depositUsd,
    entryPrincipalUsd: position.entryPrincipalUsd,
    principalValueUsd: valueUsd,
    token0Address: state.token0.address,
    token1Address: state.token1.address,
    amount0,
    amount1,
    primaryStable: getChain(position.chainId).primaryStable,
  });
  return { amount0, amount1, valueUsd, depositUsd };
}

/** Principal-only PnL fallback for range exits when fee evidence is absent. */
export function managementPrincipalPnlPct(position: LivePosition, observation: Observation, policy: Policy, now: number): number | null {
  const principal = managementPrincipalValue(position, observation, policy, now);
  return principal ? pnlPctFromValues(principal.valueUsd, principal.depositUsd) : null;
}

/** Canonical fee-inclusive management PnL, expressed in percentage points. */
export function managementPnlPct(position: LivePosition, observation: Observation, policy: Policy, now: number): number | null {
  const state = observation.state;
  const price0 = canonicalPrice(observation.prices, state.token0.address, now, policy);
  const price1 = canonicalPrice(observation.prices, state.token1.address, now, policy);
  const feeEvidence = position.pool.protocol !== 'v4' || (observation as Observation & { feeEvidence?: boolean }).feeEvidence === true;
  const unclaimedFeesUsd = (observation as Observation & { feeUsd?: number | null }).feeUsd ?? null;
  if (!price0 || !price1 || !(position.plan.depositUsd > 0) || !feeEvidence || (position.pool.protocol === 'v4' && unclaimedFeesUsd === null)) return null;
  const principal = managementPrincipalValue(position, observation, policy, now);
  if (!principal) return null;
  return pnlPctFromValues(principal.valueUsd + (unclaimedFeesUsd ?? 0), principal.depositUsd);
}

export function liveManagementDecision(
  position: LivePosition,
  observation: Observation,
  policy: Policy,
  now: number,
): LiveManagementDecision {
  const state = observation.state;
  // Management has its own evidence contract. Candidate screening is
  // intentionally not used here: missing PnL/price evidence skips only the
  // rules that need it, while fresh tick/range evidence can still evaluate OOR.
  if (!state.verified || observation.state.pool.chainId !== position.chainId) {
    return { action: 'pause', reason: 'Management pool identity unavailable' };
  }
  // Preserve direct safety exits from already-attached risk evidence without
  // invoking the candidate screening pipeline.
  const risk = observation.risks.find(r => r.token.toLowerCase() !== state.token0.address.toLowerCase() && r.token.toLowerCase() !== state.token1.address.toLowerCase())
    ?? observation.risks[0];
  if (risk?.honeypot === true) return { action: 'emergency-close', reason: 'HONEYPOT' };
  if (risk?.criticalAdmin === true) return { action: 'emergency-close', reason: 'CRITICAL_ADMIN' };
  if (risk?.sellSimulation === false) return { action: 'emergency-close', reason: 'SELL_SIMULATION_FAILED' };
  const pnlPct = managementPnlPct(position, observation, policy, now);
  if (pnlPct != null) {
      const computedPnlPct = pnlPct;
      if (computedPnlPct <= position.plan.stopLossPct) return { action: 'close', reason: 'STOP_LOSS' };
      if (computedPnlPct >= position.plan.takeProfitPct) return { action: 'close', reason: 'TAKE_PROFIT' };
      const peak = Math.max(position.peakPnlPct ?? computedPnlPct, computedPnlPct);
      position.peakPnlPct = peak;
      if (policy.trailingTakeProfitEnabled && peak >= policy.trailingTriggerPct) position.trailingTakeProfitArmed = true;
      if (position.trailingTakeProfitArmed && peak - computedPnlPct >= policy.trailingDropPct) return { action: 'close', reason: 'TRAILING_TAKE_PROFIT' };
  }

  const inRange = observation.state.tick >= position.plan.tickLower && observation.state.tick < position.plan.tickUpper;
  if (policy.farAboveRangeEnabled) {
    const quoteIs0 = state.token0.address.toLowerCase() === getChain(state.pool.chainId).primaryStable.toLowerCase() || state.token0.address.toLowerCase() === getChain(state.pool.chainId).wrappedNative?.toLowerCase();
    const currentPrice = humanQuotePriceFromSqrt({ sqrtPriceX96: state.sqrtPriceX96, quoteIsToken0: quoteIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals });
    const boundaryA = humanQuotePriceFromSqrt({ sqrtPriceX96: sqrtAtTick(position.plan.tickLower), quoteIsToken0: quoteIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals });
    const boundaryB = humanQuotePriceFromSqrt({ sqrtPriceX96: sqrtAtTick(position.plan.tickUpper), quoteIsToken0: quoteIs0, decimals0: state.token0.decimals, decimals1: state.token1.decimals });
    // Tick ordering is protocol ordering, not necessarily human
    // quote-per-base ordering. Normalize both boundaries before applying the
    // far-above rule so token0/token1 orientation cannot invert it.
    const humanRangeUpper = normalizeHumanRange(boundaryA, boundaryB).upper;
    if (currentPrice >= humanRangeUpper * (1 + policy.farAboveRangePct / 100)) return { action: 'close', reason: 'FAR_ABOVE_RANGE' };
  }
  if (policy.outOfRangeTimeoutEnabled && !inRange && position.outOfRangeSince !== null && now - position.outOfRangeSince >= policy.outOfRangeTimeoutSeconds) return { action: 'close', reason: 'OUT_OF_RANGE_TIMEOUT' };
  return { action: 'hold', reason: inRange ? (pnlPct === null ? 'PnL unavailable; position remains in range' : 'Range and PnL remain acceptable') : (pnlPct === null ? 'PnL unavailable; out-of-range timeout not reached' : 'Out of range timeout not reached') };
}
