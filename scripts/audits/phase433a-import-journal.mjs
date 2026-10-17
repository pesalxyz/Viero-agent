#!/usr/bin/env node
/** Dry-run only: reads legacy JSONL and emits deterministic import candidates. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) { console.error('usage: node phase433a-import-journal.mjs JOURNAL.jsonl'); process.exit(64); }
const lines = (await readFile(file, 'utf8')).split('\n');
const candidates = [], errors = [];
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]; if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    const hash = typeof record.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(record.hash) ? record.hash.toLowerCase() : null;
    const idempotencyKey = `legacy:${createHash('sha256').update(line).digest('hex')}`;
    candidates.push({ line: index + 1, idempotencyKey, hash, status: record.status ?? null, chainId: record.chainId ?? null,
      disposition: hash && record.chainId ? 'IMPORT_CANDIDATE_REQUIRES_REVIEW' : 'RECONCILIATION_REQUIRED' });
  } catch { errors.push({ line: index + 1, disposition: 'RECONCILIATION_REQUIRED', reason: 'MALFORMED_JSON_PRESERVED' }); }
}
console.log(JSON.stringify({ dryRun: true, source: file, candidates, errors, writes: 0, transactions: 0 }, null, 2));
