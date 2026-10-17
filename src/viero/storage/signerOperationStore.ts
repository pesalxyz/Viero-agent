import { chmodSync, statSync } from 'node:fs';
import { OperationStore, type OperationRecord } from './operationStore.js';
import { CHAIN_IDS } from '../domain.js';

/**
 * Signer-only mutation facade. This is intentionally not imported by the agent
 * or signer server yet; the Unix socket and filesystem owner remain the future
 * trust boundary. The role check is a defense-in-depth contract for tests.
 */
export class SignerOperationStore {
  private readonly store: OperationStore;
  constructor(filename: string, role: 'signer' | 'agent' = 'signer') {
    if (role !== 'signer') throw new Error('OPERATION_STORE_SIGNER_ONLY');
    assertSignerStorePathSafe(filename);
    this.store = new OperationStore(filename);
    chmodSync(filename, 0o600);
  }
  create(...args: Parameters<OperationStore['create']>) { return this.store.create(...args); }
  createExclusive(...args: Parameters<OperationStore['createExclusive']>) { return this.store.createExclusive(...args); }
  transition(...args: Parameters<OperationStore['transition']>) { return this.store.transition(...args); }
  reserveNonce(...args: Parameters<OperationStore['reserveNonce']>) { return this.store.reserveNonce(...args); }
  get(...args: Parameters<OperationStore['get']>) { return this.store.get(...args); }
  findByTransactionHash(...args: Parameters<OperationStore['findByTransactionHash']>) { return this.store.findByTransactionHash(...args); }
  annotate(...args: Parameters<OperationStore['annotate']>) { return this.store.annotate(...args); }
  recordPositionEvidence(...args: Parameters<OperationStore['recordPositionEvidence']>) { return this.store.recordPositionEvidence(...args); }
  acknowledgePositionProjection(...args: Parameters<OperationStore['acknowledgePositionProjection']>) { return this.store.acknowledgePositionProjection(...args); }
  unacknowledgedOpenOperations() { return this.store.unacknowledgedOpenOperations(); }
  createCloseWorkflow(...args: Parameters<OperationStore['createCloseWorkflow']>) { return this.store.createCloseWorkflow(...args); }
  getCloseWorkflow(...args: Parameters<OperationStore['getCloseWorkflow']>) { return this.store.getCloseWorkflow(...args); }
  updateCloseWorkflow(...args: Parameters<OperationStore['updateCloseWorkflow']>) { return this.store.updateCloseWorkflow(...args); }
  closeWorkflows() { return this.store.closeWorkflows(); }
  unresolved(...args: Parameters<OperationStore['unresolved']>) { return this.store.unresolved(...args); }
  all(...args: Parameters<OperationStore['all']>) { return this.store.all(...args); }
  validate(expectedSignerAddress: string) {
    const integrity = this.store.database.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('OPERATION_STORE_INTEGRITY_FAILED');
    const migration = this.store.database.prepare('SELECT MAX(version) AS version FROM operation_migrations').get() as { version?: number | null };
    if (Number(migration.version ?? 0) !== 2) throw new Error('OPERATION_STORE_SCHEMA_UNSUPPORTED');
    for (const record of this.store.unresolved()) {
      if (record.signerAddress.toLowerCase() !== expectedSignerAddress.toLowerCase()) throw new Error('OPERATION_SIGNER_MISMATCH');
      if (!CHAIN_IDS.includes(record.chainId as never)) throw new Error('OPERATION_CHAIN_UNSUPPORTED');
    }
    return { schemaVersion: Number(migration.version ?? 0), unresolved: this.store.unresolved() };
  }
  close() { this.store.close(); }
}

export function assertSignerStorePathSafe(filename: string) {
  const parent = statSync(filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) || '/' : '.');
  if ((parent.mode & 0o022) !== 0) throw new Error('OPERATION_STORE_DIRECTORY_PERMISSIONS');
  try { if ((statSync(filename).mode & 0o077) !== 0) throw new Error('OPERATION_STORE_FILE_PERMISSIONS'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export type RedactedOperation = Omit<OperationRecord, 'signerAddress' | 'requestFingerprint' | 'nonce'> & {
  signerAddress: '[redacted]'; requestFingerprint: '[redacted]'; nonce: '[redacted]' | null;
};
export function redactOperation(record: OperationRecord): RedactedOperation {
  return { ...record, signerAddress: '[redacted]', requestFingerprint: '[redacted]', nonce: record.nonce ? '[redacted]' : null };
}
