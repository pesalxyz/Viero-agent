import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { type OperationRecord } from './operationStore.js';

export type EvidenceHandoffRecord = Pick<OperationRecord, 'operationId' | 'type' | 'chainId' | 'positionId' | 'poolIdentity' | 'transactionHash' | 'receipt' | 'finality' | 'reconciliation' | 'state' | 'broadcastStatus' | 'updatedAt'>;
type Envelope = { version: 2; algorithm: 'ed25519'; records: EvidenceHandoffRecord[]; checksum: string; signature: string };

function canonical(records: EvidenceHandoffRecord[]) {
  return JSON.stringify(records.map(record => ({ ...record, receipt: record.receipt ? { ...record.receipt } : null })).sort((a, b) => a.operationId.localeCompare(b.operationId)));
}
function checksum(records: EvidenceHandoffRecord[]) { return createHash('sha256').update(canonical(records)).digest('hex'); }
async function configuredKey(explicit: string | undefined, inline: string | undefined, file: string | undefined, kind: 'private' | 'public') {
  const value = explicit ?? inline ?? (file ? await readFile(file, 'utf8') : undefined);
  if (!value) throw new Error(kind === 'private' ? 'EVIDENCE_SIGNING_KEY_REQUIRED' : 'EVIDENCE_HANDOFF_INVALID');
  const normalized = value.replace(/\\n/g, '\n').trim();
  const key = normalized.startsWith('-----BEGIN')
    ? kind === 'private' ? createPrivateKey(normalized) : createPublicKey(normalized)
    : kind === 'private'
      ? createPrivateKey({ key: Buffer.from(normalized, 'base64'), format: 'der', type: 'pkcs8' })
      : createPublicKey({ key: Buffer.from(normalized, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('EVIDENCE_KEY_TYPE_INVALID');
  return key;
}
function exportable(record: OperationRecord): EvidenceHandoffRecord {
  return { operationId: record.operationId, type: record.type, chainId: record.chainId, positionId: record.positionId, poolIdentity: record.poolIdentity, transactionHash: record.transactionHash, receipt: record.receipt, finality: record.finality, reconciliation: record.reconciliation, state: record.state, broadcastStatus: record.broadcastStatus, updatedAt: record.updatedAt };
}
export function buildEvidenceHandoff(records: OperationRecord[]): EvidenceHandoffRecord[] {
  return records.filter(record => record.state === 'TERMINAL' && record.broadcastStatus === 'KNOWN' && record.transactionHash && record.receipt?.status === 'success').map(exportable);
}
export async function writeEvidenceHandoff(filename: string, records: OperationRecord[], options: { privateKey?: string } = {}) {
  const exported = buildEvidenceHandoff(records);
  const privateKey = await configuredKey(options.privateKey, process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY,
    process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY_FILE, 'private');
  const digest = checksum(exported);
  const envelope: Envelope = { version: 2, algorithm: 'ed25519', records: exported, checksum: digest, signature: sign(null, Buffer.from(digest), privateKey).toString('base64') };
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, filename); await chmod(filename, 0o600);
  return envelope;
}
export async function readEvidenceHandoff(filename: string, options: { publicKey?: string } = {}): Promise<EvidenceHandoffRecord[]> {
  const parsed = JSON.parse(await readFile(filename, 'utf8')) as Envelope;
  const publicKey = await configuredKey(options.publicKey, process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY,
    process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY_FILE, 'public');
  if (parsed.version !== 2 || parsed.algorithm !== 'ed25519' || !Array.isArray(parsed.records) || typeof parsed.checksum !== 'string' || typeof parsed.signature !== 'string' || parsed.checksum !== checksum(parsed.records) || !verify(null, Buffer.from(parsed.checksum), publicKey, Buffer.from(parsed.signature, 'base64'))) throw new Error('EVIDENCE_HANDOFF_INVALID');
  for (const record of parsed.records) {
    if (record.state !== 'TERMINAL' || record.broadcastStatus !== 'KNOWN' || !record.transactionHash || record.receipt?.status !== 'success' || record.finality !== 'CONFIRMED' || record.reconciliation !== 'COMPLETE' || !record.positionId || !record.poolIdentity) throw new Error('EVIDENCE_HANDOFF_INCOMPLETE');
  }
  return parsed.records;
}
