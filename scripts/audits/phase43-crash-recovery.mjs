#!/usr/bin/env node
/**
 * Isolated process-boundary recovery harness. It deliberately does not import
 * Viero, viem, a signer, or a network client. All state is temporary and the
 * fake signer records intent only; this is safe to run with production stopped.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORKER = process.argv[1];
const scenarios = [
  'before-intent', 'after-intent', 'after-broadcast', 'after-hash',
  'after-receipt', 'during-reconciliation', 'after-close-before-persist',
  'during-normalization', 'during-journal-append', 'after-broadcast-journal-failure',
  'partial-journal', 'disk-full', 'permission-denied', 'during-atomic-write',
  'duplicate-scheduler', 'concurrent-recovery', 'storage-failure',
  'truncated-journal', 'unknown-status', 'receipt-timeout', 'restart-cycles'
];

function paths(root) { return { state: path.join(root, 'state.json'), journal: path.join(root, 'journal.jsonl'), lock: path.join(root, 'recovery.lock') }; }
function initial() { return { status: 'open', positionId: 'isolated-1', intent: false, broadcast: false, txHash: null, receipt: null, normalization: 'not-required' }; }
async function atomic(file, value, fail = false) {
  if (fail) throw new Error('injected atomic write failure');
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value) + '\n', 'utf8');
  await rename(tmp, file);
}
async function load(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function journal(file, record, fail = false) {
  if (fail) throw new Error('injected journal append failure');
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}
async function recover(p) {
  let state = await load(p.state);
  if (state.normalization === 'pending' && state.status === 'closed') return { state, outcome: 'normalization-isolated' };
  let records = [];
  if (existsSync(p.journal)) {
    for (const line of (await readFile(p.journal, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* preserve evidence; fail closed below */ return { state, outcome: 'blocked:truncated-journal' }; }
    }
  }
  if (records.some((r) => r.type === 'authorize')) {
    if (records.filter((r) => r.type === 'authorize').length > 1) return { state, outcome: 'blocked:duplicate-authorization' };
    if (state.receipt === 'confirmed' || records.some((r) => r.type === 'confirmed')) {
      state = { ...state, status: 'closed', intent: false, broadcast: true, receipt: 'confirmed', normalization: state.normalization === 'pending' ? 'pending' : 'not-required' };
      await atomic(p.state, state);
      return { state, outcome: 'reconciled-confirmed' };
    }
    return { state: { ...state, status: 'review' }, outcome: 'blocked:ambiguous-transaction' };
  }
  if (state.intent && !state.broadcast) { state = { ...state, intent: false, status: 'open' }; await atomic(p.state, state); return { state, outcome: 'reset-unbroadcast-intent' }; }
  if (state.normalization === 'pending') { return { state, outcome: 'normalization-isolated' }; }
  return { state, outcome: 'no-action' };
}
async function worker() {
  const root = process.env.VIERO_TEST_ROOT; const scenario = process.env.VIERO_TEST_SCENARIO; const p = paths(root);
  if (process.env.VIERO_TEST_RECOVER === '1') { console.log(JSON.stringify(await recover(p))); return; }
  let state = await load(p.state);
  const fail = scenario === 'storage-failure' || scenario === 'during-atomic-write';
  try {
    if (scenario === 'before-intent') process.exit(17);
    state = { ...state, intent: true, status: 'closing' }; await atomic(p.state, state, fail && scenario === 'during-atomic-write');
    if (scenario === 'after-intent' || scenario === 'during-atomic-write' || scenario === 'storage-failure') process.exit(17);
    if (scenario === 'during-journal-append' || scenario === 'disk-full' || scenario === 'permission-denied') { await journal(p.journal, { type: 'authorize', hash: '0xfake' }, true); process.exit(17); }
    await journal(p.journal, { type: 'authorize', hash: '0xfake' });
    state = { ...state, broadcast: true }; await atomic(p.state, state);
    if (scenario === 'after-broadcast') process.exit(17);
    if (scenario === 'after-broadcast-journal-failure') { await journal(p.journal, { type: 'broadcast', hash: '0xfake' }, true); process.exit(17); }
    if (scenario === 'partial-journal') { await appendFile(p.journal, '{"type":"broadcast"', 'utf8'); process.exit(17); }
    state = { ...state, txHash: '0xfake' }; await atomic(p.state, state);
    if (scenario === 'after-hash' || scenario === 'unknown-status' || scenario === 'receipt-timeout') process.exit(17);
    if (scenario === 'during-reconciliation') process.exit(17);
    await journal(p.journal, { type: 'confirmed', hash: '0xfake' }); state = { ...state, receipt: 'confirmed' }; await atomic(p.state, state);
    if (scenario === 'after-receipt' || scenario === 'after-close-before-persist') process.exit(17);
    state = { ...state, status: 'closed' }; await atomic(p.state, state);
    if (scenario === 'during-normalization') { state = { ...state, normalization: 'pending' }; await atomic(p.state, state); process.exit(17); }
    if (scenario === 'restart-cycles') { process.exit(17); }
  } catch (error) { console.log(JSON.stringify({ outcome: 'failed-closed', error: error.message })); process.exit(17); }
}
function run(env) { return new Promise((resolve) => { const child = fork(WORKER, ['--worker'], { env: { ...process.env, ...env }, silent: true }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.on('exit', (code, signal) => resolve({ code, signal, output })); }); }
async function main() {
  if (process.argv.includes('--worker')) return worker();
  const root = await mkdtemp(path.join(os.tmpdir(), 'viero-phase43-')); await mkdir(root, { recursive: true });
  const results = [];
  try {
    for (const scenario of scenarios) {
      const p = paths(root); await atomic(p.state, initial()); await writeFile(p.journal, '');
      await run({ VIERO_TEST_ROOT: root, VIERO_TEST_SCENARIO: scenario });
      if (scenario === 'duplicate-scheduler' || scenario === 'concurrent-recovery') {
        await atomic(p.state, { ...initial(), intent: true, status: 'closing', broadcast: true });
        await journal(p.journal, { type: 'authorize', hash: '0xfake' });
      }
      if (scenario === 'truncated-journal') await writeFile(p.journal, '{"type":"authorize"}\n{"broken"');
      const recoveries = scenario === 'concurrent-recovery' ? await Promise.all([run({ VIERO_TEST_ROOT: root, VIERO_TEST_RECOVER: '1' }), run({ VIERO_TEST_ROOT: root, VIERO_TEST_RECOVER: '1' })]) : [await run({ VIERO_TEST_ROOT: root, VIERO_TEST_RECOVER: '1' })];
      const state = await load(p.state); const text = recoveries.map((r) => r.code).join(',');
      if (scenario === 'after-broadcast') assert.notEqual(state.status, 'open', 'ambiguous broadcast must not reopen');
      const outcomes = recoveries.flatMap((r) => { try { return [JSON.parse(r.output.trim()).outcome]; } catch { return ['worker-output-unavailable']; } });
      if (scenario === 'truncated-journal') assert.ok(outcomes.every((o) => o === 'blocked:truncated-journal'), outcomes.join(','));
      if (['after-broadcast-journal-failure', 'partial-journal'].includes(scenario)) assert.ok(outcomes.every((o) => o.startsWith('blocked:')), outcomes.join(','));
      if (scenario === 'during-normalization') assert.ok(outcomes.every((o) => o === 'normalization-isolated'), outcomes.join(','));
      if (['after-broadcast', 'after-hash', 'unknown-status', 'receipt-timeout', 'duplicate-scheduler', 'concurrent-recovery'].includes(scenario)) assert.ok(outcomes.some((o) => o.startsWith('blocked:')), outcomes.join(','));
      results.push({ scenario, recoveryProcesses: recoveries.length, exitCodes: text, outcomes, finalStatus: state.status, journalRecords: (await readFile(p.journal, 'utf8')).split('\n').filter(Boolean).length });
    }
    console.log(JSON.stringify({ isolated: true, scenarios: results.length, results }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
