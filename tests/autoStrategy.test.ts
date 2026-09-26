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
    minAutoSizeUsd: 5, maxAutoSizeUsd: 25, maxWalletExposurePct: 5,
    minAutoRangePct: 5, maxAutoRangePct: 30,
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
  const result = await resolvePositionSize({ controls: controls(), context: { walletEquityUsd: null, availableExecutionBalanceUsd: null }, llm: client });
  assert.deepEqual(result, { ok: true, value: 25, source: 'FIXED', reason: 'Operator-configured fixed USD size' });
  assert.equal(client.requests.length, 0);
});

test('FIXED range returns persisted value without LLM', async () => {
  const client = llm('{"rangePct":1,"reason":"unused"}');
  const result = await resolveRangeWidth({ controls: controls(), context: {}, llm: client });
  assert.deepEqual(result, { ok: true, value: 15, source: 'FIXED', reason: 'Operator-configured fixed single-side range' });
  assert.equal(client.requests.length, 0);
});

test('AUTO size accepts a valid structured proposal within every hard cap', async () => {
  const client = llm('{"sizeUsd":20,"reason":"Conservative exposure"}');
  const result = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }),
    context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100, existingExposureUsd: 10 }, llm: client });
  assert.deepEqual(result, { ok: true, value: 20, source: 'AUTO', reason: 'Conservative exposure' });
});

test('AUTO size over a hard maximum is rejected, never clamped', async () => {
  const result = await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }),
    context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100 }, llm: llm('{"sizeUsd":26,"reason":"too large"}') });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'AUTO_SIZE_EXCEEDS_HARD_LIMIT');
});

test('AUTO size LLM failure and malformed output fail closed', async () => {
  const context = { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100 };
  assert.equal((await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context, llm: llm(null, new Error('LLM_HTTP_429')) })).ok, false);
  assert.equal((await resolvePositionSize({ controls: controls({ sizeMode: 'AUTO' }), context, llm: llm('not json') })).ok, false);
});

test('AUTO range accepts a valid structured proposal', async () => {
  const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: { volatilityPct: 8 },
    llm: llm('{"rangePct":15,"reason":"Matches observed movement"}') });
  assert.deepEqual(result, { ok: true, value: 15, source: 'AUTO', reason: 'Matches observed movement' });
});

test('AUTO range rejects values below 1 or above 99', async () => {
  for (const rangePct of [0, 100]) {
    const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO', minAutoRangePct: 1, maxAutoRangePct: 99 }), context: {},
      llm: llm(JSON.stringify({ rangePct, reason: 'invalid' })) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /ABSOLUTE_LIMITS/);
  }
});

test('AUTO range LLM failure fails closed', async () => {
  const result = await resolveRangeWidth({ controls: controls({ rangeMode: 'AUTO' }), context: {}, llm: llm(null, new Error('LLM_TIMEOUT')) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /AUTO_RANGE_LLM_FAILED/);
});

test('AUTO strategy never passes TP or SL settings to the LLM', async () => {
  const client = llm('{"sizeUsd":20,"reason":"valid"}');
  const configured = controls({ sizeMode: 'AUTO', takeProfitPct: 987.654, stopLossPct: -876.543 });
  await resolvePositionSize({ controls: configured, context: { walletEquityUsd: 1000, availableExecutionBalanceUsd: 100 }, llm: client });
  const facts = client.requests[0]?.messages[0]?.content ?? '';
  assert.doesNotMatch(facts, /takeProfitPct|stopLossPct|987\.654|876\.543/);
  assert.equal(configured.takeProfitPct, 987.654);
  assert.equal(configured.stopLossPct, -876.543);
});

test('strategy markdown instruction files load correctly', async () => {
  const size = await loadStrategyInstruction('auto-size');
  const range = await loadStrategyInstruction('auto-range');
  assert.match(size, /"sizeUsd"/);
  assert.match(range, /"rangePct"/);
});
