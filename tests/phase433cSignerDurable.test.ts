import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { LiveExecutor } from '../src/viero/execution/executor.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as `0x${string}`;
const signer = `0x${'11'.repeat(20)}`;
const txHash = `0x${'22'.repeat(32)}` as `0x${string}`;

async function fixture(send: (raw: unknown) => Promise<`0x${string}`> = async () => txHash) {
  const root = await mkdtemp(join(tmpdir(), 'viero-phase433c-'));
  const executor = new LiveExecutor({ VIERO_SIGNER_PRIVATE_KEY: PRIVATE_KEY, VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: join(root, 'operations.db'), VIERO_SIGNER_TX_JOURNAL: join(root, 'transactions.jsonl') });
  const fakeAccount = { address: signer, signTransaction: async () => '0x1234' as `0x${string}` };
  const fakeWallet = { prepareTransactionRequest: async () => ({ nonce: 7, to: signer, data: '0x1234' as `0x${string}` }), account: fakeAccount };
  const receipt = { status: 'success' as const, blockNumber: 42n, blockHash: `0x${'33'.repeat(32)}` as `0x${string}`, logs: [] };
  const client = { sendRawTransaction: send, waitForTransactionReceipt: async () => receipt };
  (executor as any).wallets = { account: fakeAccount, get: () => fakeWallet };
  (executor as any).publicClients = { get: () => client };
  return { root, executor, expectedFingerprint: keccak256(new TextEncoder().encode('{"data":"0x1234","to":"0x1111111111111111111111111111111111111111"}') as Uint8Array).slice(2) };
}

test('LiveExecutor durable write reaches terminal exactly once', async () => {
  const f = await fixture();
  try {
    const result = await (f.executor as any).write(4663, { to: signer, data: '0x1234' }, 'OPEN');
    assert.equal(result.hash, txHash);
    assert.equal(f.executor.operationStore.unresolved().length, 0);
  } finally { f.executor.operationStore.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('ambiguous submission is durable and cannot be retried', async () => {
  let sends = 0;
  const f = await fixture(async () => { sends += 1; throw new Error('transport timeout'); });
  try {
    await assert.rejects(() => (f.executor as any).write(4663, { to: signer, data: '0x1234' }, 'CLOSE', 'position-1'), /BROADCAST_UNKNOWN/);
    assert.equal(sends, 1);
    assert.equal(f.executor.operationStore.unresolved().length, 1);
    await assert.rejects(() => (f.executor as any).write(4663, { to: signer, data: '0x1234' }, 'CLOSE', 'position-1'), /OPERATION_UNRESOLVED/);
    assert.equal(sends, 1);
  } finally { f.executor.operationStore.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('durability failure after broadcast never submits a replacement', async () => {
  let sends = 0;
  const f = await fixture(async () => { sends += 1; return txHash; });
  const original = f.executor.operationStore.transition.bind(f.executor.operationStore);
  let fail = true;
  (f.executor.operationStore as any).transition = (...args: any[]) => {
    if (fail && args[2] === 'BROADCAST_KNOWN') { fail = false; throw new Error('DB_COMMIT_FAILED'); }
    return original(...args);
  };
  try {
    await assert.rejects(() => (f.executor as any).write(4663, { to: signer, data: '0x1234' }, 'OPEN'), /DB_COMMIT_FAILED/);
    assert.equal(sends, 1);
    assert.equal(f.executor.operationStore.unresolved().length, 1);
  } finally { f.executor.operationStore.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('recovery reconciles an exact hash and blocks hashless ambiguity', async () => {
  const f = await fixture();
  try {
    const record = f.executor.operationStore.create({ idempotencyKey: 'reconcile:known', type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'a'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
    f.executor.operationStore.reserveNonce(record.operationId, '8');
    f.executor.operationStore.transition(record.operationId, 'PREPARED', 'SIGNED', { transactionHash: txHash, broadcastStatus: 'NOT_ATTEMPTED' });
    f.executor.operationStore.transition(record.operationId, 'SIGNED', 'BROADCAST_KNOWN', { transactionHash: txHash, broadcastStatus: 'KNOWN' });
    const unknown = f.executor.operationStore.create({ idempotencyKey: 'reconcile:unknown', type: 'CLOSE', chainId: 4663, positionId: 'p', poolIdentity: null, requestFingerprint: 'b'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
    f.executor.operationStore.transition(unknown.operationId, 'PREPARED', 'SIGNED');
    f.executor.operationStore.transition(unknown.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN' });
    await f.executor.reconcileDurableOperations(4663);
    assert.equal(f.executor.operationStore.get(record.operationId)?.state, 'TERMINAL');
    assert.equal(f.executor.operationStore.get(unknown.operationId)?.state, 'RECONCILIATION_REQUIRED');
  } finally { f.executor.operationStore.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('changed canonical receipt block hash is reorg-suspect and never terminalized automatically', async () => {
  const f = await fixture();
  try {
    const record = f.executor.operationStore.create({ idempotencyKey: 'reorg', type: 'CLOSE', chainId: 4663, positionId: 'position-1',
      poolIdentity: 'pool', requestFingerprint: 'a'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
    f.executor.operationStore.reserveNonce(record.operationId, '9');
    f.executor.operationStore.transition(record.operationId, 'PREPARED', 'SIGNED', { transactionHash: txHash });
    f.executor.operationStore.transition(record.operationId, 'SIGNED', 'BROADCAST_KNOWN', { transactionHash: txHash, broadcastStatus: 'KNOWN' });
    f.executor.operationStore.transition(record.operationId, 'BROADCAST_KNOWN', 'RECEIPT_PENDING');
    f.executor.operationStore.transition(record.operationId, 'RECEIPT_PENDING', 'CONFIRMED', {
      receipt: { blockNumber: '42', blockHash: `0x${'44'.repeat(32)}`, status: 'success', confirmations: 3 },
      finality: 'CONFIRMED', reconciliation: 'COMPLETE',
    });
    await f.executor.reconcileDurableOperations(4663);
    assert.equal(f.executor.operationStore.get(record.operationId)?.state, 'RECONCILIATION_REQUIRED');
    assert.equal(f.executor.operationStore.get(record.operationId)?.finality, 'REORG_SUSPECTED');
    await f.executor.reconcileDurableOperations(4663);
    assert.equal(f.executor.operationStore.get(record.operationId)?.state, 'RECONCILIATION_REQUIRED');
  } finally { f.executor.operationStore.close(); await rm(f.root, { recursive: true, force: true }); }
});
