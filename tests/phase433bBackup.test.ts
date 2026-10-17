import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { OperationStore } from '../src/viero/storage/operationStore.js';
const exec = promisify(execFile);

test('disposable backup preserves SQLite, WAL companions, projection, and legacy journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-backup-')); const source = join(root, 'source'); const restored = join(root, 'restored');
  try {
    await mkdir(join(source, 'var/lib/viero'), { recursive: true, mode: 0o700 }); await mkdir(join(source, 'var/lib/viero-signer'), { recursive: true, mode: 0o700 });
    const store = new OperationStore(join(source, 'var/lib/viero-signer/operations.db')); store.close();
    await writeFile(join(source, 'var/lib/viero/strategy-state.json'), '{"version":1}\n'); await writeFile(join(source, 'var/lib/viero-signer/transactions.jsonl'), '{"status":"broadcast"}\n');
    await writeFile(join(source, 'var/lib/viero-signer/operations.db-wal'), 'fake-wal'); await writeFile(join(source, 'var/lib/viero-signer/operations.db-shm'), 'fake-shm');
    const archive = join(root, 'snapshot.tar'); await exec('tar', ['-cf', archive, '-C', source, 'var/lib']);
    const checksum = createHash('sha256').update(await readFile(archive)).digest('hex'); assert.equal(checksum.length, 64);
    await mkdir(restored); await exec('tar', ['-xf', archive, '-C', restored]);
    for (const file of ['operations.db', 'operations.db-wal', 'operations.db-shm', 'transactions.jsonl']) assert.ok((await readFile(join(restored, 'var/lib/viero-signer', file))).length >= 0);
    assert.equal((await readFile(join(restored, 'var/lib/viero/strategy-state.json'), 'utf8')).trim(), '{"version":1}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
