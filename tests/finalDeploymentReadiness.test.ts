import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import { SignerOperationStore } from '../src/viero/storage/signerOperationStore.js';
import { RelayOperationStore } from '../src/viero/storage/relayOperationStore.js';
import { LiveExecutor } from '../src/viero/execution/executor.js';

const exec = promisify(execFile);
const deploy = join(process.cwd(), 'deploy');
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;
test('disposable stopped-state package backup/restore preserves signer, Relay, projection and legacy evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-deployment-'));
  const source = join(root, 'source'), restored = join(root, 'restored');
  try {
    const agentDir = join(source, 'var/lib/viero'), signerDir = join(source, 'var/lib/viero-signer');
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(signerDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentDir, 'strategy-state.json'), '{"version":1}\n', { mode: 0o600 });
    const signerDb = join(signerDir, 'operations.db'), relayDb = join(signerDir, 'relay-operations.db');
    const operations = new SignerOperationStore(signerDb);
    operations.create({ idempotencyKey: 'offline-recovery', type: 'OPEN', chainId: 4663,
      positionId: null, poolIdentity: null, requestFingerprint: 'a'.repeat(64), signerAddress: signer,
      nonce: null, transactionHash: null }); operations.close();
    const relay = new RelayOperationStore(relayDb);
    const rel = relay.begin({ key: 'b'.repeat(64), kind: 'NORMALIZE', chainId: 4663, signer,
      quoteFingerprint: 'c'.repeat(64), requestIds: ['offline-request'], context: 'position-1',
      tokenIn: `0x${'22'.repeat(20)}`, tokenOut: `0x${'33'.repeat(20)}`, amountRaw: '100' });
    relay.transition(rel.operationId, 'PREPARED', 'UNKNOWN'); relay.close();
    await writeFile(join(signerDir, 'transactions.jsonl'),
      `${JSON.stringify({ status: 'broadcast', hash: `0x${'d'.repeat(64)}` })}\n${JSON.stringify({ status: 'confirmed', hash: `0x${'d'.repeat(64)}` })}\n`, { mode: 0o600 });
    const archive = join(root, 'snapshot.tar');
    await exec('tar', ['-cf', archive, '-C', source, 'var/lib']);
    const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
    assert.equal(checksum.length, 64);
    await mkdir(restored); await exec('tar', ['-xf', archive, '-C', restored]);
    const restoredSigner = join(restored, 'var/lib/viero-signer');
    for (const [script, file] of [['check-state-schema.mjs', join(restored, 'var/lib/viero')],
      ['check-operation-store.mjs', join(restoredSigner, 'operations.db')],
      ['check-relay-store.mjs', join(restoredSigner, 'relay-operations.db')],
      ['check-legacy-journal.mjs', join(restoredSigner, 'transactions.jsonl')]] as const) {
      const result = await exec(process.execPath, [join(deploy, script), file]);
      assert.ok(result.stdout.length > 0, script);
    }
    assert.equal((await stat(join(restoredSigner, 'operations.db'))).mode & 0o077, 0);
    assert.equal((await stat(join(restoredSigner, 'relay-operations.db'))).mode & 0o077, 0);
    const executor = new LiveExecutor({ VIERO_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: join(restoredSigner, 'operations.db') });
    try { assert.equal((await executor.startupRecovery()).state, 'RECONCILIATION_REQUIRED'); }
    finally { executor.operationStore.close(); }
    const restoredRelay = new RelayOperationStore(join(restoredSigner, 'relay-operations.db'));
    try { assert.equal(restoredRelay.unresolved()[0]?.state, 'UNKNOWN'); } finally { restoredRelay.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('target-schema checkers reject incompatible SQLite and ambiguous legacy journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-migration-'));
  try {
    const signerDb = join(root, 'operations.db'), relayDb = join(root, 'relay.db'), journal = join(root, 'legacy.jsonl');
    new SignerOperationStore(signerDb).close(); new RelayOperationStore(relayDb).close();
    const db = new DatabaseSync(signerDb);
    db.exec('INSERT INTO operation_migrations(version,applied_at) VALUES(3,0)'); db.close();
    await assert.rejects(exec(process.execPath, [join(deploy, 'check-operation-store.mjs'), signerDb]));
    const relay = new DatabaseSync(relayDb); relay.exec('PRAGMA user_version=3'); relay.close();
    await assert.rejects(exec(process.execPath, [join(deploy, 'check-relay-store.mjs'), relayDb]));
    await writeFile(journal, '{"status":"broadcast-unknown"}\n');
    await assert.rejects(exec(process.execPath, [join(deploy, 'check-legacy-journal.mjs'), journal]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer and rollback shell contracts cannot implicitly activate services', async () => {
  const installer = await readFile(join(deploy, 'install-release.sh'), 'utf8');
  const rollback = await readFile(join(deploy, 'rollback-release.sh'), 'utf8');
  const passiveInstall = installer.split('if $start_service; then')[0]!;
  assert.doesNotMatch(passiveInstall, /systemctl\s+(?:start|restart|enable|stop|disable)\b/);
  assert.match(installer, /check-state-schema\.mjs/);
  assert.match(installer, /check-relay-store\.mjs/);
  assert.match(rollback, /"\$previous\/deploy\/check-state-schema\.mjs"/);
  assert.doesNotMatch(rollback, /systemctl\s+(?:start|restart|enable|stop|disable)\b/);
  await exec('bash', ['-n', join(deploy, 'install-release.sh')]);
  await exec('bash', ['-n', join(deploy, 'rollback-release.sh')]);
  await exec('bash', ['-n', join(deploy, 'backup-state.sh')]);
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major! > 24 || (major === 24 && minor! >= 15));
});
