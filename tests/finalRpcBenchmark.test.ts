import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
test('equivalent offline screening evidence yields fewer RPC reads without changed results', async () => {
  const script = join(process.cwd(), 'scripts/audits/final-offline-rpc-benchmark.ts');
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd() });
  const result = JSON.parse(stdout);
  assert.equal(result.correctnessDifferences, 0);
  assert.equal(result.baseline.resultDigest, result.optimized.resultDigest);
  assert.equal(result.baseline.logical, 180);
  assert.equal(result.optimized.logical, 118);
  assert.equal(result.avoidedLogical, 62);
  assert.equal(result.avoidedEstimatedCU, 1360);
  assert.equal(result.baseline.methods.eth_getLogs, result.optimized.methods.eth_getLogs);
  assert.equal(result.optimized.cache.creationHits, 2);
  assert.equal(result.optimized.memo.logicalReadsAvoided, 12);
  assert.ok(result.optimized.boundaryEntries <= 128);
  assert.ok(result.optimized.memoEntries <= 8);
});
