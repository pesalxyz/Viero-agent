#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const date = option('--date', new Date().toISOString().slice(0, 10));
const chain = option('--chain', null);
const file = option('--file', process.env.VIERO_RPC_TELEMETRY_FILE ?? (process.env.VIERO_DATA_DIR ? resolve(process.env.VIERO_DATA_DIR, 'rpc-telemetry.json') : resolve('data/viero/rpc-telemetry.json')));
let persisted;
try { persisted = JSON.parse(await readFile(file, 'utf8')); } catch (error) { console.error(`RPC telemetry unavailable: ${file}`); process.exitCode = 1; process.exit(); }
const snapshot = persisted?.days?.[date];
if (!snapshot) { console.error(`No persisted RPC telemetry for UTC date ${date}: ${file}`); process.exitCode = 1; process.exit(); }
const operations = (snapshot.operations ?? []).filter(row => chain === null || String(row.chainId) === String(chain));
const scopes = (snapshot.scopes ?? []).filter(row => chain === null || String(row.chainId) === String(chain));
const cuWeights = { eth_call: 26, eth_getLogs: 60, eth_getBlockByNumber: 20, eth_getCode: 20, eth_getTransactionByHash: 20, eth_getTransactionReceipt: 20, eth_getBalance: 20, eth_blockNumber: 10, eth_gasPrice: 20, eth_fillTransaction: 20, eth_sendRawTransaction: 20 };
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
const group = (rows, field) => Object.values(rows.reduce((out, row) => { const key = row[field] ?? 'unknown'; const item = out[key] ?? { [field]: key, logical: 0, physical: 0, httpAttempts: 0, retries: 0, errors: 0, modeledCu: 0, latencyMs: 0 }; for (const metric of ['logical', 'physical', 'httpAttempts', 'retries', 'errors', 'latencyMs']) item[metric] += Number(row[metric] ?? 0); item.modeledCu += Number(row.modeledCu ?? (field === 'method' ? Number(row.physical ?? 0) * (cuWeights[key] ?? 0) : 0)); out[key] = item; return out; }, {})).sort((a, b) => b.physical - a.physical);
const byMethod = group(operations, 'method');
const byWorkflow = group(scopes, 'workflow');
const byCycle = scopes.reduce((out, row) => { if (!row.cycleId) return out; const key = row.cycleId; const item = out[key] ?? { cycleId: key, candidateToken: row.candidateToken, physical: 0, logical: 0, modeledCu: 0, pools: new Set(), methods: {}, workflows: {} }; item.physical += Number(row.physical ?? 0); item.logical += Number(row.logical ?? 0); item.modeledCu += Number(row.modeledCu ?? 0); if (row.poolIdentity) item.pools.add(row.poolIdentity); const method = row.method ?? 'unknown'; item.methods[method] = (item.methods[method] ?? 0) + Number(row.physical ?? 0); item.workflows[row.workflow] = (item.workflows[row.workflow] ?? 0) + Number(row.physical ?? 0); out[key] = item; return out; }, {});
const cycles = Object.values(byCycle).map(row => ({ ...row, pools: row.pools.size })).sort((a, b) => b.physical - a.physical);
console.log(JSON.stringify({
  dateUtc: date, chain: chain === null ? 'all' : Number(chain), source: file,
  daily: { physicalHttpAttempts: Number(snapshot.transport?.httpAttempts ?? sum(scopes, 'httpAttempts')), batchEnvelopes: Number(snapshot.transport?.batchEnvelopes ?? 0), logicalMethods: sum(scopes, 'logical'), methodAttempts: Number(snapshot.transport?.methodAttempts ?? sum(scopes, 'physical')), retries: sum(scopes, 'retries'), fallbacks: sum(scopes, 'fallbackAttempts'), errors: sum(scopes, 'errors'), latencyMs: sum(scopes, 'latencyMs') },
  methods: byMethod, workflows: byWorkflow,
  candidates: snapshot.candidates ?? [], highestCostCycles: cycles.slice(0, 10),
  note: 'Modeled CU uses configured method weights and is not provider-billed CU. HTTP attempts are envelope-level; methodAttempts count methods inside batches.',
}, null, 2));
