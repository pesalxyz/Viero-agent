import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { buildEvidenceHandoff, readEvidenceHandoff, writeEvidenceHandoff } from '../src/viero/storage/evidenceHandoff.js';
import { OperationStore } from '../src/viero/storage/operationStore.js';

const signer = `0x${'11'.repeat(20)}`;
test('evidence handoff exports only terminal receipt-backed operations and rejects tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-evidence-'));
  try {
    const db = join(root, 'operations.db'), file = join(root, 'evidence.json');
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const store = new OperationStore(db);
    const operation = store.create({ idempotencyKey: 'evidence', type: 'CLOSE', chainId: 4663, positionId: 'p1', poolIdentity: '4663:v4:uniswap:0x' + 'aa'.repeat(32), requestFingerprint: 'a'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
    store.reserveNonce(operation.operationId, '1');
    store.transition(operation.operationId, 'PREPARED', 'SIGNED', { transactionHash: '0x' + '22'.repeat(32), broadcastStatus: 'NOT_ATTEMPTED' });
    store.transition(operation.operationId, 'SIGNED', 'BROADCAST_KNOWN', { transactionHash: '0x' + '22'.repeat(32), broadcastStatus: 'KNOWN' });
    store.transition(operation.operationId, 'BROADCAST_KNOWN', 'RECEIPT_PENDING');
    store.transition(operation.operationId, 'RECEIPT_PENDING', 'CONFIRMED', { receipt: { blockHash: '0x' + '33'.repeat(32), blockNumber: '42', status: 'success', confirmations: 3 }, finality: 'CONFIRMED', reconciliation: 'COMPLETE' });
    store.transition(operation.operationId, 'CONFIRMED', 'TERMINAL');
    const records = store.all(); assert.equal(buildEvidenceHandoff(records).length, 1);
    await writeEvidenceHandoff(file, records, { privateKey }); assert.equal((await readEvidenceHandoff(file, { publicKey })).length, 1);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await assert.rejects(() => readEvidenceHandoff(file, { publicKey: other }), /EVIDENCE_HANDOFF_INVALID/);
    await assert.rejects(() => readEvidenceHandoff(file), /EVIDENCE_HANDOFF_INVALID|EVIDENCE_SIGNING_KEY_REQUIRED/);
    const parsed = JSON.parse(await readFile(file, 'utf8')); parsed.records[0].positionId = 'tampered'; await writeFile(file, JSON.stringify(parsed));
    await assert.rejects(() => readEvidenceHandoff(file, { publicKey }), /EVIDENCE_HANDOFF_INVALID/);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('blocked operation retains idempotency and nonce reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-blocked-'));
  try {
    const store = new OperationStore(join(root, 'operations.db'));
    const record = store.create({ idempotencyKey: 'blocked', type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'b'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
    store.reserveNonce(record.operationId, '9'); store.transition(record.operationId, 'PREPARED', 'BLOCKED', { reconciliation: 'REQUIRED' });
    assert.equal(store.create({ idempotencyKey: 'blocked', type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'b'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null }).state, 'BLOCKED');
    assert.throws(() => store.create({ idempotencyKey: 'other', type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'c'.repeat(64), signerAddress: signer, nonce: '9', transactionHash: null }), /UNIQUE|constraint/i);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
