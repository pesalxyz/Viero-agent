import test from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { CHAIN_IDS, CHAINS, getChain, sourceSlug } from '../src/viero/config/chains.js';
import { CHAIN_LIMITS, DEFAULT_POLICY as policy, usesRobinhoodExecutionRules, usesSingleSidedQuoteExecution } from '../src/viero/config/policy.js';
import { poolIdentity, poolId, poolSchema, sanitizeMetadata } from '../src/viero/domain.js';
import { demoObservations, DEMO_TIME as now } from '../src/viero/fixtures/demo.js';
import { canonicalPrice, screen, rank, spotPriceDeviationPct } from '../src/viero/screening/pipeline.js';
import { depth1Pct, volatility, liveFees, feeGrowthInside, onePercentDepthRange, Q96 } from '../src/viero/screening/math.js';
import { directionalProtocolFee, lpFeePips } from '../src/viero/indexer/fees.js';
import { arcBalance, arcNativeToErc20, arcErc20ToNative, nativeUsdc, erc20Usdc } from '../src/viero/domain/arc.js';
import { planPosition } from '../src/viero/execution/planner.js';
import { ChainSupervisor, executeTransaction } from '../src/viero/execution/guard.js';
import { selectCandidate, assertRoleTool } from '../src/viero/agent/runtime.js';
import { openPaperPosition, markPaperPosition, accounting } from '../src/viero/management/paper.js';

const fixture = () => demoObservations()[0]!;
const portfolio = { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 };
const codes = (o: ReturnType<typeof fixture>) => screen(o, policy, now).rejections.map(r => r.code);
test('Robinhood depth policy uses the reduced production thresholds', () => {
  assert.equal(CHAIN_LIMITS[4663].minimumDepthDownUsd, 50);
  assert.equal(CHAIN_LIMITS[4663].minimumDepthUpUsd, 50);
  assert.equal(CHAIN_LIMITS[4663].minimumDepthUsd, 100);
});
test('BNB candidate execution uses the Robinhood execution gates', () => {
  assert.deepEqual(CHAIN_LIMITS[56], CHAIN_LIMITS[4663]);
  assert.equal(usesRobinhoodExecutionRules(4663), true);
  assert.equal(usesRobinhoodExecutionRules(56), true);
  assert.equal(usesRobinhoodExecutionRules(8453), false);
  assert.equal(usesRobinhoodExecutionRules(5042), false);
  assert.equal(usesSingleSidedQuoteExecution(4663), true);
  assert.equal(usesSingleSidedQuoteExecution(56), true);
  assert.equal(usesSingleSidedQuoteExecution(8453), false);
  assert.equal(usesSingleSidedQuoteExecution(5042), false);
});
test('spot divergence uses asymmetric signed boundaries', () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9);
  close(spotPriceDeviationPct(1.025, 1), 2.5);
  close(spotPriceDeviationPct(1.0251, 1), 2.51);
  close(spotPriceDeviationPct(0.9, 1), -10);
  close(spotPriceDeviationPct(0.8999, 1), -10.01);
  assert.equal(policy.maximumPositivePriceDivergencePct, 2.5);
  assert.equal(policy.maximumNegativePriceDivergencePct, 10);
});
test('all four chains have explicit mappings and venue-specific deployments', () => {
  for (const id of CHAIN_IDS) {
    assert.equal(getChain(id).id, id);
    for (const source of ['gmgn', 'gecko', 'dexScreener'] as const) assert.ok(sourceSlug(id, source));
  }
  assert.throws(() => getChain(1));
  assert.notEqual(CHAINS[56].v3.uniswap!.factory, CHAINS[56].v3.pancakeswap!.factory);
  assert.ok(CHAINS[56].v3.pancakeswap!.feeTiers.includes(2500));
  assert.equal(CHAINS[5042].wrappedNative, undefined);
});
test('nine protocol/venue combinations replay without cross-chain identities', () => {
  const observations = demoObservations();
  assert.equal(observations.length, 9);
  assert.equal(new Set(observations.map(o => poolIdentity(o.state.pool))).size, 9);
  for (const o of observations) assert.deepEqual(screen(o, policy, now).rejections, []);
  const ranked = rank(observations.map(o => screen(o, policy, now)));
  assert.ok(ranked.every(c => c.globalScore !== null));
  assert.ok(ranked[0]!.globalScore! >= ranked.at(-1)!.globalScore!);
});
test('v4 uses a PoolId without requiring a pool address', () => {
  const p = demoObservations()[1]!.state.pool;
  assert.equal(p.protocol, 'v4');
  if (p.protocol !== 'v4') throw new Error('fixture');
  assert.equal(poolId(p.poolKey), p.poolId);
  assert.equal('poolAddress' in p, false);
  assert.throws(() => poolSchema.parse({ ...p, dex: 'pancakeswap' }));
});
test('Arc converts explicitly and never sums balance interfaces', () => {
  const balance = nativeUsdc(5n * 10n ** 18n + 99n);
  const erc = arcNativeToErc20(balance);
  assert.equal(erc, 5_000_000n);
  assert.equal(arcErc20ToNative(erc), 5n * 10n ** 18n);
  const result = arcBalance(balance, erc, nativeUsdc(2n * 10n ** 18n));
  assert.equal(result.canonicalNative, balance);
  assert.equal(result.spendableErc20, 3_000_000n);
  assert.equal(result.dustNative, 99n);
  assert.throws(() => arcBalance(balance, erc20Usdc(5n * 10n ** 18n), nativeUsdc(0n)), /disagree/);
});
const rejectionCases: Array<[string, (o: ReturnType<typeof fixture>) => void, string]> = [
  ['stale state', o => { o.state.observedAt -= 181; }, 'STALE_STATE'],
  ['future state', o => { o.state.observedAt += 60; }, 'STALE_STATE'],
  ['unverified pool', o => { o.state.verified = false; }, 'POOL_UNVERIFIED'],
  ['missing prices', o => { o.prices = []; }, 'PRICE_UNAVAILABLE'],
  ['provider disagreement', o => { o.prices[0]!.usd = 2; }, 'PRICE_DIVERGENCE'],
  ['on-chain reference disagreement', o => { o.prices[0]!.usd = 2; o.prices[1]!.usd = 2; }, 'SPOT_PRICE_DIVERGENCE'],
  ['wrong price chain', o => { o.prices[0]!.chainId = 56; }, 'PRICE_IDENTITY_MISMATCH'],
  ['missing risk', o => { o.risks = []; }, 'RISK_UNAVAILABLE'],
  ['sell failure on Robinhood is deferred to executor', o => { o.risks[0]!.sellSimulation = false; }, null],
  ['unknown risk is not false', o => { o.risks[0]!.honeypot = null; }, 'HONEYPOT'],
  ['large holders', o => { o.risks[0]!.top10HolderPct = 90; }, 'HOLDER_CONCENTRATION'],
  ['tax', o => { o.risks[0]!.sellTaxBps = 400; }, 'SELL_TAX'],
  ['partial window', o => { o.complete = false; }, 'INCOMPLETE_WINDOW'],
  ['indexer lag', o => { o.indexedBlock -= 100n; }, 'INDEXER_LAG'],
  ['missing depth', o => { o.ticksComplete = false; }, 'DEPTH_UNAVAILABLE'],
  ['missing TVL is allowed when unavailable', o => { o.tvlUsd = null; }, null],
  ['unknown LP fee', o => { o.swaps[0]!.lpFeeUsd = null; }, 'LP_NET_FEES_UNAVAILABLE'],
  ['unknown gas costs are diagnostic only', o => { o.estimatedLifecycleCostUsd = null; }, null],
  ['duplicate swaps', o => { o.swaps.push(o.swaps[0]!); }, 'DUPLICATE_SWAP'],
  ['wrong exact pool', o => { o.swaps[0]!.pool = demoObservations()[2]!.state.pool; }, 'SWAP_POOL_MISMATCH'],
  ['future swaps', o => { o.swaps[0]!.timestamp = now + 10; }, 'SWAP_OUTSIDE_WINDOW'],
  ['wrong static fee', o => { o.swaps[0]!.grossFeeUsd *= 2; }, 'STATIC_FEE_MISMATCH'],
];
for (const [name, mutate, expected] of rejectionCases) test(`policy semantics: ${name}`, () => {
  const o = fixture(); mutate(o); const result = screen(o, policy, now);
  if (expected) assert.ok(codes(o).includes(expected)); else assert.equal(result.rejections.some(r => ['SIMULATION_REQUIRED','TVL_TOO_LOW','NET_YIELD_TOO_LOW'].includes(r.code)), false);
});
test('Arc native-sentinel and unknown v4 hooks are rejected', () => {
  const o = demoObservations().at(-1)!;
  if (o.state.pool.protocol !== 'v4') throw new Error('fixture');
  o.state.pool.poolKey.currency0 = zeroAddress; o.state.token0.address = zeroAddress;
  o.state.pool.poolId = poolId(o.state.pool.poolKey);
  assert.ok(codes(o).includes('ARC_NATIVE_SENTINEL'));
  o.state.pool.poolKey.hooks = '0x0000000000000000000000000000000000000123';
  assert.ok(codes(o).includes('UNKNOWN_HOOK'));
});
test('dynamic fee cannot be misclassified as a static pool', () => {
  const o = demoObservations()[1]!;
  if (o.state.pool.protocol !== 'v4') throw new Error('fixture');
  o.state.pool.poolKey.fee = 0x800000; o.state.pool.poolId = poolId(o.state.pool.poolKey);
  assert.ok(codes(o).includes('FEE_MODEL_MISMATCH'));
});
test('Pancake fee calculations use the actual 2500 pool fee', () => {
  const o = demoObservations().find(o => o.state.pool.dex === 'pancakeswap')!;
  const m = screen(o, policy, now).metrics;
  assert.ok(Math.abs(m.grossFeesUsd - m.volumeUsd * .0025) < 1e-8);
  assert.ok(Math.abs(m.feesPerMinute! - m.grossFeesUsd / 30) < 1e-8);
});
test('canonical pricing accepts one fresh source and preserves primary-source priority', () => {
  const o = fixture(), token = o.state.token0.address;
  const one = canonicalPrice([o.prices[0]!], token, now, policy);
  assert.equal(one?.usd, 1); assert.equal(one?.divergencePct, 0);
  const prioritized = canonicalPrice([
    { ...o.prices[0]!, source: 'geckoterminal', usd: 2 },
    { ...o.prices[0]!, source: 'gmgn', usd: 1 },
  ], token, now, policy);
  assert.equal(prioritized?.source, 'gmgn'); assert.equal(prioritized?.usd, 1); assert.equal(prioritized?.divergencePct, 100);
  o.prices = o.prices.filter((_, index) => index % 2 === 0);
  assert.equal(codes(o).includes('PRICE_UNAVAILABLE'), false);
});
test('LP-net fee math follows each protocol encoding and swap direction', () => {
  const uniswap = fixture().state;
  uniswap.protocolFee = 4 + (5 << 4);
  assert.equal(directionalProtocolFee(uniswap, true), 4);
  assert.equal(lpFeePips(uniswap, true), 2250);
  assert.equal(lpFeePips(uniswap, false), 2400);
  const pancake = demoObservations().find(o => o.state.pool.dex === 'pancakeswap')!.state;
  pancake.protocolFee = 3200 + (3200 << 16);
  assert.equal(lpFeePips(pancake, true), 1700);
  const v4 = demoObservations()[1]!.state;
  v4.protocolFee = 100 + (200 << 12);
  assert.equal(lpFeePips(v4, true), 2999.7);
  assert.equal(lpFeePips(v4, false), 2999.4);
  v4.dynamicFee = true;
  assert.equal(lpFeePips(v4, true), null);
});
test('depth traverses initialized ticks and detects exhausted exit liquidity', () => {
  const s = fixture().state;
  const range = onePercentDepthRange(s);
  assert.ok(range.lowerTick < s.tick && range.upperTick > s.tick);
  const full = depth1Pct(s, [], [1, 1]);
  const reduced = depth1Pct(s, [{ index: -60, liquidityNet: s.liquidity / 2n }], [1, 1]);
  assert.ok(reduced.down! < full.down!); assert.equal(reduced.up, full.up);
  assert.equal(depth1Pct(s, [{ index: -60, liquidityNet: s.liquidity }], [1, 1]).down, null);
});
test('volatility uses ordered minute closes and fee growth wraps at uint256', () => {
  const o = fixture(); assert.ok(volatility(o.swaps)!.realizedPct > 0);
  const max = 1n << 256n;
  assert.equal(liveFees(1n << 128n, 5n, max - 5n, 3n), 13n);
  assert.equal(feeGrowthInside(0, -60, 60, 100n, 20n, 30n), 50n);
  assert.equal(Q96, 79228162514264337593543950336n);
});
test('planner aligns ticks, bounds amounts, and checks limits', () => {
  const o = fixture(), c = screen(o, policy, now), p = planPosition(o, c, 25, policy, portfolio, now);
  assert.equal(p.tickLower % o.state.tickSpacing, -0);
  assert.equal(p.tickUpper % o.state.tickSpacing, 0);
  assert.ok(p.depositUsd <= 25); assert.ok(p.depositAssets.every(a => a.amount > 0n));
  assert.throws(() => planPosition(o, c, 26, policy, portfolio, now), /POSITION_LIMIT/);
  assert.throws(() => planPosition(o, c, 25, policy, { ...portfolio, totalExposureUsd: 499 }, now), /EXPOSURE_LIMIT/);
  assert.throws(() => planPosition(o, c, 25, policy, { ...portfolio, dailyLossUsd: 50 }, now), /DAILY_LOSS_LIMIT/);
  assert.doesNotThrow(() => planPosition(o, c, 25, policy, portfolio, now + 1000));
});
test('Arc reserve is subtracted from the shared balance after the LP deposit', () => {
  const o = demoObservations().at(-1)!, c = screen(o, policy, now);
  assert.throws(() => planPosition(o, c, 25, policy, portfolio, now, {
    native: 13n * 10n ** 18n, tokens: new Map([[o.state.token0.address, 100n * 10n ** 6n], [o.state.token1.address, 13n * 10n ** 6n]]),
  }), /GAS_RESERVE/);
});
test('LLM cannot invent a pool or override rejection', async () => {
  const c = screen(fixture(), policy, now);
  await assert.rejects(selectCandidate([c], { choose: async () => ({ action: 'preview', candidateId: 'arbitrary-contract', reason: 'override' }) }), /UNAPPROVED/);
  assert.throws(() => assertRoleTool('screener', 'close_position'), /DENIED/);
  assert.throws(() => assertRoleTool('manager', 'preview_position'), /DENIED/);
});
test('one chain can pause without pausing the other chains and execution stays disabled', () => {
  const s = new ChainSupervisor(2); s.failure(56, 'rpc'); s.failure(56, 'rpc');
  assert.throws(() => s.assertActive(56), /PAUSED/); s.assertActive(8453);
  s.resume(56); s.assertActive(56); s.stop('operator'); assert.throws(() => s.assertActive(8453), /PAUSED/);
  assert.throws(executeTransaction, /READ_ONLY_RELEASE/);
});
test('paper fees accrue only once for overlapping observations', () => {
  const o = fixture(), p = openPaperPosition(planPosition(o, screen(o, policy, now), 25, policy, portfolio, now), now);
  const next = demoObservations(now + 1800)[0]!;
  const marked = markPaperPosition(p, next, policy, now + 1800);
  assert.ok(marked.unclaimedFeesUsd > 0);
  const repeated = markPaperPosition(marked, next, policy, now + 1800);
  assert.equal(repeated.unclaimedFeesUsd, marked.unclaimedFeesUsd);
  assert.equal(marked.currentValueUsd, p.currentValueUsd);
});
test('paper sell failure triggers emergency exit and claims preserve net value', () => {
  const o = fixture(), p = openPaperPosition(planPosition(o, screen(o, policy, now), 25, policy, portfolio, now), now);
  const next = demoObservations(now + 1800)[0]!; next.risks[0]!.sellSimulation = false;
  const closed = markPaperPosition(p, next, policy, now + 1800);
  assert.equal(closed.status, 'closed'); assert.equal(closed.events.at(-1)!.action, 'emergency-close');
  const a = accounting({ ...p, currentValueUsd: 30, claimedFeesUsd: 2, unclaimedFeesUsd: 3, gasCostUsd: 1 });
  const b = accounting({ ...p, currentValueUsd: 30, claimedFeesUsd: 5, unclaimedFeesUsd: 0, gasCostUsd: 1 });
  assert.equal(a.netPnlUsd, b.netPnlUsd);
});
test('token metadata strips terminal controls and markup', () => {
  assert.equal(sanitizeMetadata('\u001b[31m<script>coin</script>\u202e'), '31mscriptcoin/script');
  assert.equal(sanitizeMetadata('a'.repeat(100)).length, 64);
});
