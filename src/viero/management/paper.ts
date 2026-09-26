import { type Observation, poolIdentity, type ChainId } from '../domain.js';
import { type Policy } from '../config/policy.js';
import { amount0Delta, amount1Delta, sqrtAtTick, tokenValue } from '../screening/math.js';
import { canonicalPrice, screen } from '../screening/pipeline.js';
import { assertPlanIdentity, type PositionPlan } from '../execution/planner.js';

export type ManagementAction = 'hold' | 'claim' | 'rebalance' | 'close' | 'emergency-close' | 'pause';
export type PaperPosition = {
  id: string; chainId: ChainId; plan: PositionPlan; openedAt: number; status: 'open' | 'closed';
  initialValueUsd: number; currentValueUsd: number; claimedFeesUsd: number; unclaimedFeesUsd: number;
  gasCostUsd: number; swapCostUsd: number; bridgeCostUsd: number; holdValueUsd: number;
  peakValueUsd: number; outOfRangeSince: number | null; lastWindowEnd: number;
  netPnlUsd: number; impermanentLossUsd: number;
  events: Array<{ at: number; action: ManagementAction | 'open'; reason: string; netPnlUsd: number }>;
};
export function openPaperPosition(plan: PositionPlan, now: number): PaperPosition {
  if (plan.mode !== 'paper' || now > plan.deadline) throw new Error('INVALID_PAPER_PLAN');
  return { id: `${poolIdentity(plan.pool)}:paper:${now}`, chainId: plan.chainId, plan, openedAt: now, status: 'open',
    initialValueUsd: plan.depositUsd, currentValueUsd: plan.depositUsd, claimedFeesUsd: 0, unclaimedFeesUsd: 0,
    gasCostUsd: plan.maximumGasCostUsd / 2, swapCostUsd: 0, bridgeCostUsd: 0, holdValueUsd: plan.depositUsd,
    peakValueUsd: plan.depositUsd, outOfRangeSince: null, lastWindowEnd: now,
    netPnlUsd: -plan.maximumGasCostUsd / 2, impermanentLossUsd: 0,
    events: [{ at: now, action: 'open', reason: 'Paper position; no transaction submitted', netPnlUsd: -plan.maximumGasCostUsd / 2 }] };
}
export function accounting(position: Pick<PaperPosition, 'currentValueUsd' | 'claimedFeesUsd' | 'unclaimedFeesUsd' | 'initialValueUsd' | 'gasCostUsd' | 'swapCostUsd' | 'bridgeCostUsd' | 'holdValueUsd'>) {
  return {
    netPnlUsd: position.currentValueUsd + position.unclaimedFeesUsd + position.claimedFeesUsd - position.initialValueUsd - position.gasCostUsd - position.swapCostUsd - position.bridgeCostUsd,
    impermanentLossUsd: position.currentValueUsd - position.holdValueUsd,
  };
}
export function managementRule(position: PaperPosition, observation: Observation, policy: Policy, now: number): { action: ManagementAction; reason: string } {
  const candidate = screen(observation, policy, now);
  const emergency = new Set(['HONEYPOT', 'CRITICAL_ADMIN', 'UNKNOWN_HOOK', 'PRICE_DIVERGENCE', 'POOL_UNVERIFIED', 'POOL_ID_MISMATCH', 'POOL_KEY_MISMATCH', 'DEPTH_TOO_LOW']);
  const danger = candidate.rejections.find(r => emergency.has(r.code));
  if (danger) return { action: 'emergency-close', reason: danger.code };
  if (observation.risks.some(r => r.sellSimulation === false)) return { action: 'emergency-close', reason: 'SELL_SIMULATION_FAILED' };
  if (candidate.rejections.some(r => ['RISK_UNAVAILABLE', 'PRICE_UNAVAILABLE', 'STALE_STATE', 'INCOMPLETE_WINDOW', 'INDEXER_LAG', 'SIMULATION_REQUIRED'].includes(r.code))) return { action: 'pause', reason: 'Fresh complete evidence is required for management' };
  const pnlPct = position.netPnlUsd / position.initialValueUsd * 100;
  if (pnlPct <= position.plan.stopLossPct) return { action: 'close', reason: 'STOP_LOSS' };
  if (pnlPct >= position.plan.takeProfitPct) return { action: 'close', reason: 'TAKE_PROFIT' };
  const equity = position.currentValueUsd + position.unclaimedFeesUsd + position.claimedFeesUsd;
  if (position.peakValueUsd > position.initialValueUsd && equity < position.peakValueUsd * (1 - policy.trailingDrawdownPct / 100)) return { action: 'close', reason: 'TRAILING_PROFIT' };
  if (position.outOfRangeSince !== null && now - position.outOfRangeSince >= policy.outOfRangeGraceSeconds) return { action: 'rebalance', reason: 'OUT_OF_RANGE_GRACE_EXPIRED' };
  if (now - position.openedAt >= policy.windowMinutes * 60 && candidate.rejections.some(r => ['NET_YIELD_TOO_LOW', 'VOLUME_TOO_LOW', 'TRADERS_TOO_FEW'].includes(r.code))) return { action: 'close', reason: 'ECONOMICS_DETERIORATED' };
  const claimGas = (observation.estimatedLifecycleCostUsd ?? Infinity) / 4;
  if (position.unclaimedFeesUsd >= policy.minimumClaimUsd && position.unclaimedFeesUsd >= claimGas * policy.claimCostMultiplier) return { action: 'claim', reason: 'ECONOMIC_CLAIM' };
  return { action: 'hold', reason: 'Range, risk and economics remain acceptable' };
}
export function markPaperPosition(input: PaperPosition, observation: Observation, policy: Policy, now: number): PaperPosition {
  assertPlanIdentity(input.plan, observation);
  if (input.status === 'closed') return input;
  if (now < input.openedAt || observation.windowEnd < input.lastWindowEnd) throw new Error('NON_MONOTONIC_REPLAY');
  const position = structuredClone(input), s = observation.state, plan = position.plan;
  const p0 = canonicalPrice(observation.prices, s.token0.address, now, policy), p1 = canonicalPrice(observation.prices, s.token1.address, now, policy);
  if (!p0 || !p1 || now - s.observedAt > policy.maximumDataAgeSeconds) {
    position.events.push({ at: now, action: 'pause', reason: 'Cannot mark with stale or missing prices', netPnlUsd: position.netPnlUsd });
    return position;
  }
  const lo = sqrtAtTick(plan.tickLower), hi = sqrtAtTick(plan.tickUpper);
  const current = s.sqrtPriceX96 < lo ? lo : s.sqrtPriceX96 > hi ? hi : s.sqrtPriceX96;
  const amount0 = amount0Delta(current, hi, plan.liquidity), amount1 = amount1Delta(lo, current, plan.liquidity);
  position.currentValueUsd = tokenValue(amount0, s.token0.decimals, p0.usd) + tokenValue(amount1, s.token1.decimals, p1.usd);
  position.holdValueUsd = tokenValue(plan.depositAssets[0]!.amount, s.token0.decimals, p0.usd) + tokenValue(plan.depositAssets[1]!.amount, s.token1.decimals, p1.usd);
  // Paper fee attribution is a full-range TVL-share estimate, not a historical tick-liquidity backtest.
  // Only new swaps are accrued; overlapping monitoring windows cannot collect the same fees twice.
  const eligible = observation.complete && observation.windowStart <= position.lastWindowEnd;
  if (eligible && observation.tvlUsd) {
    for (const swap of observation.swaps) {
      if (swap.timestamp <= position.lastWindowEnd || swap.timestamp > now || swap.lpFeeUsd === null) continue;
      const lowerPrice = Math.pow(1.0001, plan.tickLower) * 10 ** (s.token0.decimals - s.token1.decimals);
      const upperPrice = Math.pow(1.0001, plan.tickUpper) * 10 ** (s.token0.decimals - s.token1.decimals);
      if (swap.price1Per0 >= lowerPrice && swap.price1Per0 < upperPrice) position.unclaimedFeesUsd += swap.lpFeeUsd * position.initialValueUsd / observation.tvlUsd;
    }
  }
  const inRange = s.tick >= plan.tickLower && s.tick < plan.tickUpper;
  position.outOfRangeSince = inRange ? null : position.outOfRangeSince ?? now;
  position.lastWindowEnd = observation.windowEnd;
  Object.assign(position, accounting(position));
  position.peakValueUsd = Math.max(position.peakValueUsd, position.currentValueUsd + position.unclaimedFeesUsd + position.claimedFeesUsd);
  const decision = eligible ? managementRule(position, observation, policy, now) : { action: 'pause' as const, reason: 'Gap in replay observations; fee accrual incomplete' };
  if (decision.action === 'claim') {
    position.claimedFeesUsd += position.unclaimedFeesUsd; position.unclaimedFeesUsd = 0;
    position.gasCostUsd += (observation.estimatedLifecycleCostUsd ?? 0) / 4;
  } else if (['close', 'emergency-close', 'rebalance'].includes(decision.action)) {
    // A rebalance closes this paper position. A new entry must pass the screener again.
    position.status = 'closed'; position.claimedFeesUsd += position.unclaimedFeesUsd; position.unclaimedFeesUsd = 0;
    position.gasCostUsd += plan.maximumGasCostUsd / 2;
  }
  Object.assign(position, accounting(position));
  position.events.push({ at: now, ...decision, netPnlUsd: position.netPnlUsd });
  return position;
}
