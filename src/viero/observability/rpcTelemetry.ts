import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export type RpcWorkflow = 'unknown' | 'preflight' | 'candidate-discovery' | 'pool-hint-fetch' | 'v4-pool-key-recovery' | 'v4-initialize-fallback' | 'v3-factory-fallback' | 'multi-pool-verification' | 'selected-pool-fresh-verification' | 'selected-pool-historical-observation' | 'candidate-verify' | 'candidate-observation' | 'management' | 'management-recovery' | 'position-management' | 'signer-verification' | 'confirmation' | 'execution-receipt' | 'normalization' | 'other';
export type RpcScopeContext = { workflow: RpcWorkflow; cycleId?: string; candidateToken?: string; poolIdentity?: string; role?: string };
export type RpcOperation = { role: string; workflow: RpcWorkflow; chainId: number; method: string; logical: number; physical: number; retries: number; fallbackAttempts: number; latencyMs: number; errors: number };
export type RpcScopeSummary = { key: string; role: string; workflow: RpcWorkflow; chainId: number; method: string; cycleId: string | null; candidateToken: string | null; poolIdentity: string | null; logical: number; physical: number; httpAttempts: number; batchEnvelopes: number; retries: number; fallbackAttempts: number; errors: number; latencyMs: number; modeledCu: number };
export type RpcCandidateSummary = { cycleId: string; chainId: number; candidateToken: string; externalHints: number; mappedPools: number; v4RecoveryAttempts: number; verifiedPools: number; failedPools: number; fallbackDiscoveredPools: number; selectedPool: string | null; verificationOutcomes: Record<string, number> };
export type RpcTelemetrySnapshot = {
  generatedAt: number;
  operations: RpcOperation[];
  scopes: RpcScopeSummary[];
  candidates: RpcCandidateSummary[];
  transport: { httpAttempts: number; batchEnvelopes: number; methodAttempts: number };
  persistence?: { file: string | null; restored: boolean; pending: boolean; lastFlushAt: number | null; retentionDays: number };
  cache: { tokenHits: number; tokenMisses: number; tokenInvalidations: number; creationHits: number; creationMisses: number; creationInvalidations: number };
  observations: { candidateObservations: number; managementTicks: number; openPositionsLast: number | null };
  pagination: { requests: number; pages: number; splits: number; logsReturned: number; errors: number; latencyMs: number; ranges: Array<{ chainId: number; from: string; to: string; pages: number; splits: number; logsReturned: number }> };
  historicalMemo: { blockHits: number; blockMisses: number; stateHits: number; stateMisses: number; transactionHits: number; transactionMisses: number; logicalReadsAvoided: number; invalidations: number; evictions: number };
};

type RpcContext = RpcScopeContext;
type PersistedTelemetry = { version: 1; days: Record<string, RpcTelemetrySnapshot>; updatedAt: number };
type TelemetryOptions = { file?: string; retentionDays?: number; flushMs?: number };
const CU_WEIGHTS: Record<string, number> = { eth_call: 26, eth_getLogs: 60, eth_getBlockByNumber: 20, eth_getCode: 20, eth_getTransactionByHash: 20, eth_getTransactionReceipt: 20, eth_getBalance: 20, eth_blockNumber: 10, eth_gasPrice: 20, eth_fillTransaction: 20, eth_sendRawTransaction: 20 };
const workflowStorage = new AsyncLocalStorage<RpcContext>();

function defaultTelemetryFile(): string | undefined {
  const explicit = process.env.VIERO_RPC_TELEMETRY_FILE;
  if (explicit) return explicit;
  const dataDir = process.env.VIERO_DATA_DIR;
  return dataDir ? join(resolve(dataDir), 'rpc-telemetry.json') : undefined;
}
function utcDay(timestamp = Date.now()): string { return new Date(timestamp).toISOString().slice(0, 10); }

/** Bounded, best-effort telemetry. Persistence is asynchronous and never sits on an RPC call path. */
export class RpcTelemetry {
  private readonly rows = new Map<string, RpcOperation>();
  private readonly scopes = new Map<string, RpcScopeSummary>();
  private readonly candidates = new Map<string, RpcCandidateSummary>();
  private readonly maxRows: number;
  private readonly file?: string;
  private readonly retentionDays: number;
  private readonly flushMs: number;
  private readonly restorePromise: Promise<void>;
  private persistedDays: Record<string, RpcTelemetrySnapshot> = {};
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> = Promise.resolve();
  private restored = false;
  private pending = false;
  private lastFlushAt: number | null = null;
  private cacheCounters = { tokenHits: 0, tokenMisses: 0, tokenInvalidations: 0, creationHits: 0, creationMisses: 0, creationInvalidations: 0 };
  private observationCounters = { candidateObservations: 0, managementTicks: 0, openPositionsLast: null as number | null };
  private paginationCounters = { requests: 0, pages: 0, splits: 0, logsReturned: 0, errors: 0, latencyMs: 0, ranges: [] as RpcTelemetrySnapshot['pagination']['ranges'] };
  private historicalMemoCounters = { blockHits: 0, blockMisses: 0, stateHits: 0, stateMisses: 0, transactionHits: 0, transactionMisses: 0, logicalReadsAvoided: 0, invalidations: 0, evictions: 0 };
  private transportCounters = { httpAttempts: 0, batchEnvelopes: 0, methodAttempts: 0 };

  constructor(readonly role = process.env.VIERO_PROCESS_ROLE ?? 'autonomous', maxRows = 2048, options: TelemetryOptions = {}) {
    this.maxRows = Math.max(64, maxRows); this.file = options.file ?? defaultTelemetryFile(); this.retentionDays = Math.max(1, Math.min(31, options.retentionDays ?? 14)); this.flushMs = Math.max(100, options.flushMs ?? 5000); this.restorePromise = this.restore();
  }
  workflow(): RpcWorkflow { return workflowStorage.getStore()?.workflow ?? 'unknown'; }
  context(): RpcScopeContext { return workflowStorage.getStore() ?? { workflow: 'unknown' }; }
  /** Wait until an optional persisted snapshot has been loaded. */
  async ready(): Promise<void> { await this.restorePromise; }
  async run<T>(workflow: RpcWorkflow, fn: () => Promise<T>, context: Omit<RpcScopeContext, 'workflow'> = {}): Promise<T> { return workflowStorage.run({ ...context, workflow }, fn); }
  async scope<T>(context: RpcScopeContext, fn: () => Promise<T>): Promise<T> { return workflowStorage.run(context, fn); }

  logical(chainId: number, method: string, workflow = this.workflow()): void { try { const effectiveWorkflow = workflow ?? this.workflow(); this.update(chainId, method, effectiveWorkflow, row => { row.logical += 1; }); this.scopeUpdate(chainId, method, { ...this.context(), workflow: effectiveWorkflow }, row => { row.logical += 1; }); } catch { /* telemetry must never affect behavior */ } }
  physical(chainId: number, workflow = this.workflow(), ok = true, latencyMs = 0, method = 'unknown'): void { try { const effectiveWorkflow = workflow ?? this.workflow(); this.update(chainId, method, effectiveWorkflow, row => { row.physical += 1; row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); this.scopeUpdate(chainId, method, { ...this.context(), workflow: effectiveWorkflow }, row => { row.physical += 1; row.httpAttempts += 1; row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); } catch { /* best effort */ } }
  physicalResult(chainId: number, workflow = this.workflow(), ok = true, latencyMs = 0, method = 'unknown'): void { try { const effectiveWorkflow = workflow ?? this.workflow(); this.update(chainId, method, effectiveWorkflow, row => { row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); this.scopeUpdate(chainId, method, { ...this.context(), workflow: effectiveWorkflow }, row => { row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); } catch { /* best effort */ } }
  /** Records one HTTP envelope and its individual methods. A batch is one HTTP attempt but N method attempts. */
  physicalEnvelope(chainId: number, methods: string[], _index = 0, contexts: RpcContext[] = []): void { try { const fallbackContext = this.context(), list = methods.length ? methods : ['unknown']; this.transportCounters.httpAttempts += 1; this.transportCounters.batchEnvelopes += list.length > 1 ? 1 : 0; this.transportCounters.methodAttempts += list.length; list.forEach((method, index) => { const context = contexts[index] ?? contexts[0] ?? fallbackContext; this.update(chainId, method, context.workflow, row => { row.physical += 1; }); this.scopeUpdate(chainId, method, context, row => { row.physical += 1; row.httpAttempts += 1; row.batchEnvelopes += 1; }); }); this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  physicalEnvelopeResult(chainId: number, methods: string[], ok: boolean, latencyMs: number, contexts: RpcContext | RpcContext[]): void { try { const list = methods.length ? methods : ['unknown'], contextList = Array.isArray(contexts) ? contexts : [contexts]; list.forEach((method, index) => { const context = contextList[index] ?? contextList[0] ?? { workflow: 'unknown' as const }; this.update(chainId, method, context.workflow, row => { row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); this.scopeUpdate(chainId, method, context, row => { row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); }); } catch { /* best effort */ } }
  retry(chainId: number, method = 'unknown', workflow = this.workflow()): void { try { this.update(chainId, method, workflow, row => { row.retries += 1; row.fallbackAttempts += 1; }); this.scopeUpdate(chainId, method, { ...this.context(), workflow }, row => { row.retries += 1; row.fallbackAttempts += 1; }); } catch { /* best effort */ } }
  cache(kind: 'token' | 'creation', result: 'hit' | 'miss' | 'invalidation'): void { try { const suffix = result === 'hit' ? 'Hits' : result === 'miss' ? 'Misses' : 'Invalidations'; const key = `${kind === 'token' ? 'token' : 'creation'}${suffix}` as keyof typeof this.cacheCounters; if (key in this.cacheCounters) this.cacheCounters[key] += 1; this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  candidateObserved(): void { try { this.observationCounters.candidateObservations += 1; this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  managementTick(openPositions: number): void { try { this.observationCounters.managementTicks += 1; this.observationCounters.openPositionsLast = Math.max(0, openPositions); this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  candidateSummary(summary: RpcCandidateSummary): void { try { const prior = this.candidates.get(summary.cycleId); this.candidates.set(summary.cycleId, { ...summary, verificationOutcomes: { ...(prior?.verificationOutcomes ?? {}), ...summary.verificationOutcomes } }); this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  verificationOutcome(context: RpcScopeContext, outcome: 'success' | 'early-rejection' | 'rpc-error' | 'identity-mismatch' | 'insufficient-liquidity' | 'other'): void { try { if (!context.cycleId) return; const current = this.candidates.get(context.cycleId) ?? { cycleId: context.cycleId, chainId: 0, candidateToken: context.candidateToken ?? '', externalHints: 0, mappedPools: 0, v4RecoveryAttempts: 0, verifiedPools: 0, failedPools: 0, fallbackDiscoveredPools: 0, selectedPool: null, verificationOutcomes: {} }; current.verificationOutcomes[outcome] = (current.verificationOutcomes[outcome] ?? 0) + 1; if (outcome === 'success') current.verifiedPools += 1; else current.failedPools += 1; this.candidates.set(context.cycleId, current); this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  pagination(chainId: number, from: bigint, to: bigint, pages: number, splits: number, logsReturned: number, latencyMs: number, error = false): void { try { this.paginationCounters.requests += pages; this.paginationCounters.pages += pages; this.paginationCounters.splits += splits; this.paginationCounters.logsReturned += Math.max(0, logsReturned); this.paginationCounters.latencyMs += Math.max(0, latencyMs); if (error) this.paginationCounters.errors += 1; if (this.paginationCounters.ranges.length < 256) this.paginationCounters.ranges.push({ chainId, from: from.toString(), to: to.toString(), pages, splits, logsReturned }); this.pending = true; this.schedulePersist(); } catch { /* best effort */ } }
  historicalMemo(kind: 'block' | 'state' | 'transaction', result: 'hit' | 'miss'): void { try { const key = `${kind}${result === 'hit' ? 'Hits' : 'Misses'}` as keyof typeof this.historicalMemoCounters; if (key in this.historicalMemoCounters) this.historicalMemoCounters[key] += 1; } catch { /* best effort */ } }
  historicalMemoAvoided(): void { try { this.historicalMemoCounters.logicalReadsAvoided += 1; } catch { /* best effort */ } }
  historicalMemoInvalidation(): void { try { this.historicalMemoCounters.invalidations += 1; } catch { /* best effort */ } }
  historicalMemoEviction(): void { try { this.historicalMemoCounters.evictions += 1; } catch { /* best effort */ } }

  snapshot(): RpcTelemetrySnapshot { return { generatedAt: Date.now() / 1000, operations: [...this.rows.values()].map(row => ({ ...row })), scopes: [...this.scopes.values()].map(row => ({ ...row })), candidates: [...this.candidates.values()].map(row => ({ ...row, verificationOutcomes: { ...row.verificationOutcomes } })), transport: { ...this.transportCounters }, persistence: { file: this.file ?? null, restored: this.restored, pending: this.pending, lastFlushAt: this.lastFlushAt, retentionDays: this.retentionDays }, cache: { ...this.cacheCounters }, observations: { ...this.observationCounters }, pagination: { ...this.paginationCounters, ranges: [...this.paginationCounters.ranges] }, historicalMemo: { ...this.historicalMemoCounters } }; }
  reset(): void { this.rows.clear(); this.scopes.clear(); this.candidates.clear(); this.transportCounters = { httpAttempts: 0, batchEnvelopes: 0, methodAttempts: 0 }; this.cacheCounters = { tokenHits: 0, tokenMisses: 0, tokenInvalidations: 0, creationHits: 0, creationMisses: 0, creationInvalidations: 0 }; this.observationCounters = { candidateObservations: 0, managementTicks: 0, openPositionsLast: null }; this.paginationCounters = { requests: 0, pages: 0, splits: 0, logsReturned: 0, errors: 0, latencyMs: 0, ranges: [] }; this.historicalMemoCounters = { blockHits: 0, blockMisses: 0, stateHits: 0, stateMisses: 0, transactionHits: 0, transactionMisses: 0, logicalReadsAvoided: 0, invalidations: 0, evictions: 0 }; }
  async flush(): Promise<void> { if (!this.file) return; this.flushPromise = this.flushPromise.then(async () => { await this.restorePromise; const day = utcDay(), data: PersistedTelemetry = { version: 1, updatedAt: Date.now(), days: { ...this.persistedDays, [day]: this.snapshot() } }; const dates = Object.keys(data.days).sort().slice(-this.retentionDays); data.days = Object.fromEntries(dates.map(date => [date, data.days[date]!])) as Record<string, RpcTelemetrySnapshot>; await mkdir(dirname(this.file!), { recursive: true }); const temp = `${this.file}.tmp-${process.pid}`; await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, this.file!); this.persistedDays = data.days; this.pending = false; this.lastFlushAt = Date.now() / 1000; }).catch(() => { /* persistence is best effort */ }); return this.flushPromise; }
  static async readPersisted(file: string): Promise<PersistedTelemetry | null> { try { const parsed = JSON.parse(await readFile(file, 'utf8')) as PersistedTelemetry; return parsed?.version === 1 && parsed.days ? parsed : null; } catch { return null; } }

  private update(chainId: number, method: string, workflow: RpcWorkflow, fn: (row: RpcOperation) => void): void { const key = `${this.role}|${workflow}|${chainId}|${method}`; let row = this.rows.get(key); if (!row) { if (this.rows.size >= this.maxRows) this.rows.delete(this.rows.keys().next().value!); row = { role: this.role, workflow, chainId, method, logical: 0, physical: 0, retries: 0, fallbackAttempts: 0, latencyMs: 0, errors: 0 }; this.rows.set(key, row); } fn(row); this.pending = true; this.schedulePersist(); }
  private scopeUpdate(chainId: number, method: string, context: RpcContext, fn: (row: RpcScopeSummary) => void): void { const role = context.role ?? this.role, key = `${role}|${context.workflow}|${chainId}|${context.cycleId ?? ''}|${context.candidateToken ?? ''}|${context.poolIdentity ?? ''}|${method}`; let row = this.scopes.get(key); if (!row) { if (this.scopes.size >= this.maxRows * 4) this.scopes.delete(this.scopes.keys().next().value!); row = { key, role, workflow: context.workflow, chainId, method, cycleId: context.cycleId ?? null, candidateToken: context.candidateToken ?? null, poolIdentity: context.poolIdentity ?? null, logical: 0, physical: 0, httpAttempts: 0, batchEnvelopes: 0, retries: 0, fallbackAttempts: 0, errors: 0, latencyMs: 0, modeledCu: 0 }; this.scopes.set(key, row); } fn(row); row.modeledCu = row.physical * (CU_WEIGHTS[method] ?? 0); }
  private schedulePersist(): void { if (!this.file || this.persistTimer) return; this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.flush(); }, this.flushMs); this.persistTimer.unref?.(); }
  private async restore(): Promise<void> {
    if (!this.file) { this.restored = true; return; }
    const parsed = await RpcTelemetry.readPersisted(this.file);
    if (parsed) {
      this.persistedDays = parsed.days;
      const prior = parsed.days[utcDay()];
      if (prior) this.hydrate(prior);
    }
    this.restored = true;
  }
  private hydrate(prior: RpcTelemetrySnapshot): void {
    for (const source of prior.operations ?? []) {
      const key = `${source.role}|${source.workflow}|${source.chainId}|${source.method}`;
      const row = this.rows.get(key) ?? { ...source };
      if (this.rows.has(key)) { row.logical += source.logical; row.physical += source.physical; row.retries += source.retries; row.fallbackAttempts += source.fallbackAttempts; row.latencyMs += source.latencyMs; row.errors += source.errors; }
      this.rows.set(key, row);
    }
    for (const source of prior.scopes ?? []) {
      const method = source.method ?? source.key.split('|').at(-1) ?? 'unknown';
      const key = source.key;
      const row = this.scopes.get(key) ?? { ...source, method };
      if (this.scopes.has(key)) { row.logical += source.logical; row.physical += source.physical; row.httpAttempts += source.httpAttempts; row.batchEnvelopes += source.batchEnvelopes; row.retries += source.retries; row.fallbackAttempts += source.fallbackAttempts; row.errors += source.errors; row.latencyMs += source.latencyMs; row.modeledCu += source.modeledCu; }
      this.scopes.set(key, row);
    }
    for (const source of prior.candidates ?? []) this.candidates.set(source.cycleId, { ...source, verificationOutcomes: { ...source.verificationOutcomes } });
    this.transportCounters = { ...prior.transport };
    this.cacheCounters = { ...prior.cache };
    this.observationCounters = { ...prior.observations };
    this.paginationCounters = { ...prior.pagination, ranges: [...prior.pagination.ranges] };
    this.historicalMemoCounters = { ...prior.historicalMemo };
  }
}

export const defaultRpcTelemetry = new RpcTelemetry();
