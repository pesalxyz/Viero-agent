#!/usr/bin/env node
/* Local operator recovery CLI; no RPC, signing, or broadcast capability. */
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import { inspectOperationStore } from './operationInspector.js';
import { SignerOperationStore } from './signerOperationStore.js';
import { repairStrategyProjection } from './projectionRepair.js';
import { FileRepository } from './repositories.js';
import { readEvidenceHandoff, writeEvidenceHandoff } from './evidenceHandoff.js';

function arg(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const database = arg('--database') ?? process.env.VIERO_SIGNER_OPERATION_STORE;
const dataDir = arg('--repair-strategy');
if (dataDir) {
  const evidenceFile = arg('--evidence-file');
  if (!evidenceFile) throw new Error('SIGNED_EVIDENCE_FILE_REQUIRED');
  const evidence = await readEvidenceHandoff(evidenceFile, { publicKey: process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY });
  const repository = new FileRepository(dataDir); await repository.initialize();
  try {
    const result = repairStrategyProjection(await repository.strategyState(), evidence);
    if (result.blocked.length) throw new Error(`PROJECTION_REPAIR_BLOCKED:${result.blocked.map(item => item.reason).join(',')}`);
    await repository.setStrategyState(result.state);
    console.log(JSON.stringify({ applied: result.applied, skipped: result.skipped, blocked: result.blocked }));
  } finally { await repository.close(); }
  process.exit(0);
}
if (!database) throw new Error('DATABASE_REQUIRED');
if (process.argv.includes('--export-evidence')) {
  const filename = arg('--export-evidence');
  if (!filename) throw new Error('EVIDENCE_FILE_REQUIRED');
  const store = new SignerOperationStore(database);
  try {
    const envelope = await writeEvidenceHandoff(filename, store.all(), { privateKey: process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY });
    console.log(JSON.stringify({ file: filename, records: envelope.records.length, checksum: envelope.checksum }));
  } finally { store.close(); }
  process.exit(0);
}
if (process.argv.includes('--inspect') || (!process.argv.includes('--block') && !process.argv.includes('--repair-strategy'))) {
  console.log(JSON.stringify(inspectOperationStore(database), null, 2)); process.exit(0);
}
if (process.argv.includes('--block')) {
  const operationId = arg('--block'), reason = arg('--reason'), auditFile = arg('--audit-file') ?? `${database}.recovery.jsonl`;
  if (!operationId || !/^[0-9a-f-]{36}$/i.test(operationId) || !reason || !/^[A-Z0-9_.-]{3,80}$/.test(reason)) throw new Error('INVALID_BLOCK_DECISION');
  const store = new SignerOperationStore(database);
  try {
    const operation = store.get(operationId);
    if (!operation) throw new Error('OPERATION_NOT_FOUND');
    if (operation.state === 'TERMINAL' || operation.state === 'FAILED') throw new Error('OPERATION_ALREADY_TERMINAL');
    store.transition(operationId, operation.state, 'BLOCKED', { reconciliation: 'REQUIRED' });
    await appendFile(auditFile, `${JSON.stringify({ operationId, decision: 'BLOCKED', reason, at: Date.now() / 1000 })}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ operationId, state: 'BLOCKED', decision: reason }));
  } finally { store.close(); }
  process.exit(0);
}
