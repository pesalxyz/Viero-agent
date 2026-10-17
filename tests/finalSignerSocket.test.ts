import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SignerOperationStore } from '../src/viero/storage/signerOperationStore.js';

const worker = join(process.cwd(), 'tests/finalSignerSocketWorker.ts');
function start(root: string, boundary = 'normal') {
  const socket = join(root, 'signer.sock'), database = join(root, 'operations.db'), payload = join(root, 'request.json');
  const child = spawn(process.execPath, ['--import', 'tsx', worker, socket, database, payload, boundary], {
    cwd: process.cwd(), env: { ...process.env, VIERO_EVIDENCE_CACHE_FILE: join(root, 'evidence.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, socket, database, payload };
}
async function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`SOCKET_START_TIMEOUT:${out}:${errors}`)), 8000);
    child.stdout?.on('data', chunk => { out += String(chunk); const match = out.match(/SIGNER_SOCKET_READY (\w+)/); if (match) { clearTimeout(timer); resolve(match[1]!); } });
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`SOCKET_EXIT:${code}:${out}:${errors}`)); });
  });
}
function request(socketPath: string, route: string, body?: unknown): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let response = ''; res.on('data', chunk => { response += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, value: JSON.parse(response) }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('REQUEST_TIMEOUT'))); req.end(payload);
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const fallback = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
  try { await exited; } finally { clearTimeout(fallback); }
}
async function waitExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

test('valid open, claim, close, and emergency close traverse production signer routes with fake RPC', async () => {
  for (const emergency of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'viero-final-socket-'));
    const { child, socket, database, payload } = start(root);
    try {
      assert.equal(await ready(child), 'READY');
      const input = JSON.parse(await readFile(payload, 'utf8'));
      const opened = await request(socket, '/v1/open', input);
      assert.equal(opened.status, 200, JSON.stringify(opened.value));
      assert.equal(opened.value.value.status, 'open');
      assert.ok(opened.value.transactions.some((tx: any) => tx.action === 'mint'));
      const claimed = await request(socket, '/v1/claim', { position: opened.value.value });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.value));
      const closed = await request(socket, '/v1/close', { position: claimed.value.value,
        observation: input.observation, policy: input.policy, emergency });
      assert.equal(closed.status, 200, JSON.stringify(closed.value));
      assert.equal(closed.value.value.status, 'closed');
      const store = new SignerOperationStore(database);
      try {
        assert.equal(store.unresolved().length, 0);
        assert.ok(store.all().some(record => record.type === (emergency ? 'EMERGENCY_CLOSE' : 'CLOSE')));
      } finally { store.close(); }
    } finally { await stop(child); await rm(root, { recursive: true, force: true }); }
  }
});

test('V4 approval, Permit2, mint, claim, and close traverse production Unix-socket routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-v4-socket-'));
  const { child, socket, database, payload } = start(root, 'v4-normal');
  try {
    assert.equal(await ready(child), 'READY');
    const input = JSON.parse(await readFile(payload, 'utf8'));
    const opened = await request(socket, '/v1/open', input);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    assert.equal(opened.value.value.pool.protocol, 'v4');
    assert.ok(opened.value.transactions.some((tx: any) => tx.action === 'approve'));
    assert.ok(opened.value.transactions.some((tx: any) => tx.action === 'mint'));
    const mintTx = opened.value.transactions.find((tx: any) => tx.action === 'mint');
    assert.equal((await request(socket, '/v1/ack-position', { transactionHash: mintTx.hash, positionId: opened.value.value.id })).status, 200);
    const claimed = await request(socket, '/v1/claim', { position: opened.value.value });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.value));
    const closed = await request(socket, '/v1/close', { position: claimed.value.value,
      observation: input.observation, policy: input.policy });
    assert.equal(closed.status, 200, JSON.stringify(closed.value));
    assert.equal(closed.value.value.status, 'closed');
    const store = new SignerOperationStore(database);
    try {
      assert.equal(store.unresolved().length, 0);
      assert.ok(store.all().some(record => record.type === 'CLOSE'));
    } finally { store.close(); }
    await stop(child);
    const restart = start(root, 'v4-normal');
    try { assert.equal(await ready(restart.child), 'READY'); }
    finally { await stop(restart.child); }
  } finally { await stop(child); await rm(root, { recursive: true, force: true }); }
});

test('native-quote entry wraps before approval and mint, then closes through the signer socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-wrap-socket-'));
  const { child, socket, database, payload } = start(root, 'wrap-normal');
  try {
    assert.equal(await ready(child), 'READY');
    const input = JSON.parse(await readFile(payload, 'utf8'));
    assert.equal(input.plan.quoteAsset, 'NATIVE');
    const opened = await request(socket, '/v1/open', input);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    const actions = opened.value.transactions.map((tx: any) => tx.action);
    assert.ok(actions.indexOf('wrap') >= 0 && actions.indexOf('wrap') < actions.indexOf('mint'));
    assert.ok(actions.indexOf('approve') >= 0 && actions.indexOf('approve') < actions.indexOf('mint'));
    const closed = await request(socket, '/v1/close', { position: opened.value.value,
      observation: input.observation, policy: input.policy });
    assert.equal(closed.status, 200, JSON.stringify(closed.value));
    const store = new SignerOperationStore(database);
    try { assert.equal(store.unresolved().length, 0); } finally { store.close(); }
  } finally { await stop(child); await rm(root, { recursive: true, force: true }); }
});

test('valid signer request crashes after durable intent and restart gates replacement execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-socket-crash-'));
  try {
    let run = start(root, 'after-prepared');
    assert.equal(await ready(run.child), 'READY');
    const input = JSON.parse(await readFile(run.payload, 'utf8'));
    await request(run.socket, '/v1/open', input).catch(() => undefined);
    await waitExit(run.child);
    const store = new SignerOperationStore(run.database);
    try { assert.equal(store.unresolved().length, 1); assert.equal(store.unresolved()[0]?.state, 'PREPARED'); }
    finally { store.close(); }
    run = start(root);
    assert.equal(await ready(run.child), 'RECONCILIATION_REQUIRED');
    assert.equal((await request(run.socket, '/v1/open', input)).status, 503);
    await stop(run.child);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ambiguous broadcast remains blocked; known-hash receipt timeout reconciles without replacement', async () => {
  for (const [boundary, expected] of [['broadcast-unknown', 'RECONCILIATION_REQUIRED'], ['receipt-timeout', 'READY']] as const) {
    const root = await mkdtemp(join(tmpdir(), 'viero-final-socket-ambiguous-'));
    try {
      let run = start(root, boundary);
      assert.equal(await ready(run.child), 'READY');
      const input = JSON.parse(await readFile(run.payload, 'utf8'));
      assert.equal((await request(run.socket, '/v1/open', input)).status, 503);
      await stop(run.child);
      run = start(root);
      assert.equal(await ready(run.child), expected);
      assert.equal((await request(run.socket, '/v1/open', input)).status, 503);
      const store = new SignerOperationStore(run.database);
      try { assert.equal(store.all().length, 1); } finally { store.close(); }
      await stop(run.child);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('valid socket request survives all remaining durable crash boundaries without duplicate operations', async () => {
  const cases = [
    ['before-prepared', null, 'READY'], ['after-nonce', 'PREPARED', 'RECONCILIATION_REQUIRED'],
    ['after-signed', 'SIGNED', 'RECONCILIATION_REQUIRED'], ['before-broadcast', 'SIGNED', 'RECONCILIATION_REQUIRED'],
    ['after-broadcast-ack', 'SIGNED', 'READY'], ['receipt-crash', 'RECEIPT_PENDING', 'READY'],
    ['after-confirmed', 'CONFIRMED', 'READY'],
  ] as const;
  for (const [boundary, state, expectedReadiness] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'viero-final-socket-boundary-'));
    try {
      let run = start(root, boundary);
      assert.equal(await ready(run.child), 'READY', boundary);
      const input = JSON.parse(await readFile(run.payload, 'utf8'));
      await request(run.socket, '/v1/open', input).catch(() => undefined);
      await waitExit(run.child);
      const before = new SignerOperationStore(run.database);
      try {
        assert.equal(before.all().length, state ? 1 : 0, boundary);
        if (state) assert.equal(before.all()[0]?.state, state, boundary);
      } finally { before.close(); }
      run = start(root);
      assert.equal(await ready(run.child), expectedReadiness, boundary);
      if (state) {
        assert.equal((await request(run.socket, '/v1/open', input)).status, 503, boundary);
        const after = new SignerOperationStore(run.database);
        try { assert.equal(after.all().length, 1, boundary); } finally { after.close(); }
      }
      await stop(run.child);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('confirmed mint crash before position identity is persisted gates signer startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-mint-projection-'));
  let run = start(root, 'mint-after-confirmed');
  try {
    assert.equal(await ready(run.child), 'READY');
    const input = JSON.parse(await readFile(run.payload, 'utf8'));
    await request(run.socket, '/v1/open', input).catch(() => undefined);
    await waitExit(run.child);
    const before = new SignerOperationStore(run.database);
    try { assert.ok(before.all().some(record => record.type === 'OPEN' && record.poolIdentity
      && record.state === 'CONFIRMED' && !record.positionId)); }
    finally { before.close(); }
    run = start(root);
    assert.equal(await ready(run.child), 'RECONCILIATION_REQUIRED');
    assert.equal((await request(run.socket, '/v1/open', input)).status, 503);
  } finally { await stop(run.child); await rm(root, { recursive: true, force: true }); }
});

test('confirmed mint projection acknowledgement is idempotent across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-mint-ack-'));
  try {
    let run = start(root, 'after-position-evidence');
    assert.equal(await ready(run.child), 'READY');
    const input = JSON.parse(await readFile(run.payload, 'utf8'));
    await request(run.socket, '/v1/open', input).catch(() => undefined);
    await waitExit(run.child);
    run = start(root);
    assert.equal(await ready(run.child), 'RECONCILIATION_REQUIRED');
    const recovery = await request(run.socket, '/v1/recovery/open-positions');
    assert.equal(recovery.status, 200); const evidence = recovery.value[0].positionEvidence;
    assert.equal((await request(run.socket, '/v1/ack-position', { transactionHash: recovery.value[0].transactionHash, positionId: evidence.positionId })).status, 200);
    await stop(run.child); run = start(root); assert.equal(await ready(run.child), 'READY');
    assert.equal((await request(run.socket, '/v1/open', input)).status, 503);
    await stop(run.child);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('close rejects a fresh canonical token identity mismatch before signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-close-identity-'));
  const run = start(root, 'close-identity-mismatch');
  try {
    assert.equal(await ready(run.child), 'READY');
    const input = JSON.parse(await readFile(run.payload, 'utf8'));
    const opened = await request(run.socket, '/v1/open', input);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    const before = new SignerOperationStore(run.database);
    const operationCount = before.all().length; before.close();
    const closed = await request(run.socket, '/v1/close', { position: opened.value.value,
      observation: input.observation, policy: input.policy });
    assert.equal(closed.status, 503);
    assert.match(closed.value.error, /CLOSE_POOL_IDENTITY_MISMATCH/);
    const after = new SignerOperationStore(run.database);
    try { assert.equal(after.all().length, operationCount); } finally { after.close(); }
  } finally { await stop(run.child); await rm(root, { recursive: true, force: true }); }
});

test('emergency close remains possible with zero active pool liquidity after fresh identity verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-final-zero-active-'));
  const run = start(root, 'zero-active-liquidity');
  try {
    assert.equal(await ready(run.child), 'READY');
    const input = JSON.parse(await readFile(run.payload, 'utf8'));
    const opened = await request(run.socket, '/v1/open', input);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    const closed = await request(run.socket, '/v1/close', { position: opened.value.value,
      observation: input.observation, policy: input.policy, emergency: true });
    assert.equal(closed.status, 200, JSON.stringify(closed.value));
    assert.equal(closed.value.value.status, 'closed');
  } finally { await stop(run.child); await rm(root, { recursive: true, force: true }); }
});
