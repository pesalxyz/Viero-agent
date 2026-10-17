import { DatabaseSync } from 'node:sqlite';
import { decodeOperationRow, type OperationRecord } from './operationStore.js';
import { redactOperation, type RedactedOperation } from './signerOperationStore.js';

export type RecoveryFinding = { operationId: string; severity: 'review' | 'blocked'; code: string; detail: string };
export type RecoveryReport = { schemaVersion: number; unresolved: RedactedOperation[]; findings: RecoveryFinding[] };

/** Read-only inspection. It never migrates, mutates, signs, broadcasts, or calls RPC. */
export function inspectOperationStore(filename: string): RecoveryReport {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const migration = database.prepare('SELECT MAX(version) AS version FROM operation_migrations').get() as { version?: number | null };
    const rows = database.prepare("SELECT * FROM operations WHERE state NOT IN ('TERMINAL','FAILED') ORDER BY created_at").all() as any[];
    const fullRecords: OperationRecord[] = rows.map(decodeOperationRow);
    const findings: RecoveryFinding[] = [];
    for (const record of fullRecords) {
      if (record.state === 'BROADCAST_UNKNOWN' || record.state === 'RECONCILIATION_REQUIRED' || record.state === 'BLOCKED') findings.push({ operationId: record.operationId, severity: 'blocked', code: 'RECONCILIATION_REQUIRED', detail: 'Transaction evidence is incomplete or ambiguous; no retry is permitted.' });
      if (record.state === 'CONFIRMED' && record.finality !== 'CONFIRMED') findings.push({ operationId: record.operationId, severity: 'review', code: 'FINALITY_INCOMPLETE', detail: 'Receipt is present but canonical finality is not confirmed.' });
      if (record.nonce && fullRecords.some(other => other.operationId !== record.operationId && other.chainId === record.chainId && other.signerAddress === record.signerAddress && other.nonce === record.nonce)) findings.push({ operationId: record.operationId, severity: 'blocked', code: 'NONCE_CONFLICT', detail: 'Two unresolved operations claim the same chain/signer/nonce.' });
    }
    return { schemaVersion: Number(migration.version ?? 0), unresolved: fullRecords.map(redactOperation), findings };
  } finally { database.close(); }
}
