import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { OperationStore } from '../src/viero/storage/operationStore.js';

const worker = join(process.cwd(), 'tests/phase433d1SignerCrashWorker.ts');
function run(database: string, boundary: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, database, boundary], { cwd: process.cwd(), env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function states(database: string) { const store = new OperationStore(database); try { return store.all(); } finally { store.close(); } }

test('production signer/executor child crash boundaries remain durable and non-duplicating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-phase433d1-'));
  try {
    const cases: Array<[string, string]> = [['before-prepared', ''], ['after-prepared', 'PREPARED'], ['after-nonce', 'PREPARED'], ['after-signed', 'SIGNED'], ['before-broadcast', 'SIGNED'], ['after-broadcast-ack', 'SIGNED'], ['during-receipt', 'RECEIPT_PENDING'], ['after-confirmed', 'CONFIRMED']];
    for (const [boundary, expected] of cases) {
      const db = join(root, `${boundary}.db`); const result = await run(db, boundary);
      assert.equal(result.code, 17, boundary);
      const records = states(db); assert.ok(records.length <= 1, `${boundary} duplicate records`);
      if (expected) assert.equal(records[0]?.state, expected, boundary); else assert.equal(records.length, 0, boundary);
      if (boundary === 'after-nonce') assert.equal(records[0]?.nonce, '7');
      if (boundary === 'after-signed') assert.ok(records[0]?.transactionHash);
    }
    const ambiguous = join(root, 'ambiguous.db'); const ambiguousResult = await run(ambiguous, 'ambiguous-broadcast');
    assert.equal(ambiguousResult.code, 17); assert.equal(states(ambiguous)[0]?.state, 'BROADCAST_UNKNOWN');
    const normal = join(root, 'normal.db'); assert.equal((await run(normal, 'normal')).code, 0); assert.equal(states(normal)[0]?.state, 'TERMINAL');
    const recovery = await run(normal, 'recovery'); assert.equal(recovery.code, 0); assert.match(recovery.stdout, /"state":"READY"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent signer startup recovery does not duplicate reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-phase433d1-concurrent-'));
  try {
    const db = join(root, 'recovery.db'); assert.equal((await run(db, 'after-confirmed')).code, 17);
    const results = await Promise.all([run(db, 'recovery'), run(db, 'recovery')]);
    assert.ok(results.every(result => result.code === 0));
    assert.ok(results.every(result => /"state":"READY"/.test(result.stdout)), JSON.stringify(results));
    assert.equal(states(db).filter(record => record.state === 'TERMINAL').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
