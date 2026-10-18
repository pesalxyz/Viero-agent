import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const hash = '0x' + 'ab'.repeat(32);
const blockHash = '0x' + 'cd'.repeat(32);
const journal = JSON.stringify({ status: 'broadcast', chainId: 4663, hash, at: 1 });
const disposition = (overrides: Record<string, unknown> = {}) => {
  const { operatorApproved = true, ...item } = overrides;
  return JSON.stringify({ version: 1, operatorApproved,
    reference: 'docs/deployment/viero-targeted-onchain-reconciliation.md', dispositions: [{ hash, chainId: 4663,
      receipt: { blockHash, blockNumber: '73390331', status: '0x0' }, confirmations: 100, classification: 'CONFIRMED_REVERT_CANONICAL', ...item }] });
};

async function run(journalText: string, dispositionText?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'viero-legacy-disposition-'));
  try {
    const j = join(dir, 'transactions.jsonl'); await writeFile(j, journalText);
    const args = [join(process.cwd(), 'deploy/check-legacy-journal.mjs'), j];
    if (dispositionText !== undefined) { const d = join(dir, 'disposition.json'); await writeFile(d, dispositionText); args.push(d); }
    return await new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn(process.execPath, args); let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x); child.on('close', code => resolve({ code: code ?? -1, output }));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('accepts exact approved canonical reverted disposition', async () => {
  const result = await run(journal, disposition()); assert.equal(result.code, 0); assert.match(result.output, /unresolved=0/);
});
test('rejects incorrect hash, chain, evidence, and missing approval', async () => {
  assert.notEqual((await run(journal, disposition({ hash: '0x' + 'ef'.repeat(32) }))).code, 0);
  assert.notEqual((await run(journal, disposition({ chainId: 56 }))).code, 0);
  assert.notEqual((await run(journal, disposition({ receipt: { blockHash, blockNumber: '73390331', status: '0x1' } }))).code, 0);
  assert.notEqual((await run(journal, disposition({ operatorApproved: false }))).code, 0);
});
test('rejects additional unresolved journal transactions and still requires disposition', async () => {
  const extra = JSON.stringify({ status: 'broadcast', chainId: 4663, hash: '0x' + '12'.repeat(32), at: 2 });
  assert.notEqual((await run(`${journal}\n${extra}`, disposition())).code, 0);
  assert.notEqual((await run(journal)).code, 0);
});
