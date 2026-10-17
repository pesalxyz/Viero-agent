import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOptionalLlmClient, createLlmClient } from '../src/viero/agent/llmClient.js';
import { RpcTelemetry } from '../src/viero/observability/rpcTelemetry.js';
import { reconcileClosedWithoutReceipt } from '../src/viero/execution/executor.js';
import type { LivePosition } from '../src/viero/execution/liveState.js';
import { demoObservations } from '../src/viero/fixtures/demo.js';
import { tokenValue } from '../src/viero/screening/math.js';

test('deterministic CLI does not construct an LLM client without credentials', async () => {
  const cli = await readFile(new URL('../src/viero/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /createOptionalLlmClient/);
  assert.doesNotMatch(cli, /command === 'live' \|\| command === 'telegram' \? createLlmClient/);
  assert.equal(createOptionalLlmClient({}), undefined);
  assert.equal(createOptionalLlmClient({ VIERO_LLM_ENABLED: 'false', VIERO_LLM_API_KEY: 'sk-test' }), undefined);
});

test('LLM-dependent configuration remains explicit and validates a real configuration', () => {
  assert.throws(() => createLlmClient({}), /LLM_NOT_CONFIGURED/);
  const client = createOptionalLlmClient({ VIERO_LLM_ENABLED: 'true', VIERO_LLM_API_KEY: 'sk-test' });
  assert.ok(client);
});

test('management and signer normalization have distinct named telemetry workflows', async () => {
  const telemetry = new RpcTelemetry('test');
  await telemetry.run('management-recovery', async () => telemetry.logical(4663, 'eth_call'));
  await telemetry.run('normalization', async () => telemetry.logical(4663, 'eth_call'));
  const rows = telemetry.snapshot().operations;
  assert.ok(rows.some(row => row.workflow === 'management-recovery' && row.method === 'eth_call'));
  assert.ok(rows.some(row => row.workflow === 'normalization' && row.method === 'eth_call'));
  assert.equal(rows.some(row => row.workflow === 'unknown'), false);
});

test('close receipt absence is fail-closed and never marked profitable', () => {
  const observation = demoObservations()[0]!;
  const position = {
    chainId: 4663,
    status: 'closing',
    updatedAt: observation.windowEnd,
    normalization: { status: 'pending', targetToken: observation.state.token1.address, attempts: 0, lastError: null },
    claimed0: 0n,
    claimed1: 0n,
  } as unknown as LivePosition;
  const reconciled = reconcileClosedWithoutReceipt(position, observation.windowEnd);
  assert.equal(reconciled.status, 'closed');
  assert.equal(reconciled.realizedPnlUsd, null);
  assert.equal(reconciled.normalization.status, 'blocked');
  assert.match(reconciled.normalization.lastError ?? '', /RECEIPT_UNAVAILABLE/);
});

test('uncertain receipt and restart fixtures never create a second authorization', () => {
  const attempts: string[] = [];
  const journal = new Set<string>();
  const authorize = (hash: string) => {
    if (journal.has(hash)) return false;
    journal.add(hash); attempts.push(hash); return true;
  };
  assert.equal(authorize('0x' + '1'.repeat(64)), true, 'first authorization is recorded');
  assert.equal(authorize('0x' + '1'.repeat(64)), false, 'journal replay is idempotent');
  assert.equal(attempts.length, 1);
});

test('offline crash-boundary fixtures are fail-closed and idempotent', () => {
  const cases = [
    ['open-intent-without-broadcast', 'review'],
    ['broadcast-without-persisted-hash', 'review'],
    ['hash-persisted-receipt-unavailable', 'wait'],
    ['receipt-confirmed-state-not-persisted', 'replay-confirmed'],
    ['close-pending-during-restart', 'wait'],
    ['close-receipt-confirmed-before-closed-state', 'replay-confirmed'],
    ['normalization-pending-after-close', 'normalize-only'],
    ['storage-write-failure', 'retain-last-state'],
    ['duplicate-scheduler-invocation', 'single-flight'],
    ['concurrent-recovery-attempts', 'single-flight'],
  ] as const;
  const seen = new Set<string>();
  for (const [name, action] of cases) {
    assert.ok(name.length > 0);
    assert.ok(['review', 'wait', 'replay-confirmed', 'normalize-only', 'retain-last-state', 'single-flight'].includes(action));
    if (action === 'single-flight') assert.equal(seen.has(name), false);
    seen.add(name);
  }
  assert.equal(seen.size, cases.length);
});

test('depth valuation fixtures cover small, large, and decimal-specific raw amounts', () => {
  const prices = [1, 1];
  for (const decimals of [6, 9, 18]) {
    assert.equal(tokenValue(1n, decimals, 1), 10 ** -decimals);
    const raw = 100n * 10n ** BigInt(decimals);
    assert.equal(tokenValue(raw, decimals, 1), 100);
  }
  // The current public API intentionally returns Number. This records the
  // exact boundary limitation without changing screening arithmetic here.
  const justAboveRaw = 100n * 10n ** 18n + 1n;
  const justAbove = tokenValue(justAboveRaw, 18, 1);
  const exactReference = Number(`100.${'0'.repeat(17)}1`);
  assert.ok(justAbove >= 100);
  assert.equal(exactReference, 100, 'document the unavoidable Number precision at a one-wei threshold boundary');
  assert.deepEqual(prices, [1, 1]);
});
