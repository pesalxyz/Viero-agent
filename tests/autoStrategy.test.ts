import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRequest, LlmClient } from '../src/viero/agent/llmClient.js';
import type { Controls } from '../src/viero/storage/repositories.js';
import { loadStrategyInstruction, resolvePositionSize, resolveRangeWidth } from '../src/viero/strategy/autoStrategy.js';

function controls(over: Partial<Controls> = {}): Controls {
  return {
    globalPaused: false, pausedChains: [], botState: 'STOPPED', enabledChains: [8453],
    takeProfitPct: 20, stopLossPct: -10,
    sizeMode: 'FIXED', fixedSizeUsd: 25,
    rangeMode: 'FIXED', fixedRangePct: 15,
    minAutoSizeUsd: 5, maxAutoSizeUsd: 25, autoSizeMarketCapMinUsd: 1_000_000, autoSizeMarketCapMaxUsd: 100_000_000, maxWalletExposurePct: 5,
    minAutoRangePct: 30, maxAutoRangePct: 85, autoRangeVolatilityReferencePct: 5,
    ...over,
  };
}

function llm(content: string | null, fail?: Error): LlmClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    isEnabled: () => true,
    providerLabel: () => 'test',
    async chat(request) {
      requests.push(request);
      if (fail) throw fail;
      return { content, toolCalls: [], finishReason: 'stop' };
    },
  };
}

test('FIXED size returns persisted USD value without LLM', async () => {
  const client = llm('{"sizeUsd":1,"reason":"unused"}');
  const result = await resolvePositionSize({ controls: controls(), context: { walletEquityUsd: null, availableExecutionBalanceUsd: null, marketCapUsd: null }, llm: client });
  assert.deepEqual(result, { ok: true, value: 25, source: 'FIXED', reason: 'Operator-configured fixed USD size' });
  assert.equal(client.requests.length, 0);
});

test('FIXED range returns persisted value without LLM', async () => {
  const client = llm('{"rangePct":1,"reason":"unused"}');
  const result = await resolveRangeWidth({ controls: controls(), context: {}, llm: client });
  assert.deepEqual(result, { ok: true, value: 15, source: 'FIXED', reason: 'Operator-configured fixed single-side range' });
  assert.equal(client.requests.length, 0);
});

test('AUTO size maps exact GMGN market cap logarithmically and does not call the LLM', async () => {
  const client = llm('{"sizeUsd":25,"reason":"must remain unused"}');
  const result = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }),
    context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100, marketCapUsd: 10_000_000, existingExposureUsd: 0 }, llm: client });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 15);
  assert.equal(client.requests.length, 0);
});

test('AUTO size respects the $1m/$100m boundaries and CASHED $1.5m regression', async () => {
  const context = { walletEquityUsd: 10_000, availableExecutionBalanceUsd: 1_000, existingExposureUsd: 0 };
  const minimum = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context: { ...context, marketCapUsd: 1_000_000 } });
  const cashed = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context: { ...context, marketCapUsd: 1_500_000 } });
  const maximum = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context: { ...context, marketCapUsd: 100_000_000 } });
  assert.equal(minimum.ok && minimum.value, 5);
  assert.equal(cashed.ok && cashed.value, 6.76);
  assert.equal(maximum.ok && maximum.value, 25);
});

test('AUTO size is capped by remaining wallet exposure and quote balance', async () => {
  const result = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }),
    context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 12, marketCapUsd: 100_000_000, existingExposureUsd: 40 } });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 10);
});

test('AUTO size fails closed when market cap is unavailable or caps fall below the minimum', async () => {
  const base = { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100, marketCapUsd: null };
  const missing = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context: base });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'MARKET_CAP_UNAVAILABLE');
  const tooSmall = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context: { ...base, marketCapUsd: 1_500_000, availableExecutionBalanceUsd: 4 } });
  assert.equal(tooSmall.ok, false);
  if (!tooSmall.ok) assert.equal(tooSmall.error, 'AUTO_SIZE_BELOW_MINIMUM');
});

test('AUTO range deterministically maps volatility to the configured single-sided width', async () => {
  const client = llm('{"rangePct":1,"reason":"must remain unused"}');
  const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: { volatilityPct: 8 },
    llm: client });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 85);
  assert.equal(client.requests.length, 0);
});

test('AUTO range produces 52% at 2% volatility with 30/85/5 parameters', async () => {
  const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: { volatilityPct: 2 } });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 52);
});

test('AUTO range fails closed when volatility is missing or zero', async () => {
  const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: { volatilityPct: null } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'VOLATILITY_UNAVAILABLE');
  const zero = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: { volatilityPct: 0 } });
  assert.equal(zero.ok, false);
});

test('AUTO strategy never calls the LLM or modifies TP/SL settings', async () => {
  const client = llm('{"sizeUsd":20,"reason":"valid"}');
  const configured = controls({ sizeMode: 'AUTO', takeProfitPct: 987.654, stopLossPct: -876.543 });
  await resolvePositionSize({ controls: configured, context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100, marketCapUsd: 10_000_000 }, llm: client });
  assert.equal(client.requests.length, 0);
  assert.equal(configured.takeProfitPct, 987.654);
  assert.equal(configured.stopLossPct, -876.543);
});

test('strategy markdown instruction files load correctly', async () => {
  const size = await loadStrategyInstruction('auto-size');
  const range = await loadStrategyInstruction('auto-range');
  assert.match(size, /"sizeUsd"/);
  assert.match(range, /"rangePct"/);
});
