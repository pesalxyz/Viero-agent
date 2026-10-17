import { AsyncLocalStorage } from 'node:async_hooks';

export type RpcWorkflow = 'unknown' | 'preflight' | 'candidate-discovery' | 'candidate-verify' | 'candidate-observation' | 'management' | 'management-recovery' | 'confirmation' | 'execution-receipt' | 'normalization';
export type RpcOperation = {
  role: string;
  workflow: RpcWorkflow;
  chainId: number;
  method: string;
  logical: number;
  physical: number;
  retries: number;
  fallbackAttempts: number;
  latencyMs: number;
  errors: number;
};
export type RpcTelemetrySnapshot = {
  generatedAt: number;
  operations: RpcOperation[];
  cache: { tokenHits: number; tokenMisses: number; tokenInvalidations: number; creationHits: number; creationMisses: number; creationInvalidations: number };
  observations: { candidateObservations: number; managementTicks: number; openPositionsLast: number | null };
  pagination: { requests: number; pages: number; splits: number; logsReturned: number; errors: number; latencyMs: number; ranges: Array<{ chainId: number; from: string; to: string; pages: number; splits: number; logsReturned: number }> };
  historicalMemo: { blockHits: number; blockMisses: number; stateHits: number; stateMisses: number; transactionHits: number; transactionMisses: number; logicalReadsAvoided: number; invalidations: number; evictions: number };
};

type Key = string;
const workflowStorage = new AsyncLocalStorage<RpcWorkflow>();

/** Bounded, in-memory telemetry. It is deliberately best-effort and never throws into an RPC call. */
export class RpcTelemetry {
  private readonly rows = new Map<Key, RpcOperation>();
  private readonly maxRows: number;
  private cacheCounters = { tokenHits: 0, tokenMisses: 0, tokenInvalidations: 0, creationHits: 0, creationMisses: 0, creationInvalidations: 0 };
  private observationCounters = { candidateObservations: 0, managementTicks: 0, openPositionsLast: null as number | null };
  private paginationCounters = { requests: 0, pages: 0, splits: 0, logsReturned: 0, errors: 0, latencyMs: 0, ranges: [] as RpcTelemetrySnapshot['pagination']['ranges'] };
  private historicalMemoCounters = { blockHits: 0, blockMisses: 0, stateHits: 0, stateMisses: 0, transactionHits: 0, transactionMisses: 0, logicalReadsAvoided: 0, invalidations: 0, evictions: 0 };
  constructor(readonly role = process.env.VIERO_PROCESS_ROLE ?? 'autonomous', maxRows = 2048) {
    this.maxRows = Math.max(64, maxRows);
  }
  workflow(): RpcWorkflow { return workflowStorage.getStore() ?? 'unknown'; }
  async run<T>(workflow: RpcWorkflow, fn: () => Promise<T>): Promise<T> {
    return workflowStorage.run(workflow, fn);
  }
  logical(chainId: number, method: string, workflow = this.workflow()): void {
    try { this.update(chainId, method, workflow, row => { row.logical += 1; }); } catch { /* telemetry must never affect behavior */ }
  }
  physical(chainId: number, workflow = this.workflow(), ok = true, latencyMs = 0, method = 'unknown'): void {
    try { this.update(chainId, method, workflow, row => { row.physical += 1; row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); } catch { /* best effort */ }
  }
  physicalResult(chainId: number, workflow = this.workflow(), ok = true, latencyMs = 0, method = 'unknown'): void {
    try { this.update(chainId, method, workflow, row => { row.latencyMs += Math.max(0, latencyMs); if (!ok) row.errors += 1; }); } catch { /* best effort */ }
  }
  retry(chainId: number, method = 'unknown', workflow = this.workflow()): void {
    try { this.update(chainId, method, workflow, row => { row.retries += 1; row.fallbackAttempts += 1; }); } catch { /* best effort */ }
  }
  cache(kind: 'token' | 'creation', result: 'hit' | 'miss' | 'invalidation'): void {
    try {
      const suffix = result === 'hit' ? 'Hits' : result === 'miss' ? 'Misses' : 'Invalidations';
      const key = `${kind === 'token' ? 'token' : 'creation'}${suffix}` as keyof typeof this.cacheCounters;
      if (key in this.cacheCounters) this.cacheCounters[key] += 1;
    } catch { /* best effort */ }
  }
  candidateObserved(): void { try { this.observationCounters.candidateObservations += 1; } catch { /* best effort */ } }
  managementTick(openPositions: number): void { try { this.observationCounters.managementTicks += 1; this.observationCounters.openPositionsLast = Math.max(0, openPositions); } catch { /* best effort */ } }
  pagination(chainId: number, from: bigint, to: bigint, pages: number, splits: number, logsReturned: number, latencyMs: number, error = false): void {
    try {
      this.paginationCounters.requests += pages;
      this.paginationCounters.pages += pages;
      this.paginationCounters.splits += splits;
      this.paginationCounters.logsReturned += Math.max(0, logsReturned);
      this.paginationCounters.latencyMs += Math.max(0, latencyMs);
      if (error) this.paginationCounters.errors += 1;
      if (this.paginationCounters.ranges.length < 256) this.paginationCounters.ranges.push({ chainId, from: from.toString(), to: to.toString(), pages, splits, logsReturned });
    } catch { /* best effort */ }
  }
  historicalMemo(kind: 'block' | 'state' | 'transaction', result: 'hit' | 'miss'): void {
    try {
      const key = `${kind}${result === 'hit' ? 'Hits' : 'Misses'}` as keyof typeof this.historicalMemoCounters;
      if (key in this.historicalMemoCounters) this.historicalMemoCounters[key] += 1;
    } catch { /* best effort */ }
  }
  historicalMemoAvoided(): void { try { this.historicalMemoCounters.logicalReadsAvoided += 1; } catch { /* best effort */ } }
  historicalMemoInvalidation(): void { try { this.historicalMemoCounters.invalidations += 1; } catch { /* best effort */ } }
  historicalMemoEviction(): void { try { this.historicalMemoCounters.evictions += 1; } catch { /* best effort */ } }
  snapshot(): RpcTelemetrySnapshot { return { generatedAt: Date.now() / 1000, operations: [...this.rows.values()].map(row => ({ ...row })), cache: { ...this.cacheCounters }, observations: { ...this.observationCounters }, pagination: { ...this.paginationCounters, ranges: [...this.paginationCounters.ranges] }, historicalMemo: { ...this.historicalMemoCounters } }; }
  reset(): void { this.rows.clear(); this.cacheCounters = { tokenHits: 0, tokenMisses: 0, tokenInvalidations: 0, creationHits: 0, creationMisses: 0, creationInvalidations: 0 }; this.observationCounters = { candidateObservations: 0, managementTicks: 0, openPositionsLast: null }; this.paginationCounters = { requests: 0, pages: 0, splits: 0, logsReturned: 0, errors: 0, latencyMs: 0, ranges: [] }; this.historicalMemoCounters = { blockHits: 0, blockMisses: 0, stateHits: 0, stateMisses: 0, transactionHits: 0, transactionMisses: 0, logicalReadsAvoided: 0, invalidations: 0, evictions: 0 }; }
  private update(chainId: number, method: string, workflow: RpcWorkflow, fn: (row: RpcOperation) => void): void {
    const key = `${this.role}|${workflow}|${chainId}|${method}`;
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= this.maxRows) this.rows.delete(this.rows.keys().next().value!);
      row = { role: this.role, workflow, chainId, method, logical: 0, physical: 0, retries: 0, fallbackAttempts: 0, latencyMs: 0, errors: 0 };
      this.rows.set(key, row);
    }
    fn(row);
  }
}

export const defaultRpcTelemetry = new RpcTelemetry();
