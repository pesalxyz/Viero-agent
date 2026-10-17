#!/usr/bin/env node
/** Read-only local recovery evidence. Never performs Relay status calls or execution. */
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
if (!file) throw new Error('usage: inspect-relay-store.mjs DATABASE');
const database = new DatabaseSync(file, { readOnly: true });
try {
  const version = database.prepare('PRAGMA user_version').get();
  if (Number(version?.user_version ?? 0) !== 2) throw new Error('unsupported relay store schema');
  const rows = database.prepare("SELECT operation_id,kind,chain_id,state,operation_context,token_in,token_out,amount_raw,request_ids,transaction_hashes,receipts_json,created_at,updated_at FROM relay_operations ORDER BY created_at DESC LIMIT 100").all();
  console.log(JSON.stringify(rows.map(row => ({ operationId: row.operation_id, kind: row.kind, chainId: row.chain_id,
    state: row.state, context: row.operation_context, tokenIn: row.token_in, tokenOut: row.token_out, amountRaw: row.amount_raw,
    requestIds: JSON.parse(row.request_ids), transactionHashes: JSON.parse(row.transaction_hashes), receipts: JSON.parse(row.receipts_json),
    createdAt: row.created_at, updatedAt: row.updated_at })), null, 2));
} finally { database.close(); }
