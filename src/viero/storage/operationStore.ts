import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';

export const OPERATION_SCHEMA_VERSION = 2 as const;
export type OperationType = 'OPEN' | 'CLOSE' | 'CLAIM' | 'EMERGENCY_CLOSE' | 'RELAY_ACQUIRE' | 'NORMALIZE';
export type OperationState = 'PREPARED' | 'SIGNED' | 'BROADCAST_UNKNOWN' | 'BROADCAST_KNOWN' | 'RECEIPT_PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED' | 'TERMINAL' | 'BLOCKED';
export type BroadcastStatus = 'NOT_ATTEMPTED' | 'UNKNOWN' | 'KNOWN';
export type Finality = 'UNCHECKED' | 'CONFIRMED' | 'REORG_SUSPECTED';
export type Reconciliation = 'NONE' | 'REQUIRED' | 'IN_PROGRESS' | 'COMPLETE';

export type ReceiptEvidence = { blockHash?: string; blockNumber?: string; status?: 'success' | 'reverted'; confirmations?: number };
export type OperationRecord = {
  schemaVersion: 2; operationId: string; idempotencyKey: string; type: OperationType; chainId: number;
  positionId: string | null; poolIdentity: string | null; requestFingerprint: string; signerAddress: string;
  nonce: string | null; transactionHash: string | null; broadcastStatus: BroadcastStatus;
  receipt: ReceiptEvidence | null; finality: Finality; reconciliation: Reconciliation;
  /** Non-secret, signer-authored workflow context/evidence. */
  context: Record<string, unknown> | null; positionEvidence: Record<string, unknown> | null; projectionAckAt: number | null;
  state: OperationState; createdAt: number; updatedAt: number;
};
export type CloseWorkflow = { workflowId: string; chainId: number; positionId: string; poolIdentity: string; protocol: 'v3' | 'v4'; removeOperationId: string | null; collectOperationId: string | null; state: 'REMOVE_PENDING' | 'REMOVE_CONFIRMED' | 'COLLECT_PENDING' | 'COMPLETE' | 'BLOCKED'; createdAt: number; updatedAt: number };

const operationTypes = new Set<OperationType>(['OPEN', 'CLOSE', 'CLAIM', 'EMERGENCY_CLOSE', 'RELAY_ACQUIRE', 'NORMALIZE']);
const states = new Set<OperationState>(['PREPARED', 'SIGNED', 'BROADCAST_UNKNOWN', 'BROADCAST_KNOWN', 'RECEIPT_PENDING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED', 'TERMINAL', 'BLOCKED']);
const transitions: Record<OperationState, Set<OperationState>> = {
  PREPARED: new Set(['SIGNED', 'BLOCKED']), SIGNED: new Set(['BROADCAST_UNKNOWN', 'BROADCAST_KNOWN', 'BLOCKED']),
  BROADCAST_UNKNOWN: new Set(['BROADCAST_KNOWN', 'RECEIPT_PENDING', 'RECONCILIATION_REQUIRED', 'BLOCKED']),
  BROADCAST_KNOWN: new Set(['RECEIPT_PENDING', 'RECONCILIATION_REQUIRED', 'BLOCKED']),
  RECEIPT_PENDING: new Set(['CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED', 'BLOCKED']),
  CONFIRMED: new Set(['TERMINAL', 'RECONCILIATION_REQUIRED', 'BLOCKED']),
  FAILED: new Set(['TERMINAL', 'RECONCILIATION_REQUIRED', 'BLOCKED']),
  RECONCILIATION_REQUIRED: new Set(['BROADCAST_KNOWN', 'RECEIPT_PENDING', 'CONFIRMED', 'TERMINAL', 'BLOCKED']),
  TERMINAL: new Set(), BLOCKED: new Set(['RECONCILIATION_REQUIRED']),
};

function now() { return Date.now() / 1000; }
function validAddress(value: string) { return /^0x[0-9a-fA-F]{40}$/.test(value); }
function validFingerprint(value: string) { return /^[0-9a-fA-F]{64}$/.test(value.replace(/^0x/, '')); }
export function decodeOperationRow(row: any): OperationRecord {
  if (!row || (row.schema_version !== 1 && row.schema_version !== 2) || !operationTypes.has(row.type) || !states.has(row.state) || !validFingerprint(row.request_fingerprint) || !validAddress(row.signer_address)) throw new Error('OPERATION_RECORD_CORRUPT');
  let receipt: ReceiptEvidence | null = null;
  if (row.receipt_json !== null) { try { receipt = JSON.parse(row.receipt_json); } catch { throw new Error('OPERATION_RECEIPT_CORRUPT'); } }
  const parseObject = (value: unknown) => { if (value === null || value === undefined) return null; try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null; } catch { throw new Error('OPERATION_CONTEXT_CORRUPT'); } };
  return { schemaVersion: 2, operationId: row.operation_id, idempotencyKey: row.idempotency_key, type: row.type, chainId: row.chain_id,
    positionId: row.position_id, poolIdentity: row.pool_identity, requestFingerprint: row.request_fingerprint, signerAddress: row.signer_address,
    nonce: row.nonce, transactionHash: row.transaction_hash, broadcastStatus: row.broadcast_status, receipt, finality: row.finality,
    reconciliation: row.reconciliation, context: parseObject(row.context_json), positionEvidence: parseObject(row.position_evidence_json), projectionAckAt: row.projection_ack_at ?? null,
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class OperationStore {
  readonly database: DatabaseSync;
  constructor(readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    this.withBusyRetry(() => this.database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;'));
    this.withBusyRetry(() => this.migrate());
  }
  private withBusyRetry<T>(work: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try { return work(); }
      catch (error) {
        if (attempt >= 100 || !/database is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : String(error))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  private migrate() {
    this.database.exec('CREATE TABLE IF NOT EXISTS operation_migrations (version INTEGER PRIMARY KEY, applied_at REAL NOT NULL);');
    const row = this.database.prepare('SELECT MAX(version) AS version FROM operation_migrations').get() as { version?: number | null };
    if ((row.version ?? 0) > OPERATION_SCHEMA_VERSION) throw new Error('OPERATION_SCHEMA_VERSION_UNSUPPORTED');
    if ((row.version ?? 0) === 0) {
      this.database.exec(`CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
        type TEXT NOT NULL, chain_id INTEGER NOT NULL, position_id TEXT, pool_identity TEXT,
        request_fingerprint TEXT NOT NULL, signer_address TEXT NOT NULL, nonce TEXT, transaction_hash TEXT,
        broadcast_status TEXT NOT NULL, receipt_json TEXT, finality TEXT NOT NULL,
        reconciliation TEXT NOT NULL, context_json TEXT, position_evidence_json TEXT, projection_ack_at REAL, state TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        CHECK (schema_version IN (1,2))
      ) STRICT;
      CREATE UNIQUE INDEX operations_chain_signer_nonce ON operations(chain_id, signer_address, nonce) WHERE nonce IS NOT NULL;
      CREATE INDEX operations_unresolved ON operations(state) WHERE state NOT IN ('TERMINAL', 'FAILED');
      INSERT INTO operation_migrations(version, applied_at) VALUES (1, ${now()});`);
    }
    const version = (this.database.prepare('SELECT MAX(version) AS version FROM operation_migrations').get() as { version?: number | null }).version ?? 0;
    if (version === 1) {
      const columns = new Set((this.database.prepare('PRAGMA table_info(operations)').all() as any[]).map(row => row.name));
      if (!columns.has('context_json')) this.database.exec('ALTER TABLE operations ADD COLUMN context_json TEXT');
      if (!columns.has('position_evidence_json')) this.database.exec('ALTER TABLE operations ADD COLUMN position_evidence_json TEXT');
      if (!columns.has('projection_ack_at')) this.database.exec('ALTER TABLE operations ADD COLUMN projection_ack_at REAL');
      this.database.exec(`CREATE TABLE IF NOT EXISTS close_workflows (
          workflow_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, position_id TEXT NOT NULL,
          pool_identity TEXT NOT NULL, protocol TEXT NOT NULL, remove_operation_id TEXT,
          collect_operation_id TEXT, state TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
        ) STRICT;
        INSERT INTO operation_migrations(version, applied_at) VALUES (2, ${now()});`);
    }
  }
  private transaction<T>(work: () => T): T { this.database.exec('BEGIN IMMEDIATE'); try { const result = work(); this.database.exec('COMMIT'); this.fsync(); return result; } catch (error) { this.database.exec('ROLLBACK'); throw error; } }
  private fsync() { const fd = openSync(this.filename, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  create(input: Omit<OperationRecord, 'schemaVersion' | 'operationId' | 'state' | 'broadcastStatus' | 'receipt' | 'finality' | 'reconciliation' | 'createdAt' | 'updatedAt' | 'context' | 'positionEvidence' | 'projectionAckAt'> & { operationId?: string; context?: Record<string, unknown> | null }): OperationRecord {
    if (!operationTypes.has(input.type) || !validAddress(input.signerAddress) || !validFingerprint(input.requestFingerprint)) throw new Error('OPERATION_INPUT_INVALID');
    const operationId = input.operationId ?? randomUUID(), timestamp = now();
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey) as any;
      if (existing) {
        const record = decodeOperationRow(existing);
        if (record.requestFingerprint !== input.requestFingerprint) throw new Error('OPERATION_IDEMPOTENCY_CONFLICT');
        return record;
      }
      this.database.prepare(`INSERT INTO operations(operation_id,idempotency_key,schema_version,type,chain_id,position_id,pool_identity,request_fingerprint,signer_address,nonce,transaction_hash,broadcast_status,receipt_json,finality,reconciliation,context_json,position_evidence_json,projection_ack_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(operationId, input.idempotencyKey, 1, input.type, input.chainId, input.positionId, input.poolIdentity, input.requestFingerprint, input.signerAddress, input.nonce, input.transactionHash, 'NOT_ATTEMPTED', null, 'UNCHECKED', 'NONE', input.context ? JSON.stringify(input.context) : null, null, null, 'PREPARED', timestamp, timestamp);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
    });
  }
  /** Execution-only creation. The conflict check and insert share one SQLite write transaction. */
  createExclusive(input: Parameters<OperationStore['create']>[0]): OperationRecord {
    if (!operationTypes.has(input.type) || !validAddress(input.signerAddress) || !validFingerprint(input.requestFingerprint)) throw new Error('OPERATION_INPUT_INVALID');
    return this.transaction(() => {
      if (this.database.prepare('SELECT 1 FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey)) throw new Error('OPERATION_UNRESOLVED');
      if (this.database.prepare("SELECT 1 FROM operations WHERE chain_id = ? AND lower(signer_address) = lower(?) AND state NOT IN ('TERMINAL','FAILED') LIMIT 1")
        .get(input.chainId, input.signerAddress)) throw new Error('OPERATION_UNRESOLVED');
      const operationId = input.operationId ?? randomUUID(), timestamp = now();
      this.database.prepare(`INSERT INTO operations(operation_id,idempotency_key,schema_version,type,chain_id,position_id,pool_identity,request_fingerprint,signer_address,nonce,transaction_hash,broadcast_status,receipt_json,finality,reconciliation,context_json,position_evidence_json,projection_ack_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(operationId, input.idempotencyKey, 1, input.type, input.chainId, input.positionId, input.poolIdentity, input.requestFingerprint, input.signerAddress, input.nonce, input.transactionHash, 'NOT_ATTEMPTED', null, 'UNCHECKED', 'NONE', input.context ? JSON.stringify(input.context) : null, null, null, 'PREPARED', timestamp, timestamp);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
    });
  }
  reserveNonce(operationId: string, nonce: string): OperationRecord {
    if (!/^\d+$/.test(nonce)) throw new Error('OPERATION_NONCE_INVALID');
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!current || current.state !== 'PREPARED') throw new Error('OPERATION_NONCE_RESERVATION_FAILED');
      if (current.nonce !== null && current.nonce !== nonce) throw new Error('OPERATION_NONCE_CONFLICT');
      this.database.prepare('UPDATE operations SET nonce=?,updated_at=? WHERE operation_id=? AND state=?').run(nonce, now(), operationId, 'PREPARED');
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
    });
  }
  get(operationId: string): OperationRecord | null { const row = this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId) as any; return row ? decodeOperationRow(row) : null; }
  findByTransactionHash(transactionHash: string): OperationRecord | null {
    const row = this.database.prepare('SELECT * FROM operations WHERE transaction_hash = ? ORDER BY updated_at DESC LIMIT 1').get(transactionHash) as any;
    return row ? decodeOperationRow(row) : null;
  }
  annotate(operationId: string, patch: Pick<OperationRecord, 'positionId' | 'poolIdentity'>): OperationRecord {
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!current) throw new Error('OPERATION_NOT_FOUND');
      this.database.prepare('UPDATE operations SET position_id=?,pool_identity=?,updated_at=? WHERE operation_id=?').run(patch.positionId, patch.poolIdentity, now(), operationId);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
    });
  }
  recordPositionEvidence(operationId: string, evidence: Record<string, unknown>): OperationRecord {
    return this.transaction(() => {
      const current = this.get(operationId); if (!current || current.type !== 'OPEN' || current.state !== 'CONFIRMED' && current.state !== 'TERMINAL') throw new Error('POSITION_EVIDENCE_NOT_ALLOWED');
      this.database.prepare('UPDATE operations SET position_evidence_json=?,position_id=?,pool_identity=?,updated_at=? WHERE operation_id=?').run(JSON.stringify(evidence), String(evidence.positionId), String(evidence.poolIdentity), now(), operationId);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id=?').get(operationId));
    });
  }
  acknowledgePositionProjection(operationId: string, positionId: string, evidenceFingerprint: string): OperationRecord {
    if (!validFingerprint(evidenceFingerprint)) throw new Error('PROJECTION_ACK_FINGERPRINT_INVALID');
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!current || current.type !== 'OPEN' || !current.positionEvidence || current.positionEvidence.positionId !== positionId) throw new Error('PROJECTION_ACK_EVIDENCE_MISMATCH');
      const expected = keccak256(new TextEncoder().encode(JSON.stringify(current.positionEvidence)) as Uint8Array).slice(2);
      if (expected !== evidenceFingerprint.replace(/^0x/, '').toLowerCase()) throw new Error('PROJECTION_ACK_EVIDENCE_MISMATCH');
      this.database.prepare('UPDATE operations SET projection_ack_at=?,updated_at=? WHERE operation_id=?').run(now(), now(), operationId);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id=?').get(operationId));
    });
  }
  unacknowledgedOpenOperations() { return this.all().filter(item => item.type === 'OPEN' && item.poolIdentity && item.state === 'TERMINAL' && item.receipt?.status === 'success' && !item.projectionAckAt); }
  private decodeCloseWorkflow(row: any): CloseWorkflow { if (!row) throw new Error('CLOSE_WORKFLOW_NOT_FOUND'); return { workflowId: row.workflow_id, chainId: row.chain_id, positionId: row.position_id, poolIdentity: row.pool_identity, protocol: row.protocol, removeOperationId: row.remove_operation_id, collectOperationId: row.collect_operation_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }; }
  createCloseWorkflow(input: Omit<CloseWorkflow, 'removeOperationId' | 'collectOperationId' | 'state' | 'createdAt' | 'updatedAt'>) {
    return this.transaction(() => { const existing = this.database.prepare('SELECT * FROM close_workflows WHERE workflow_id=?').get(input.workflowId) as any; if (existing) return this.decodeCloseWorkflow(existing); const t = now(); this.database.prepare('INSERT INTO close_workflows(workflow_id,chain_id,position_id,pool_identity,protocol,remove_operation_id,collect_operation_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.workflowId,input.chainId,input.positionId,input.poolIdentity,input.protocol,null,null,'REMOVE_PENDING',t,t); return this.decodeCloseWorkflow(this.database.prepare('SELECT * FROM close_workflows WHERE workflow_id=?').get(input.workflowId)); });
  }
  getCloseWorkflow(workflowId: string) { const row = this.database.prepare('SELECT * FROM close_workflows WHERE workflow_id=?').get(workflowId) as any; return row ? this.decodeCloseWorkflow(row) : null; }
  updateCloseWorkflow(workflowId: string, patch: Partial<Pick<CloseWorkflow, 'removeOperationId' | 'collectOperationId' | 'state'>>) { return this.transaction(() => { const current = this.getCloseWorkflow(workflowId); if (!current) throw new Error('CLOSE_WORKFLOW_NOT_FOUND'); this.database.prepare('UPDATE close_workflows SET remove_operation_id=?,collect_operation_id=?,state=?,updated_at=? WHERE workflow_id=?').run(patch.removeOperationId ?? current.removeOperationId, patch.collectOperationId ?? current.collectOperationId, patch.state ?? current.state, now(), workflowId); return this.decodeCloseWorkflow(this.database.prepare('SELECT * FROM close_workflows WHERE workflow_id=?').get(workflowId)); }); }
  closeWorkflows() { return (this.database.prepare('SELECT * FROM close_workflows ORDER BY created_at').all() as any[]).map(row => this.decodeCloseWorkflow(row)); }
  transition(operationId: string, expected: OperationState, next: OperationState, patch: Partial<Pick<OperationRecord, 'nonce' | 'transactionHash' | 'broadcastStatus' | 'receipt' | 'finality' | 'reconciliation'>> = {}): OperationRecord {
    if (!states.has(next) || !transitions[expected]?.has(next)) throw new Error('OPERATION_TRANSITION_INVALID');
    return this.transaction(() => {
      const current = this.get(operationId); if (!current || current.state !== expected) throw new Error('OPERATION_COMPARE_AND_SET_FAILED');
      const timestamp = now(), receiptJson = patch.receipt === undefined ? JSON.stringify(current.receipt) : patch.receipt === null ? null : JSON.stringify(patch.receipt);
      this.database.prepare(`UPDATE operations SET state=?,nonce=?,transaction_hash=?,broadcast_status=?,receipt_json=?,finality=?,reconciliation=?,updated_at=? WHERE operation_id=? AND state=?`)
        .run(next, patch.nonce === undefined ? current.nonce : patch.nonce, patch.transactionHash === undefined ? current.transactionHash : patch.transactionHash,
          patch.broadcastStatus ?? current.broadcastStatus, receiptJson, patch.finality ?? current.finality, patch.reconciliation ?? current.reconciliation, timestamp, operationId, expected);
      return decodeOperationRow(this.database.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
    });
  }
  unresolved(): OperationRecord[] { return (this.database.prepare("SELECT * FROM operations WHERE state NOT IN ('TERMINAL','FAILED') ORDER BY created_at").all() as any[]).map(decodeOperationRow); }
  all(): OperationRecord[] { return (this.database.prepare('SELECT * FROM operations ORDER BY created_at').all() as any[]).map(decodeOperationRow); }
  close() { this.database.close(); }
}
