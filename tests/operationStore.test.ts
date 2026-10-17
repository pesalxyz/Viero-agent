import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { OperationStore } from '../src/viero/storage/operationStore.js';
import { inspectOperationStore } from '../src/viero/storage/operationInspector.js';
import { SignerOperationStore, assertSignerStorePathSafe } from '../src/viero/storage/signerOperationStore.js';

const signer = '0x0000000000000000000000000000000000000001';
const fingerprint = 'a'.repeat(64);
async function withStore(fn: (store: OperationStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'viero-operation-store-')); const store = new OperationStore(join(root, 'operations.db'));
  try { await fn(store, root); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('operation store persists idempotent records and rejects conflicting fingerprints', async () => withStore(async (store) => {
  const created = store.create({ idempotencyKey: 'open:one', type: 'OPEN', chainId: 4663, positionId: 'p1', poolIdentity: 'pool', requestFingerprint: fingerprint, signerAddress: signer, nonce: null, transactionHash: null });
  assert.equal(store.create({ idempotencyKey: 'open:one', type: 'OPEN', chainId: 4663, positionId: 'p1', poolIdentity: 'pool', requestFingerprint: fingerprint, signerAddress: signer, nonce: null, transactionHash: null }).operationId, created.operationId);
  assert.throws(() => store.create({ idempotencyKey: 'open:one', type: 'OPEN', chainId: 4663, positionId: 'p1', poolIdentity: 'pool', requestFingerprint: 'b'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null }), /IDEMPOTENCY_CONFLICT/);
}));

test('state transitions are compare-and-set and nonce uniqueness is enforced', async () => withStore(async (store) => {
  const a = store.create({ idempotencyKey: 'close:one', type: 'CLOSE', chainId: 4663, positionId: 'p1', poolIdentity: null, requestFingerprint: fingerprint, signerAddress: signer, nonce: '7', transactionHash: null });
  assert.throws(() => store.create({ idempotencyKey: 'close:two', type: 'CLOSE', chainId: 4663, positionId: 'p2', poolIdentity: null, requestFingerprint: 'c'.repeat(64), signerAddress: signer, nonce: '7', transactionHash: null }));
  assert.throws(() => store.transition(a.operationId, 'PREPARED', 'TERMINAL'), /TRANSITION_INVALID/);
  const signed = store.transition(a.operationId, 'PREPARED', 'SIGNED');
  const known = store.transition(a.operationId, 'SIGNED', 'BROADCAST_KNOWN', { transactionHash: `0x${'1'.repeat(64)}`, broadcastStatus: 'KNOWN' });
  assert.equal(known.state, 'BROADCAST_KNOWN');
  assert.throws(() => store.transition(a.operationId, 'SIGNED', 'BROADCAST_UNKNOWN'), /COMPARE_AND_SET_FAILED/);
  assert.equal(signed.operationId, a.operationId);
}));

test('execution-only operation creation atomically rejects duplicate and conflicting in-flight requests', async () => withStore(async (store, root) => {
  const other = new OperationStore(join(root, 'operations.db'));
  try {
    const input = { idempotencyKey: 'exclusive:one', type: 'OPEN' as const, chainId: 4663, positionId: null,
      poolIdentity: null, requestFingerprint: fingerprint, signerAddress: signer, nonce: null, transactionHash: null };
    const first = store.createExclusive(input);
    assert.equal(first.state, 'PREPARED');
    assert.throws(() => other.createExclusive(input), /OPERATION_UNRESOLVED/);
    assert.throws(() => other.createExclusive({ ...input, idempotencyKey: 'exclusive:two' }), /OPERATION_UNRESOLVED/);
    assert.equal(store.all().length, 1);
  } finally { other.close(); }
}));

test('read-only inspector reports unresolved and nonce conflicts without mutation', async () => withStore(async (store, root) => {
  const a = store.create({ idempotencyKey: 'a', type: 'OPEN', chainId: 56, positionId: null, poolIdentity: null, requestFingerprint: fingerprint, signerAddress: signer, nonce: null, transactionHash: null });
  store.transition(a.operationId, 'PREPARED', 'SIGNED'); store.transition(a.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN' });
  const report = inspectOperationStore(join(root, 'operations.db'));
  assert.equal(report.unresolved.length, 1); assert.equal(report.findings[0]?.code, 'RECONCILIATION_REQUIRED');
  assert.equal(report.unresolved[0]?.requestFingerprint, '[redacted]'); assert.equal(report.unresolved[0]?.signerAddress, '[redacted]');
}));

test('signer facade rejects agent role and unsafe permissions', async () => withStore(async (_store, root) => {
  const file = join(root, 'operations.db');
  assert.throws(() => new SignerOperationStore(file, 'agent'), /SIGNER_ONLY/);
  await chmod(root, 0o777); assert.throws(() => assertSignerStorePathSafe(file), /DIRECTORY_PERMISSIONS/); await chmod(root, 0o700);
}));

test('child processes can write separate operation records into one SQLite WAL', async () => withStore(async (_store, root) => {
  const db = join(root, 'operations.db');
  const run = (key: string) => new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/operationStoreWorker.ts', db, key], { stdio: ['ignore', 'pipe', 'pipe'] }); let error = ''; child.stderr.on('data', (chunk) => { error += chunk.toString(); }); child.on('exit', (code) => { if (code !== 0) process.stderr.write(error); resolve(code ?? 1); });
  });
  const codes = await Promise.all(Array.from({ length: 4 }, (_, i) => run(`child:${i}`)));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const check = new OperationStore(db); assert.equal(check.unresolved().length, 4); check.close();
}));
