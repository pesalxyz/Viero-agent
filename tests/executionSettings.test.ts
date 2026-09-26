import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmClient } from '../src/viero/agent/llmClient.js';
import type { Controls, Repository, AgentRun } from '../src/viero/storage/repositories.js';
import { assertCandidateExecutionAllowed, assertLiveExecutionEnabled, resolveExecutionSettings } from '../src/viero/strategy/executionSettings.js';
import { planPosition, refreshFixedRangePlan } from '../src/viero/execution/planner.js';
import { getChain } from '../src/viero/config/chains.js';
import { sqrtAtTick, tokenValue } from '../src/viero/screening/math.js';
import { DEFAULT_POLICY } from '../src/viero/config/policy.js';
import { demoObservations, DEMO_TIME } from '../src/viero/fixtures/demo.js';
import { screen } from '../src/viero/screening/pipeline.js';
import { managementRule, openPaperPosition } from '../src/viero/management/paper.js';
import { Agent } from '../src/viero/workers/screeningWorker.js';

const fixedControls = (over: Partial<Controls> = {}): Controls => ({
  globalPaused: false, pausedChains: [], botState: 'RUNNING', enabledChains: [4663],
  sizeMode: 'FIXED', fixedSizeUsd: 20, rangeMode: 'FIXED', fixedRangePct: 15,
  takeProfitPct: 12, stopLossPct: -8,
  minAutoSizeUsd: 5, maxAutoSizeUsd: 25, autoSizeMarketCapMinUsd: 1_000_000, autoSizeMarketCapMaxUsd: 100_000_000, maxWalletExposurePct: 5,
  minAutoRangePct: 30, maxAutoRangePct: 85, autoRangeVolatilityReferencePct: 5, ...over,
});

const contexts = {
  sizeContext: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100, marketCapUsd: 10_000_000, existingExposureUsd: 0, activePositions: 0 },
  rangeContext: { volatilityPct: 2, poolFeeTier: 3000, liquidityUsd: 5_000_000, direction: 'single-side' },
};

function strategyLlm(): LlmClient {
  return { isEnabled: () => true, providerLabel: () => 'test', async chat(request) {
    return request.systemPrompt.includes('Auto Size')
      ? { content: '{"sizeUsd":20,"reason":"bounded"}', toolCalls: [], finishReason: 'stop' }
      : { content: '{"rangePct":15,"reason":"bounded"}', toolCalls: [], finishReason: 'stop' };
  } };
}

test('FIXED size/range are wired into the planner snapshot', async () => {
  const controls = fixedControls();
  const settings = await resolveExecutionSettings({ controls, chainId: 4663, ...contexts });
  const observation = demoObservations(DEMO_TIME)[0]!, candidate = screen(observation, DEFAULT_POLICY, DEMO_TIME);
  const plan = planPosition(observation, candidate, settings.positionSizeUsd, DEFAULT_POLICY,
    { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 }, DEMO_TIME, undefined, 'paper', settings);
  assert.equal(plan.positionSizeUsd, 20); assert.equal(plan.rangePct, 15);
  assert.equal(plan.takeProfitPct, 12); assert.equal(plan.stopLossPct, -8);
  assert.equal(plan.sizeMode, 'FIXED'); assert.equal(plan.rangeMode, 'FIXED');
});

test('coarse V3 tick spacing moves a WETH quote-only range fully outside current tick', () => {
  const observation = demoObservations(DEMO_TIME)[0]!;
  const chain = getChain(4663);
  const state = {
    ...observation.state,
    token0: { ...observation.state.token0, address: chain.wrappedNative!, decimals: 18, symbol: 'WETH' },
    token1: { ...observation.state.token1, address: '0x1111111111111111111111111111111111111111' as const, decimals: 18, symbol: 'TOKEN' },
    tick: 100,
    tickSpacing: 200,
    sqrtPriceX96: sqrtAtTick(100),
  };
  const plan = {
    chainId: 4663 as const, pool: state.pool, mode: 'live' as const, createdAt: DEMO_TIME, deadline: DEMO_TIME + 120,
    sourceBlock: state.blockNumber, sourceBlockHash: state.blockHash, tickLower: -200, tickUpper: 0,
    liquidity: 10n ** 18n, poolFee: state.fee,
    // Use a realistic quote amount so the fixed-size rescaling path is
    // exercised with non-zero integer liquidity math.
    depositAssets: [{ token: state.token0.address, amount: 10n ** 18n }, { token: state.token1.address, amount: 0n }],
    expectedTransfers: [], slippageBps: 50, maximumGasCostUsd: 1, depositUsd: 10, positionSizeUsd: 10,
    rangePct: 50, takeProfitPct: 5, stopLossPct: -10, sizeMode: 'FIXED' as const, rangeMode: 'FIXED' as const,
  };
  const refreshed = refreshFixedRangePlan(plan, state);
  assert.ok(state.tick < refreshed.tickLower);
  assert.equal(refreshed.depositAssets[1]?.amount, 0n);
  assert.ok((refreshed.depositAssets[0]?.amount ?? 0n) > 0n);
});

test('executor refresh recalculates the entry USD baseline from the actual refreshed deposit', () => {
  const observation = demoObservations(DEMO_TIME)[0]!;
  const state = observation.state;
  const plan = {
    chainId: 4663 as const, pool: state.pool, mode: 'live' as const, createdAt: DEMO_TIME, deadline: DEMO_TIME + 120,
    sourceBlock: state.blockNumber, sourceBlockHash: state.blockHash, tickLower: -200, tickUpper: 0,
    liquidity: 10n ** 18n, poolFee: state.fee,
    depositAssets: [{ token: state.token0.address, amount: 1n }, { token: state.token1.address, amount: 0n }],
    expectedTransfers: [], slippageBps: 50, maximumGasCostUsd: 1, depositUsd: 10, positionSizeUsd: 10,
    rangePct: 50, takeProfitPct: 5, stopLossPct: -10, sizeMode: 'FIXED' as const, rangeMode: 'FIXED' as const,
  };
  const refreshed = refreshFixedRangePlan(plan, state, observation.prices, DEFAULT_POLICY);
  const expected = tokenValue(refreshed.depositAssets[0]!.amount, state.token0.decimals, 1)
    + tokenValue(refreshed.depositAssets[1]!.amount, state.token1.decimals, 1);
  assert.equal(refreshed.depositUsd, expected);
  assert.notEqual(refreshed.depositUsd, plan.depositUsd);
});

test('AUTO size/range resolutions are wired into a single-sided quote-only planner snapshot', async () => {
  const controls = fixedControls({ sizeMode: 'AUTO', rangeMode: 'AUTO' });
  const settings = await resolveExecutionSettings({ controls, chainId: 4663, ...contexts, llm: strategyLlm() });
  assert.deepEqual({ size: settings.positionSizeUsd, range: settings.rangePct, sizeMode: settings.sizeMode, rangeMode: settings.rangeMode },
    { size: 15, range: 52, sizeMode: 'AUTO', rangeMode: 'AUTO' });
  const observation = demoObservations(DEMO_TIME)[0]!, candidate = screen(observation, DEFAULT_POLICY, DEMO_TIME);
  const plan = planPosition(observation, candidate, settings.positionSizeUsd, DEFAULT_POLICY,
    { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 }, DEMO_TIME, undefined, 'paper', settings);
  const chain = getChain(4663), quote = plan.depositAssets.find(asset => asset.token.toLowerCase() === chain.primaryStable.toLowerCase() || asset.token.toLowerCase() === chain.wrappedNative?.toLowerCase());
  const base = plan.depositAssets.find(asset => asset.token.toLowerCase() !== quote?.token.toLowerCase());
  assert.ok(quote && quote.amount > 0n); assert.equal(base?.amount, 0n);
});

test('AUTO resolution failure blocks planning when market cap is unavailable', async () => {
  const controls = fixedControls({ sizeMode: 'AUTO' });
  await assert.rejects(resolveExecutionSettings({ controls, chainId: 4663, ...contexts, sizeContext: { ...contexts.sizeContext, marketCapUsd: null } }), /MARKET_CAP_UNAVAILABLE/);
});

test('disabled chain, missing TP/SL, and STOPPED reject before candidate work', () => {
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ enabledChains: [56] }), 4663), /CHAIN_NOT_ENABLED/);
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ globalPaused: true }), 4663), /GLOBAL_PAUSED_NEW_ENTRIES/);
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ pausedChains: [4663] }), 4663), /CHAIN_PAUSED_NEW_ENTRIES/);
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ takeProfitPct: null }), 4663), /TAKE_PROFIT/);
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ stopLossPct: null }), 4663), /STOP_LOSS/);
  assert.throws(() => assertCandidateExecutionAllowed(fixedControls({ botState: 'STOPPED' }), 4663), /BOT_STOPPED/);
});

test('position snapshot preserves settings and management uses snapshot TP after global changes', async () => {
  const settings = await resolveExecutionSettings({ controls: fixedControls({ takeProfitPct: 10, stopLossPct: -7 }), chainId: 4663, ...contexts });
  const observation = demoObservations(DEMO_TIME)[0]!, candidate = screen(observation, DEFAULT_POLICY, DEMO_TIME);
  const plan = planPosition(observation, candidate, settings.positionSizeUsd, DEFAULT_POLICY,
    { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 }, DEMO_TIME, undefined, 'paper', settings);
  const position = openPaperPosition(plan, DEMO_TIME);
  const changedGlobal = fixedControls({ takeProfitPct: 99, stopLossPct: -50 });
  assert.equal(position.plan.takeProfitPct, 10); assert.equal(position.plan.stopLossPct, -7);
  assert.equal(changedGlobal.takeProfitPct, 99);
  const decision = managementRule({ ...position, netPnlUsd: position.initialValueUsd * 0.11 }, observation, { ...DEFAULT_POLICY, stopLossPct: 99 }, DEMO_TIME);
  assert.equal(decision.reason, 'TAKE_PROFIT');
});

test('live execution disabled rejects before pool discovery or transaction broadcast', async () => {
  assert.throws(() => assertLiveExecutionEnabled('live-execution', { VIERO_EXECUTION_ENABLED: 'false' }), /LIVE_EXECUTION_NOT_ENABLED/);
  let controls = fixedControls(); let saved: AgentRun | null = null;
  const repo = { async controls() { return controls; }, async setControls(next: Controls) { controls = next; },
    async saveRun(run: AgentRun) { saved = run; }, async strategyState() { return { version: 1 as const, positions: [], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {} }; },
    async setStrategyState() {}, async initialize() {}, async latest() { return saved; }, async history() { return []; }, async findRunById() { return null; }, async close() {} } as Repository;
  const agent = new Agent(DEFAULT_POLICY, repo, undefined, {} as never, strategyLlm());
  let poolCalls = 0;
  agent.gmgn.poolInfo = async () => { poolCalls++; return null; };
  const prior = process.env.VIERO_EXECUTION_ENABLED; process.env.VIERO_EXECUTION_ENABLED = 'false';
  try {
    const run: AgentRun = { id: '00000000-0000-4000-8000-000000000002', mode: 'live-execution', startedAt: 1, finishedAt: 1,
      configVersion: 'test', deploymentVersion: 'test', policy: {}, observations: [], candidates: [], discoveries: [], decisions: [], tokenDecisions: [], positions: [], health: [], providerObservations: [], errors: [], status: 'ok' };
    const result = await agent.executeCandidateToken({ chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111', mode: 'live-execution', run });
    assert.equal(poolCalls, 0); assert.match(result.errors[0]?.error ?? '', /LIVE_EXECUTION_NOT_ENABLED/);
  } finally { if (prior === undefined) delete process.env.VIERO_EXECUTION_ENABLED; else process.env.VIERO_EXECUTION_ENABLED = prior; }
});
