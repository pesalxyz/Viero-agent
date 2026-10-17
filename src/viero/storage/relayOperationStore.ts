import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertSignerStorePathSafe } from './signerOperationStore.js';

export type RelayOperationState = 'PREPARED' | 'EXECUTING' | 'UNKNOWN' | 'COMPLETE';
export type RelayOperation = {
  operationId: string; key: string; kind: 'ACQUIRE' | 'NORMALIZE'; chainId: number;
  signer: string; state: RelayOperationState; quoteFingerprint: string;
  context: string; tokenIn: string; tokenOut: string; amountRaw: string;
  requestIds: string[]; transactionHashes: string[];
  receipts: Array<{ hash: string; blockNumber: string; blockHash: string; status: 'success' | 'reverted' }>;
  createdAt: number; updatedAt: number;
};

/** Signer-owned evidence for SDK-controlled transactions. UNKNOWN never authorizes a retry. */
export class RelayOperationStore {
  readonly database: DatabaseSync;
  constructor(readonly filename: string, role: 'signer' | 'agent' = 'signer') {
    if (role !== 'signer') throw new Error('RELAY_STORE_SIGNER_ONLY');
    assertSignerStorePathSafe(filename);
    this.database = new DatabaseSync(filename);
    const integrity = this.database.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('RELAY_STORE_INTEGRITY_FAILED');
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 2 || version.user_version === 1) throw new Error('RELAY_STORE_SCHEMA_UNSUPPORTED');
    this.database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS relay_operations (
      operation_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      chain_id INTEGER NOT NULL, signer TEXT NOT NULL, state TEXT NOT NULL,
      quote_fingerprint TEXT NOT NULL, operation_context TEXT NOT NULL, token_in TEXT NOT NULL,
      token_out TEXT NOT NULL, amount_raw TEXT NOT NULL,
      request_ids TEXT NOT NULL, transaction_hashes TEXT NOT NULL, receipts_json TEXT NOT NULL,
      created_at REAL NOT NULL, updated_at REAL NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS relay_unresolved ON relay_operations(chain_id, signer, state);`);
    if (version.user_version === 0) this.database.exec('PRAGMA user_version=2');
    chmodSync(filename, 0o600);
  }
  private durable<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      const fd = openSync(this.filename, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
  private row(row: any): RelayOperation {
    if (!row || !['PREPARED', 'EXECUTING', 'UNKNOWN', 'COMPLETE'].includes(row.state)
      || !['ACQUIRE', 'NORMALIZE'].includes(row.kind) || !/^0x[0-9a-fA-F]{40}$/.test(row.signer)
      || !/^[0-9a-f]{64}$/.test(row.quote_fingerprint)) throw new Error('RELAY_OPERATION_CORRUPT');
    const requestIds = JSON.parse(row.request_ids), transactionHashes = JSON.parse(row.transaction_hashes), receipts = JSON.parse(row.receipts_json);
    if (!Array.isArray(requestIds) || !requestIds.every((id: unknown) => typeof id === 'string' && id.length <= 256)
      || !Array.isArray(transactionHashes) || !transactionHashes.every((hash: unknown) => typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash))
      || !Array.isArray(receipts) || !receipts.every((receipt: any) => /^0x[0-9a-fA-F]{64}$/.test(receipt.hash)
        && /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) && /^\d+$/.test(receipt.blockNumber)
        && ['success', 'reverted'].includes(receipt.status))
      || typeof row.operation_context !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.token_in)
      || !/^0x[0-9a-fA-F]{40}$/.test(row.token_out) || !/^\d+$/.test(row.amount_raw)) throw new Error('RELAY_OPERATION_CORRUPT');
    return { operationId: row.operation_id, key: row.operation_key, kind: row.kind, chainId: row.chain_id,
      signer: row.signer, state: row.state, quoteFingerprint: row.quote_fingerprint,
      context: row.operation_context, tokenIn: row.token_in, tokenOut: row.token_out, amountRaw: row.amount_raw,
      requestIds, transactionHashes, receipts, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  begin(input: Pick<RelayOperation, 'key' | 'kind' | 'chainId' | 'signer' | 'quoteFingerprint' | 'requestIds' | 'context' | 'tokenIn' | 'tokenOut' | 'amountRaw'>): RelayOperation {
    if (!/^[0-9a-f]{64}$/.test(input.key) || !/^[0-9a-f]{64}$/.test(input.quoteFingerprint)
      || !/^0x[0-9a-fA-F]{40}$/.test(input.signer) || !['ACQUIRE', 'NORMALIZE'].includes(input.kind)
      || input.requestIds.length > 32 || !input.requestIds.every(id => typeof id === 'string' && id.length <= 256)
      || input.context.length > 256 || !/^0x[0-9a-fA-F]{40}$/.test(input.tokenIn)
      || !/^0x[0-9a-fA-F]{40}$/.test(input.tokenOut) || !/^\d+$/.test(input.amountRaw)) throw new Error('RELAY_OPERATION_INPUT_INVALID');
    return this.durable(() => {
      if (this.database.prepare('SELECT 1 FROM relay_operations WHERE operation_key=?').get(input.key)) throw new Error('RELAY_OPERATION_ALREADY_RECORDED');
      if (this.database.prepare("SELECT 1 FROM relay_operations WHERE chain_id=? AND lower(signer)=lower(?) AND state!='COMPLETE' LIMIT 1").get(input.chainId, input.signer)) throw new Error('RELAY_RECONCILIATION_REQUIRED');
      const operationId = randomUUID(), at = Date.now() / 1000;
      this.database.prepare(`INSERT INTO relay_operations(operation_id,operation_key,kind,chain_id,signer,state,quote_fingerprint,
        operation_context,token_in,token_out,amount_raw,request_ids,transaction_hashes,receipts_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId, input.key, input.kind,
        input.chainId, input.signer, 'PREPARED', input.quoteFingerprint, input.context, input.tokenIn,
        input.tokenOut, input.amountRaw, JSON.stringify(input.requestIds), '[]', '[]', at, at);
      return this.get(operationId)!;
    });
  }
  get(operationId: string): RelayOperation | null {
    const row = this.database.prepare('SELECT * FROM relay_operations WHERE operation_id=?').get(operationId);
    return row ? this.row(row) : null;
  }
  unresolved(): RelayOperation[] {
    return (this.database.prepare("SELECT * FROM relay_operations WHERE state!='COMPLETE' ORDER BY created_at").all() as any[]).map(row => this.row(row));
  }
  transition(operationId: string, expected: RelayOperationState, next: RelayOperationState): RelayOperation {
    if (!({ PREPARED: ['EXECUTING', 'UNKNOWN'], EXECUTING: ['UNKNOWN', 'COMPLETE'], UNKNOWN: [], COMPLETE: [] } as Record<RelayOperationState, RelayOperationState[]>)[expected].includes(next)) throw new Error('RELAY_TRANSITION_INVALID');
    return this.durable(() => {
      if (next === 'COMPLETE') {
        const current = this.get(operationId);
        if (!current?.transactionHashes.length || current.receipts.length !== current.transactionHashes.length
          || current.receipts.some(receipt => receipt.status !== 'success'
            || !current.transactionHashes.some(hash => hash.toLowerCase() === receipt.hash.toLowerCase()))) throw new Error('RELAY_RECEIPT_EVIDENCE_INCOMPLETE');
      }
      const result = this.database.prepare('UPDATE relay_operations SET state=?,updated_at=? WHERE operation_id=? AND state=?').run(next, Date.now() / 1000, operationId, expected);
      if (result.changes !== 1) throw new Error('RELAY_COMPARE_AND_SET_FAILED');
      return this.get(operationId)!;
    });
  }
  recordHashes(operationId: string, hashes: string[]): RelayOperation {
    if (!hashes.every(hash => /^0x[0-9a-fA-F]{64}$/.test(hash))) throw new Error('RELAY_HASH_INVALID');
    return this.durable(() => {
      const current = this.get(operationId);
      if (!current || current.state !== 'EXECUTING') throw new Error('RELAY_OPERATION_NOT_EXECUTING');
      const merged = [...new Set([...current.transactionHashes, ...hashes])];
      if (merged.length > 64) throw new Error('RELAY_HASH_CAPACITY');
      this.database.prepare('UPDATE relay_operations SET transaction_hashes=?,updated_at=? WHERE operation_id=?').run(JSON.stringify(merged), Date.now() / 1000, operationId);
      return this.get(operationId)!;
    });
  }
  recordReceipt(operationId: string, receipt: RelayOperation['receipts'][number]): RelayOperation {
    if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.hash) || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
      || !/^\d+$/.test(receipt.blockNumber) || !['success', 'reverted'].includes(receipt.status)) throw new Error('RELAY_RECEIPT_INVALID');
    return this.durable(() => {
      const current = this.get(operationId);
      if (!current || current.state !== 'EXECUTING' || !current.transactionHashes.some(hash => hash.toLowerCase() === receipt.hash.toLowerCase())) throw new Error('RELAY_RECEIPT_NOT_LINKED');
      const previous = current.receipts.find(item => item.hash.toLowerCase() === receipt.hash.toLowerCase());
      if (previous && (previous.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
        || previous.blockNumber !== receipt.blockNumber || previous.status !== receipt.status)) throw new Error('RELAY_RECEIPT_CONFLICT');
      const receipts = previous ? current.receipts : [...current.receipts, receipt];
      this.database.prepare('UPDATE relay_operations SET receipts_json=?,updated_at=? WHERE operation_id=?')
        .run(JSON.stringify(receipts), Date.now() / 1000, operationId);
      return this.get(operationId)!;
    });
  }
  close() { this.database.close(); }
}
