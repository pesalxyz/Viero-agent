import { poolIdentity, tokenIdentity, type Observation } from '../domain.js';
import { getChain } from '../config/chains.js';
import { type Policy } from '../config/policy.js';
import { type Candidate } from '../screening/pipeline.js';
import { type StrategyState } from './liveState.js';

export function historicalRejections(candidate: Candidate, observation: Observation, state: StrategyState, policy: Policy, now: number) {
  const identity = poolIdentity(candidate.pool), codes: Array<{ code: string; detail: string }> = [];
  const open = state.positions.filter(position => position.status === 'open');
  if (open.length >= policy.maximumOpenPositions) codes.push({ code: 'POSITION_CAPACITY', detail: 'Maximum open position count reached' });
  if (open.some(position => poolIdentity(position.pool) === identity)) codes.push({ code: 'DUPLICATE_EXPOSURE', detail: 'Pool already has an open position' });
  const tokens = [observation.state.token0.address, observation.state.token1.address];
  const chain = getChain(candidate.pool.chainId);
  const trusted = new Set([chain.primaryStable, chain.wrappedNative].filter(Boolean).map((address) => address!.toLowerCase()));
  const candidateBaseTokens = tokens.filter(token => !trusted.has(token.toLowerCase()));
  const existingBaseTokens = open.flatMap(position => position.plan.depositAssets
    .filter(asset => !trusted.has(asset.token.toLowerCase()))
    .map(asset => asset.token.toLowerCase()));
  if (candidateBaseTokens.some(token => existingBaseTokens.includes(token.toLowerCase()))) codes.push({ code: 'DUPLICATE_TOKEN_EXPOSURE', detail: 'An open position already uses the candidate token' });
  if ((state.cooldowns[identity] ?? 0) > now) codes.push({ code: 'POOL_COOLDOWN', detail: `Pool cooldown active until ${state.cooldowns[identity]}` });
  for (const token of tokens) {
    // LP-management outcomes belong to the candidate/base asset. Trusted
    // infrastructure quote assets must never block unrelated pools.
    if (trusted.has(token.toLowerCase())) continue;
    const key = tokenIdentity(candidate.pool.chainId, token), blocked = state.blacklist[key];
    if (blocked && blocked.until > now) codes.push({ code: 'TOKEN_BLACKLISTED', detail: `${token}: ${blocked.reason}` });
  }
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  if ((state.dailyRealizedLossUsd[day] ?? 0) >= policy.maximumDailyLossUsd) codes.push({ code: 'DAILY_LOSS_LIMIT', detail: 'Daily realized loss limit reached' });
  return codes;
}

export function recordClosedOutcome(state: StrategyState, observation: Observation, positionId: string, reason: string, now: number, policy: Policy, pnlUsd: number | null) {
  const position = state.positions.find(item => item.id === positionId);
  if (!position) throw new Error('POSITION_NOT_FOUND');
  const identity = poolIdentity(position.pool), riskExit = /HONEYPOT|ADMIN|SELL|RISK|DEPTH|PRICE/i.test(reason), loss = pnlUsd !== null && pnlUsd < 0;
  const closeBasisUsd = position.entryPrincipalUsd ?? position.plan.depositUsd;
  const realizedPnlPct = pnlUsd !== null && closeBasisUsd > 0 ? pnlUsd / closeBasisUsd * 100 : null;
  const farAboveGrace = reason === 'FAR_ABOVE_RANGE' && realizedPnlPct !== null && realizedPnlPct >= policy.farAboveRangeBlacklistGracePct;
  state.cooldowns[identity] = now + policy.poolCooldownSeconds;
  if (riskExit || (loss && !farAboveGrace)) {
    const chain = getChain(position.chainId);
    const trusted = new Set([chain.primaryStable, chain.wrappedNative].filter(Boolean).map((address) => address!.toLowerCase()));
    // Deposit assets are normally quote-only, so derive the candidate/base
    // asset from the persisted pool identity and exclude trusted quotes.
    const poolTokens = [observation.state.token0.address, observation.state.token1.address];
    const deposited = new Set(position.plan.depositAssets.map(asset => asset.token.toLowerCase()));
    const candidateTokens = poolTokens.filter(token => !deposited.has(token.toLowerCase()));
    // Legacy positions may not have a complete deposit snapshot; retain the
    // safe fallback of excluding configured infrastructure and recording the
    // remaining pool asset(s).
    const tokensToBlacklist = candidateTokens.length ? candidateTokens : poolTokens;
    for (const token of tokensToBlacklist) {
      if (trusted.has(token.toLowerCase())) continue;
      state.blacklist[tokenIdentity(position.chainId, token)] = { until: now + policy.lossBlacklistSeconds, reason };
    }
  }
  if (loss) {
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    state.dailyRealizedLossUsd[day] = (state.dailyRealizedLossUsd[day] ?? 0) + Math.abs(pnlUsd!);
  }
  state.lessons.push({ at: now, chainId: position.chainId, poolIdentity: identity, outcome: riskExit ? 'risk-exit' : loss ? 'loss' : 'win', pnlUsd, reason });
  state.lessons = state.lessons.slice(-1000);
}
