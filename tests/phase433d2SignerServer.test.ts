import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { SignerOperationStore } from '../src/viero/storage/signerOperationStore.js';

const source = join(process.cwd(), 'src/viero/execution/signerServer.ts');
const key = `0x${'11'.repeat(32)}`;
const signer = privateKeyToAccount(key as `0x${string}`).address;
function start(db: string, socket: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', source], { cwd: process.cwd(), env: { ...process.env, VIERO_EXECUTION_ENABLED: 'true', VIERO_SIGNER_PRIVATE_KEY: key, VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: db, VIERO_SIGNER_SOCKET: socket, VIERO_SIGNER_TX_JOURNAL: `${db}.journal` }, stdio: ['ignore', 'pipe', 'pipe'] });
  return child;
}
async function waitFor(child: ChildProcess, needle: string) {
  return new Promise<void>((resolve, reject) => {
    let output = '', errorOutput = '';
    const timer = setTimeout(() => reject(new Error(`SERVER_START_TIMEOUT:${output}`)), 5000);
    child.stdout?.on('data', chunk => { output += String(chunk); if (output.includes(needle)) { clearTimeout(timer); resolve(); } });
    child.stderr?.on('data', chunk => { errorOutput += String(chunk); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`SERVER_EXITED:${code}:${output}:${errorOutput}`)); });
  });
}
function request(socketPath: string, path: string, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers: method === 'POST' ? { 'content-type': 'application/json', 'content-length': '2' } : undefined }, res => { let body = ''; res.on('data', chunk => { body += String(chunk); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })); });
    req.on('error', reject); if (method === 'POST') req.end('{}'); else req.end();
  });
}
async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; if (!child.killed) child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
async function seed(db: string, state: 'PREPARED' | 'SIGNED' | 'BROADCAST_UNKNOWN' | 'RECEIPT_PENDING') {
  const store = new SignerOperationStore(db);
  const record = store.create({ idempotencyKey: state, type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'a'.repeat(64), signerAddress: signer, nonce: null, transactionHash: null });
  if (state !== 'PREPARED') store.transition(record.operationId, 'PREPARED', 'SIGNED', { transactionHash: null });
  if (state === 'BROADCAST_UNKNOWN') store.transition(record.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN' });
  if (state === 'RECEIPT_PENDING') store.transition(record.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN' });
  if (state === 'RECEIPT_PENDING') store.transition(record.operationId, 'BROADCAST_UNKNOWN', 'RECEIPT_PENDING', { reconciliation: 'IN_PROGRESS' });
  store.close();
}

test('actual signer server gates routes from recovery readiness and restarts safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-signer-server-'));
  try {
    const emptyDb = join(root, 'empty.db'), emptySocket = join(root, 'empty.sock');
    const initialized = new SignerOperationStore(emptyDb); initialized.close();
    let child = start(emptyDb, emptySocket); await waitFor(child, 'Viero signer listening');
    assert.equal((await request(emptySocket, '/v1/open')).status, 400); // READY: route reached schema validation
    assert.equal(JSON.parse((await request(emptySocket, '/health', 'GET')).body).recovery, 'READY');
    await stop(child); chmodSync(emptyDb, 0o600);
    child = start(emptyDb, emptySocket); await waitFor(child, 'Viero signer listening');
    assert.equal(JSON.parse((await request(emptySocket, '/health', 'GET')).body).recovery, 'READY'); await stop(child);

    for (const state of ['PREPARED', 'SIGNED', 'BROADCAST_UNKNOWN', 'RECEIPT_PENDING'] as const) {
      const db = join(root, `${state}.db`), socket = join(root, `${state}.sock`); await seed(db, state);
      child = start(db, socket); await waitFor(child, 'Viero signer listening');
      const health = JSON.parse((await request(socket, '/health', 'GET')).body); assert.equal(health.recovery, 'RECONCILIATION_REQUIRED', state);
      const gated = await request(socket, '/v1/open'); assert.equal(gated.status, 503, state); assert.match(gated.body, /SIGNER_RECOVERY_NOT_READY/); await stop(child);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt store fails signer startup and concurrent servers share safe readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-signer-server-concurrent-'));
  try {
    const corrupt = join(root, 'corrupt.db'); await writeFile(corrupt, 'not sqlite');
    const bad = start(corrupt, join(root, 'corrupt.sock')); const badCode = await new Promise<number | null>(resolve => bad.once('exit', resolve)); assert.notEqual(badCode, 0);
    const db = join(root, 'shared.db'), aSocket = join(root, 'a.sock'), bSocket = join(root, 'b.sock');
    const initialized = new SignerOperationStore(db); initialized.close();
    const a = start(db, aSocket), b = start(db, bSocket); await Promise.all([waitFor(a, 'Viero signer listening'), waitFor(b, 'Viero signer listening')]);
    assert.equal(JSON.parse((await request(aSocket, '/health', 'GET')).body).recovery, 'READY'); assert.equal(JSON.parse((await request(bSocket, '/health', 'GET')).body).recovery, 'READY');
    await Promise.all([stop(a), stop(b)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
