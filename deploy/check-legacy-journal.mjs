#!/usr/bin/env node
/** Read-only legacy journal inventory. Ambiguity requires human reconciliation. */
import { readFile } from 'node:fs/promises';
const file = process.argv[2];
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
if (unknown || pending.size) throw new Error(`LEGACY_JOURNAL_RECONCILIATION_REQUIRED: unknown=${unknown} pending=${pending.size}`);
console.log(`legacy journal syntactically valid; confirmed=${confirmed}; unresolved=0`);
