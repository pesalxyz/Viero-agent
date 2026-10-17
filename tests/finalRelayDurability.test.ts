import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RelayOperationStore } from '../src/viero/storage/relayOperationStore.js';
import { RelayBalancer } from '../src/viero/execution/relay.js';
import { demoObservations } from '../src/viero/fixtures/demo.js';
import { getChain } from '../src/viero/config/chains.js';
import type { PositionPlan } from '../src/viero/execution/planner.js';

const signer = `0x${'11'.repeat(20)}` as `0x${string}`;
const token = `0x${'22'.repeat(20)}` as `0x${string}`;
const txHash = `0x${'33'.repeat(32)}` as `0x${string}`;
const plan = { chainId: 4663, pool: demoObservations()[0]!.state.pool, createdAt: 1234,
  depositUsd: 10, slippageBps: 50 } as PositionPlan;
function quote(kind: 'ACQUIRE' | 'NORMALIZE') {
  const stable = getChain(4663).primaryStable;
  return { details: { operation: 'swap', sender: signer, recipient: signer,
    currencyIn: { currency: { chainId: 4663, address: kind === 'ACQUIRE' ? stable : token }, amount: '100', amountUsd: '1' },
    currencyOut: { currency: { chainId: 4663, address: kind === 'ACQUIRE' ? token : stable }, amount: '100' } },
    steps: [{ id: 'swap', requestId: 'test-request-1', items: [{ txHashes: [{ chainId: 4663, txHash }],
      receipt: { status: 'success', blockNumber: 42n, blockHash: `0x${'44'.repeat(32)}` } }] }] };
}
function balancer(file: string, execute: (args: any) => Promise<any>) {
  const old = process.env.VIERO_RPC_4663;
  process.env.VIERO_RPC_4663 = 'http://127.0.0.1:9';
  const relay = new RelayBalancer({ account: { address: signer }, get: () => ({}) } as any,
    { get: () => ({ readContract: async () => 1000n,
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 42n, blockHash: `0x${'44'.repeat(32)}` }) }) } as any,
    'test-only', file);
  if (old === undefined) delete process.env.VIERO_RPC_4663; else process.env.VIERO_RPC_4663 = old;
  (relay as any).client.actions = { getQuote: async ({ currency }: any) => quote(currency.toLowerCase() === token.toLowerCase() ? 'NORMALIZE' : 'ACQUIRE'), execute };
  return relay;
}

test('Relay intent and request ID are durable before SDK execution; progress hash and completion survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-relay-durable-'));
  try {
    const file = join(root, 'relay.db'); let observed: ReturnType<RelayOperationStore['unresolved']> = [];
    const relay = balancer(file, async ({ onProgress }: any) => {
      const reader = new RelayOperationStore(file);
      try { observed = reader.unresolved(); } finally { reader.close(); }
      onProgress({ steps: quote('ACQUIRE').steps });
      return { data: quote('ACQUIRE') };
    });
    const transactions = await relay.acquire(plan, token, 100n);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.state, 'EXECUTING');
    assert.deepEqual(observed[0]?.requestIds, ['test-request-1']);
    assert.equal(transactions.length, 1);
    relay.closeStore();
    const reopened = new RelayOperationStore(file);
    try {
      assert.equal(reopened.unresolved().length, 0);
      const record = reopened.database.prepare('SELECT transaction_hashes,state FROM relay_operations').get() as any;
      assert.equal(record.state, 'COMPLETE'); assert.deepEqual(JSON.parse(record.transaction_hashes), [txHash]);
    } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ambiguous Relay SDK outcome is never executed twice, including after restart and changed operation key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-relay-unknown-'));
  try {
    const file = join(root, 'relay.db'); let calls = 0;
    const execute = async ({ onProgress }: any) => { calls++; onProgress({ steps: quote('ACQUIRE').steps }); throw new Error('fake transport timeout'); };
    const first = balancer(file, execute);
    await assert.rejects(() => first.acquire(plan, token, 100n), /RELAY_OUTCOME_UNKNOWN/);
    first.closeStore();
    const second = balancer(file, execute);
    assert.deepEqual(second.recoveryStatus(), { state: 'RECONCILIATION_REQUIRED', unresolved: 1 });
    await assert.rejects(() => second.acquire(plan, token, 100n), /RELAY_OPERATION_ALREADY_RECORDED/);
    await assert.rejects(() => second.acquire({ ...plan, createdAt: 1235 }, token, 100n), /RELAY_RECONCILIATION_REQUIRED/);
    assert.equal(calls, 1);
    assert.equal(second.unresolvedOperations()[0]?.state, 'UNKNOWN');
    assert.deepEqual(second.unresolvedOperations()[0]?.transactionHashes, [txHash]);
    second.closeStore();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-close normalization has independent durable intent and agent-side store access is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-relay-normalize-'));
  try {
    const file = join(root, 'relay.db');
    const relay = balancer(file, async () => ({ data: quote('NORMALIZE') }));
    const result = await relay.liquidate(plan, token, getChain(4663).primaryStable, 100n, 'position-1');
    assert.equal(result.length, 1);
    relay.closeStore();
    assert.throws(() => new RelayOperationStore(file, 'agent'), /SIGNER_ONLY/);
    const reopened = new RelayOperationStore(file);
    try { assert.equal(reopened.unresolved().length, 0); } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Relay completion requires an independently confirmed canonical receipt and at least one transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-relay-canonical-'));
  try {
    const file = join(root, 'relay.db');
    const mismatch = balancer(file, async () => ({ data: quote('ACQUIRE') }));
    (mismatch as any).publicClients = { get: () => ({ waitForTransactionReceipt: async () => ({
      status: 'success', blockNumber: 42n, blockHash: `0x${'55'.repeat(32)}`, transactionHash: txHash }) }) };
    await assert.rejects(() => mismatch.acquire(plan, token, 100n), /RELAY_RECEIPT_CANONICALITY_MISMATCH/);
    assert.equal(mismatch.unresolvedOperations()[0]?.state, 'EXECUTING');
    mismatch.closeStore();
    const second = balancer(join(root, 'empty.db'), async () => ({ data: { ...quote('ACQUIRE'),
      steps: [{ ...quote('ACQUIRE').steps[0]!, items: [] }] } }));
    await assert.rejects(() => second.acquire(plan, token, 100n), /RELAY_NO_CONFIRMED_TRANSACTIONS/);
    assert.equal(second.unresolvedOperations()[0]?.state, 'EXECUTING');
    second.closeStore();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Relay SDK partial or mismatched step result remains unresolved and cannot be replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-relay-partial-'));
  try {
    const file = join(root, 'relay.db'); let calls = 0;
    const relay = balancer(file, async () => {
      calls++;
      return { data: { ...quote('ACQUIRE'), steps: [] } };
    });
    await assert.rejects(() => relay.acquire(plan, token, 100n), /RELAY_OUTCOME_UNKNOWN.*RELAY_EXECUTION_STEPS_INCOMPLETE/);
    assert.equal(relay.unresolvedOperations()[0]?.state, 'UNKNOWN');
    await assert.rejects(() => relay.acquire(plan, token, 100n), /RELAY_OPERATION_ALREADY_RECORDED/);
    assert.equal(calls, 1);
    relay.closeStore();
  } finally { await rm(root, { recursive: true, force: true }); }
});
