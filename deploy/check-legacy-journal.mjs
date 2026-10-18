#!/usr/bin/env node
/** Read-only legacy journal inventory. Ambiguity requires human reconciliation. */
import { readFile } from 'node:fs/promises';
const file = process.argv[2];
const dispositionFile = process.argv[3];
if (!file) throw new Error('usage: check-legacy-journal.mjs JOURNAL');
const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
const pending = new Set(); let confirmed = 0, unknown = 0;
for (const [index, line] of lines.entries()) {
  let row;
  try { row = JSON.parse(line); } catch { throw new Error(`legacy journal malformed at line ${index + 1}`); }
  if (!row || typeof row !== 'object' || typeof row.status !== 'string') throw new Error(`legacy journal invalid at line ${index + 1}`);
  if (!['broadcast-unknown', 'broadcast', 'receipt-pending', 'confirmed'].includes(row.status)) { unknown++; continue; }
  if (row.status === 'broadcast-unknown') { unknown++; continue; }
  if (row.status === 'broadcast' || row.status === 'receipt-pending') {
    if (typeof row.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.hash)) { unknown++; continue; }
    pending.add(row.hash.toLowerCase());
  }
  if (row.status === 'confirmed') {
    if (typeof row.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.hash)) { unknown++; continue; }
    pending.delete(row.hash.toLowerCase()); confirmed++;
  }
}
let dispositions = [];
if (dispositionFile) {
  let parsed;
  try { parsed = JSON.parse(await readFile(dispositionFile, 'utf8')); }
  catch { throw new Error('LEGACY_DISPOSITION_INVALID_JSON'); }
  if (!parsed || parsed.version !== 1 || parsed.operatorApproved !== true
    || parsed.reference !== 'docs/deployment/viero-targeted-onchain-reconciliation.md'
    || !Array.isArray(parsed.dispositions) || parsed.dispositions.length > 32) {
    throw new Error('LEGACY_DISPOSITION_SCHEMA_INVALID');
  }
  const seen = new Set();
  for (const item of parsed.dispositions) {
    const hash = typeof item?.hash === 'string' ? item.hash.toLowerCase() : '';
    const blockHash = typeof item?.receipt?.blockHash === 'string' ? item.receipt.blockHash.toLowerCase() : '';
    if (seen.has(hash) || !/^0x[0-9a-f]{64}$/.test(hash) || !Number.isInteger(item.chainId) || item.chainId < 1
      || !/^0x[0-9a-f]{64}$/.test(blockHash) || !/^\d+$/.test(String(item?.receipt?.blockNumber ?? ''))
      || item.receipt.status !== '0x0' || !Number.isInteger(item.confirmations) || item.confirmations < 3
      || item.classification !== 'CONFIRMED_REVERT_CANONICAL') throw new Error('LEGACY_DISPOSITION_EVIDENCE_INVALID');
    seen.add(hash);
    dispositions.push({ hash, chainId: item.chainId, blockHash, blockNumber: String(item.receipt.blockNumber), confirmations: item.confirmations });
  }
  for (const item of dispositions) {
    if (!pending.has(item.hash)) throw new Error('LEGACY_DISPOSITION_HASH_NOT_PENDING');
    const journalRow = lines.map(line => JSON.parse(line)).find(row => row.hash?.toLowerCase() === item.hash && row.chainId === item.chainId && row.status !== 'confirmed');
    if (!journalRow) throw new Error('LEGACY_DISPOSITION_CHAIN_MISMATCH');
    pending.delete(item.hash);
  }
}
if (unknown || pending.size) throw new Error(`LEGACY_JOURNAL_RECONCILIATION_REQUIRED: unknown=${unknown} pending=${pending.size}`);
console.log(`legacy journal syntactically valid; confirmed=${confirmed}; historical dispositions=${dispositions.length}; unresolved=0`);
