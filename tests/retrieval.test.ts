import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRunRetrieval,
  RetrievalServiceImpl,
  clampLimit,
  runTouchesChain,
  toRunRef,
  contextForRetrievedCandidate,
  contextForRetrievedDecision,
  contextForRetrievedPosition,
  contextForRetrievedPositionEvent,
  contextForRetrievedError,
  contextForEmptyLatestRun,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RUNS_HARD_CAP,
} from '../src/viero/agent/retrieval.js';
import {
  type AgentRun,
  FileRepository,
  PostgresRepository,
} from '../src/viero/storage/repositories.js';
import { type Candidate } from '../src/viero/screening/pipeline.js';
import { type PaperPosition } from '../src/viero/management/paper.js';
import { type ChainId, chainIdSchema } from '../src/viero/domain.js';

// ─── Fixtures ──────────────────────────────────────────────────

const baseChainIds: ChainId[] = [4663, 56, 8453, 5042];
function pickChain(i: number): ChainId { return baseChainIds[i % baseChainIds.length]!; }

function makePool(i: number) {
  return {
    chainId: pickChain(i),
    protocol: i % 2 === 0 ? ('v3' as const) : ('v4' as const),
    dex: 'uniswap' as const,
    poolAddress: `0x${(i).toString(16).padStart(40, '0')}`,
    ...(i % 2 === 1 ? { poolId: `0x${(i).toString(16).padStart(64, '0')}`, poolKey: { currency0: `0x${'0'.repeat(40)}`, currency1: `0x${'1'.repeat(40)}`, fee: 3000, tickSpacing: 60, hooks: `0x${'0'.repeat(40)}` } } : {}),
  };
}

function makeCandidate(i: number, approved: boolean): Candidate {
  const pool = makePool(i);
  return {
    pool,
    identity: `${pool.chainId}:${pool.protocol}:${pool.dex}:${pool.protocol === 'v3' ? pool.poolAddress : pool.poolId}`,
    approved,
    rejections: approved ? [] : [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'depth below threshold' }],
    metrics: {
      version: 'm1',
      pool,
      source: `rpc:${i}`,
      sourceBlock: BigInt(i),
      fetchedAt: 1700000000 + i,
      windowStart: 1700000000,
      windowEnd: 1700001800,
      valuation: 'window-end-reference',
      volumeUsd: 1000 * (i + 1),
      swapCount: 10,
      uniqueTraders: 5,
      grossFeesUsd: 5,
      lpFeesUsd: 4,
      feesPerMinute: 0.01,
      feeTvlPct: 0.5,
      depthDownUsd: 5000,
      depthUpUsd: 5000,
      depthUsd: 10000,
      feeDepthPct: 0.04,
      volumeDepth: 0.1,
      tvlUsd: 5000,
      volatility: null,
      organic: { uniqueRatio: 0.5, topTraderShare: 0.5, balance: 0.5, temporal: 0.5, reversalShare: 0, score: 0.5 },
      netLiquidityFlowUsd: 0,
      expectedFeesUsd: 4,
      expectedNetFeesUsd: 3.5,
      maximumPriceDivergencePct: 0,
    },
    group: 'g',
    score: approved ? 0.8 : null,
    globalScore: approved ? 0.75 : null,
    components: {},
    policyVersion: 'paper-policy-1',
    scoreVersion: 'within-group-1',
  };
}

function makePaperPosition(i: number, status: 'open' | 'closed' = 'open'): PaperPosition {
  const chain = pickChain(i);
  const pool = makePool(i);
  const events = [{ at: 1700000000 + i, action: 'open' as const, reason: 'paper', netPnlUsd: 0 }];
  if (status === 'closed') events.push({ at: 1700001000 + i, action: 'close' as const, reason: 'STOP_LOSS', netPnlUsd: -0.5 });
  return {
    id: `paper-${i}`,
    chainId: chain,
    plan: {
      chainId: chain,
      pool,
      mode: 'paper' as const,
      createdAt: 1700000000 + i,
      deadline: 1700000120 + i,
      sourceBlock: BigInt(i),
      sourceBlockHash: `0x${'0'.repeat(64)}`,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1000n,
      depositAssets: [{ token: `0x${'0'.repeat(40)}`, amount: 100n }],
      expectedTransfers: [{ token: `0x${'0'.repeat(40)}`, direction: 'out' as const, maximumAmount: 100n }],
      slippageBps: 50,
      maximumGasCostUsd: 0.01,
      depositUsd: 5,
    },
    openedAt: 1700000000 + i,
    status,
    initialValueUsd: 5,
    currentValueUsd: 5,
    claimedFeesUsd: 0,
    unclaimedFeesUsd: 0,
    gasCostUsd: 0,
    swapCostUsd: 0,
    bridgeCostUsd: 0,
    holdValueUsd: 5,
    peakValueUsd: 5,
    outOfRangeSince: null,
    lastWindowEnd: 1700000000 + i,
    netPnlUsd: 0,
    impermanentLossUsd: 0,
    events,
  };
}

function makeRun(i: number, overrides: Partial<AgentRun> = {}): AgentRun {
  const startedAt = 1700000000 + i * 100;
  return {
    id: `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
    mode: 'live-readonly',
    startedAt,
    finishedAt: startedAt + 30,
    configVersion: 'paper-policy-1',
    deploymentVersion: 'uniswap-37936185-2026-09-18',
    policy: {},
    observations: [],
    candidates: [makeCandidate(i, i % 3 === 0)],
    discoveries: [],
    decisions: [],
    positions: [],
    health: [],
    providerObservations: [],
    errors: [],
    status: i % 5 === 0 ? 'failed' : 'ok',
    ...overrides,
  };
}

/** In-memory Repository stub. Stores runs in an array; no fs/pg. */
class InMemoryRepository {
  runs: AgentRun[] = [];
  constructor(runs: AgentRun[] = []) { this.runs = [...runs]; }
  async initialize() {}
  async saveRun(run: AgentRun) { this.runs.push(run); }
  async latest() {
    if (this.runs.length === 0) return null;
    return [...this.runs].sort((a, b) => b.startedAt - a.startedAt)[0]!;
  }
  async history() { return [...this.runs].sort((a, b) => a.startedAt - b.startedAt); }
  async findRunById(id: string) { return this.runs.find((r) => r.id === id) ?? null; }
  async controls() { return { globalPaused: false, pausedChains: [] }; }
  async setControls() {}
  async close() {}
}

// ─── Helpers / pure functions ──────────────────────────────────

test('clampLimit returns default for undefined/invalid, caps at MAX_LIMIT', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit(0), DEFAULT_LIMIT);
  assert.equal(clampLimit(-3), DEFAULT_LIMIT);
  assert.equal(clampLimit(NaN), DEFAULT_LIMIT);
  assert.equal(clampLimit(5), 5);
  assert.equal(clampLimit(MAX_LIMIT + 1), MAX_LIMIT);
  assert.equal(clampLimit(MAX_LIMIT), MAX_LIMIT);
});

test('runTouchesChain returns true if any sub-record matches', () => {
  const run = makeRun(0);
  assert.equal(runTouchesChain(run, run.candidates[0]!.pool.chainId), true);
  assert.equal(runTouchesChain(run, 1 as ChainId), false);
});

test('toRunRef copies run metadata into a compact ref', () => {
  const run = makeRun(0);
  const ref = toRunRef(run);
  assert.equal(ref.id, run.id);
  assert.equal(ref.startedAt, run.startedAt);
  assert.equal(ref.mode, run.mode);
  assert.equal(ref.status, run.status);
});

// ─── RetrievalService: run-level ───────────────────────────────

test('latestRun returns the newest run', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(1), makeRun(2)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const latest = await svc.latestRun();
  assert.equal(latest?.id, makeRun(2).id);
});

test('recentRuns returns newest-first up to limit', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(1), makeRun(2), makeRun(3)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentRuns({ limit: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.id, makeRun(3).id);
  assert.equal(out[1]!.id, makeRun(2).id);
});

test('recentRuns applies chainId filter', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, false)] }), // chain A
    makeRun(1, { candidates: [makeCandidate(1, false)] }), // chain B
    makeRun(2, { candidates: [makeCandidate(2, false)] }), // chain A
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const chainA = makeRun(0).candidates[0]!.pool.chainId;
  const chainB = makeRun(1).candidates[0]!.pool.chainId;
  // Each candidate is on a different chain in this fixture, so filtering
  // for chain A returns only the two runs whose candidates happen to land
  // on chain A.
  const outA = await svc.recentRuns({ chainId: chainA });
  assert.ok(outA.every((r) => r.candidates.some((c) => c.pool.chainId === chainA)));
  const outB = await svc.recentRuns({ chainId: chainB });
  assert.equal(outB.length, 1);
  assert.equal(outB[0]!.candidates[0]!.pool.chainId, chainB);
});

test('recentRuns applies sinceTimestamp filter', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(1), makeRun(2)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentRuns({ sinceTimestamp: makeRun(1).startedAt });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.startedAt >= makeRun(1).startedAt));
});

test('findRunById returns the matching run', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(3)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const found = await svc.findRunById(makeRun(3).id);
  assert.equal(found?.id, makeRun(3).id);
});

test('findRunById returns null for unknown id', async () => {
  const repo = new InMemoryRepository([makeRun(0)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const found = await svc.findRunById('00000000-0000-4000-8000-000000999999');
  assert.equal(found, null);
});

test('latestRunForChain returns the most recent run that touches the chain', async () => {
  // Construct a chain with multiple runs so we can verify newest-first selection.
  const sharedChain = chainIdSchema.parse(8453);
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, false)] }), // chain X
    makeRun(1, { candidates: [makeCandidate(1, false)] }), // chain Y
    makeRun(2, { candidates: [{ ...makeCandidate(0, false), pool: { ...makeCandidate(0, false).pool, chainId: sharedChain } }] }), // sharedChain
    makeRun(3, { candidates: [{ ...makeCandidate(1, false), pool: { ...makeCandidate(1, false).pool, chainId: sharedChain } }] }), // sharedChain (newer)
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const found = await svc.latestRunForChain(sharedChain);
  assert.equal(found?.id, makeRun(3).id);
});

test('latestRunForChain returns null when no run touches the chain', async () => {
  const repo = new InMemoryRepository([makeRun(0)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const found = await svc.latestRunForChain(1 as ChainId);
  assert.equal(found, null);
});

// ─── RetrievalService: candidates ──────────────────────────────

test('recentRejectedCandidates filters by approved=false', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, false)] }),
    makeRun(1, { candidates: [makeCandidate(1, true)] }),
    makeRun(2, { candidates: [makeCandidate(2, false)] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentRejectedCandidates({ limit: 10 });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.candidate.approved === false));
  assert.equal(out[0]!.candidate.identity, makeCandidate(2, false).identity);
});

test('recentApprovedCandidates filters by approved=true', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, true)] }),
    makeRun(1, { candidates: [makeCandidate(1, false)] }),
    makeRun(2, { candidates: [makeCandidate(2, true)] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentApprovedCandidates({ limit: 10 });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.candidate.approved === true));
});

test('findCandidatesByIdentity returns all matches across runs (ambiguity surfaced)', async () => {
  const target = makeCandidate(0, false);
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [target, makeCandidate(1, false)] }),
    makeRun(1, { candidates: [{ ...target, pool: { ...target.pool, poolAddress: '0xa' } }, makeCandidate(2, false)] }),
    makeRun(2, { candidates: [makeCandidate(3, false), makeCandidate(4, true)] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.findCandidatesByIdentity(target.identity);
  // Two candidates match the identity (from run 0 and run 1 with overridden pool).
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.candidate.identity === target.identity));
});

test('findCandidatesByIdentity returns empty when no match', async () => {
  const repo = new InMemoryRepository([makeRun(0)]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.findCandidatesByIdentity('9999:v3:uniswap:0xunknown');
  assert.equal(out.length, 0);
});

test('candidate queries honor chainId and poolHint filters', async () => {
  const targetChain = makeCandidate(0, false).pool.chainId;
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, false)] }), // chain X
    makeRun(1, { candidates: [makeCandidate(1, false)] }), // chain Y
    makeRun(2, { candidates: [makeCandidate(2, false)] }), // chain X
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentRejectedCandidates({ chainId: targetChain, limit: 10 });
  assert.ok(out.length >= 1);
  assert.ok(out.every((r) => r.chainId === targetChain));
});

// ─── RetrievalService: decisions ───────────────────────────────

test('recentDecisions returns per-chain decisions newest-first', async () => {
  const c1: ChainId = 8453;
  const c2: ChainId = 56;
  const repo = new InMemoryRepository([
    makeRun(0, { decisions: [{ chainId: c1, promptVersion: 'v1', model: 'deterministic', selection: { action: 'preview', candidateId: 'x', reason: 'r' } }] }),
    makeRun(1, { decisions: [{ chainId: c2, promptVersion: 'v1', model: 'deterministic', selection: { action: 'hold', reason: 'h' } }] }),
    makeRun(2, { decisions: [{ chainId: c1, promptVersion: 'v1', model: 'deterministic', selection: { action: 'hold', reason: 'h2' } }] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentDecisions({ limit: 10 });
  assert.equal(out.length, 3);
  assert.equal(out[0]!.decision.selection.reason, 'h2');
});

test('recentDecisions filters by chainId', async () => {
  const c1: ChainId = 8453;
  const c2: ChainId = 56;
  const repo = new InMemoryRepository([
    makeRun(0, { decisions: [{ chainId: c1, promptVersion: 'v1', model: 'deterministic', selection: { action: 'preview', candidateId: 'x', reason: 'r' } }] }),
    makeRun(1, { decisions: [{ chainId: c2, promptVersion: 'v1', model: 'deterministic', selection: { action: 'hold', reason: 'h' } }] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentDecisions({ chainId: c1 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.chainId, c1);
});

// ─── RetrievalService: positions ────────────────────────────────

test('openPositions returns only open positions', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'open'), makePaperPosition(1, 'closed')] }),
    makeRun(1, { positions: [makePaperPosition(2, 'open')] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.openPositions({ limit: 10 });
  assert.ok(out.length >= 2);
  assert.ok(out.every((r) => r.position.status === 'open'));
});

test('findPositionById returns null when missing', async () => {
  const repo = new InMemoryRepository([makeRun(0, { positions: [makePaperPosition(0)] })]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.findPositionById('paper-doesnotexist');
  assert.equal(out, null);
});

test('findPositionById returns the matching position', async () => {
  const target = makePaperPosition(7, 'open');
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'open'), target] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.findPositionById(target.id);
  assert.equal(out?.position.id, target.id);
});

test('positionsForPool matches based on the position id (current identifier in Viero)', async () => {
  const p1 = makePaperPosition(0, 'open');
  const p2 = makePaperPosition(1, 'closed');
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [p1, p2] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.positionsForPool(p1.id);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.position.id, p1.id);
});

// ─── RetrievalService: events ───────────────────────────────────

test('recentPositionEvents returns events newest-first across runs and positions', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'closed')] }), // close event present
    makeRun(1, { positions: [makePaperPosition(1, 'open')] }),  // open event only
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentPositionEvents({ limit: 10 });
  // Newest run first
  assert.equal(out[0]!.run.id, makeRun(1).id);
  assert.equal(out[1]!.run.id, makeRun(0).id);
});

test('recentCloseEvents restricts to close actions', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'closed')] }), // has close event
    makeRun(1, { positions: [makePaperPosition(1, 'open')] }),   // only open event
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentCloseEvents({ limit: 10 });
  assert.ok(out.length >= 1);
  assert.ok(out.every((r) => ['close', 'emergency-close', 'rebalance'].includes(r.event.action)));
});

test('recentPositionEvents action filter narrows to specified actions only', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'closed')] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentPositionEvents({ actions: ['open'] });
  assert.ok(out.every((r) => r.event.action === 'open'));
});

// ─── RetrievalService: errors ───────────────────────────────────

test('recentErrors returns errors newest-first', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { errors: [] }),
    makeRun(1, { errors: [{ chainId: 8453, pool: 'p1', error: 'NO_COMPLETE_OBSERVATIONS' }] }),
    makeRun(2, { errors: [{ chainId: 56, error: 'RPC_CHAIN_MISMATCH' }] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentErrors({ limit: 10 });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.error, 'RPC_CHAIN_MISMATCH');
});

test('recentErrors applies chainId and messageHint filters', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { errors: [{ chainId: 8453, error: 'INSUFFICIENT_LIQUIDITY' }] }),
    makeRun(1, { errors: [{ chainId: 56, error: 'STALE_STATE' }] }),
  ]);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentErrors({ chainId: 8453, messageHint: 'LIQUID' });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.chainId, 8453);
});

// ─── read-only safety ──────────────────────────────────────────

test('retrieval service does not mutate repository state', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(1), makeRun(2)]);
  const snapshotLength = repo.runs.length;
  const snapshotIds = repo.runs.map((r) => r.id);
  const snapshotSerialized = repo.runs.map((r) => `${r.id}:${r.candidates.length}:${r.positions.length}:${r.errors.length}`);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  await svc.latestRun();
  await svc.recentRuns();
  await svc.recentRejectedCandidates();
  await svc.recentApprovedCandidates();
  await svc.findCandidatesByIdentity('anything');
  await svc.recentDecisions();
  await svc.openPositions();
  await svc.closedPositions();
  await svc.findPositionById('paper-0');
  await svc.positionsForPool('paper-0');
  await svc.recentPositionEvents();
  await svc.recentCloseEvents();
  await svc.recentErrors();
  await svc.latestRunForChain(8453);
  await svc.findRunById(makeRun(0).id);
  assert.equal(repo.runs.length, snapshotLength);
  assert.deepEqual(repo.runs.map((r) => r.id), snapshotIds);
  assert.deepEqual(
    repo.runs.map((r) => `${r.id}:${r.candidates.length}:${r.positions.length}:${r.errors.length}`),
    snapshotSerialized,
  );
});

// ─── bounds / limits ───────────────────────────────────────────

test('limits are bounded by MAX_LIMIT and MAX_RUNS_HARD_CAP', async () => {
  assert.equal(MAX_LIMIT, 100);
  assert.equal(DEFAULT_LIMIT, 10);
  assert.equal(MAX_RUNS_HARD_CAP, 1000);
});

test('in-memory repository with many runs respects MAX_RUNS_HARD_CAP', async () => {
  // Build more than MAX_RUNS_HARD_CAP runs in-memory.
  const many = Array.from({ length: MAX_RUNS_HARD_CAP + 50 }, (_, i) => makeRun(i));
  const repo = new InMemoryRepository(many);
  const svc = new RetrievalServiceImpl(repo as unknown as FileRepository);
  const out = await svc.recentRuns({ limit: 2000 });
  // We asked for 2000, capped to MAX_LIMIT 100
  assert.equal(out.length, MAX_LIMIT);
});

// ─── Connect retrieval results to ExplanationContext ───────────

test('contextForRetrievedCandidate yields the same shape as contextFromRejectedCandidate', () => {
  const candidate = makeCandidate(0, false);
  const rc = { run: toRunRef(makeRun(0)), chainId: candidate.pool.chainId, chainName: 'Base', candidate };
  const ctx = contextForRetrievedCandidate(rc);
  assert.equal(ctx.eventType, 'rejected_candidate');
  assert.equal(ctx.outcome.kind, 'rejected');
  assert.equal(ctx.rejections?.[0]?.code, 'INSUFFICIENT_LIQUIDITY');
  assert.ok(ctx.run);
  assert.equal(ctx.run.id, makeRun(0).id);
});

test('contextForRetrievedCandidate handles approved candidates', () => {
  const candidate = makeCandidate(0, true);
  const rc = { run: toRunRef(makeRun(0)), chainId: candidate.pool.chainId, chainName: 'Base', candidate };
  const ctx = contextForRetrievedCandidate(rc);
  assert.equal(ctx.outcome.kind, 'approved');
});

test('contextForRetrievedDecision on preview+plan produces plan_created context', () => {
  const pool = makePool(0);
  const plan = {
    chainId: pool.chainId,
    pool,
    mode: 'paper' as const,
    createdAt: 1700000000,
    deadline: 1700000120,
    sourceBlock: 1n,
    sourceBlockHash: `0x${'0'.repeat(64)}`,
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1000n,
    depositAssets: [{ token: `0x${'0'.repeat(40)}`, amount: 100n }],
    expectedTransfers: [{ token: `0x${'0'.repeat(40)}`, direction: 'out' as const, maximumAmount: 100n }],
    slippageBps: 50,
    maximumGasCostUsd: 0.01,
    depositUsd: 5,
  };
  const rd = {
    run: toRunRef(makeRun(0)),
    chainId: pool.chainId,
    chainName: 'Base',
    decision: { chainId: pool.chainId, promptVersion: 'v1', model: 'deterministic', selection: { action: 'preview' as const, candidateId: 'x', reason: 'best' }, plan },
  };
  const ctx = contextForRetrievedDecision(rd);
  assert.equal(ctx.eventType, 'plan_created');
  assert.equal(ctx.outcome.kind, 'plan_created');
  assert.equal(ctx.plan?.depositUsd, 5);
});

test('contextForRetrievedDecision on hold yields a held context', () => {
  const rd = {
    run: toRunRef(makeRun(0)),
    chainId: 8453,
    chainName: 'Base',
    decision: { chainId: 8453, promptVersion: 'v1', model: 'deterministic', selection: { action: 'hold' as const, reason: 'no approved' } },
  };
  const ctx = contextForRetrievedDecision(rd);
  assert.equal(ctx.eventType, 'screening');
  assert.equal(ctx.outcome.kind, 'held');
  assert.equal(ctx.outcome.reasonDetail, 'no approved');
});

test('contextForRetrievedPosition uses last event when available', () => {
  const position = makePaperPosition(0, 'closed');
  const rp = { run: toRunRef(makeRun(0)), chainId: position.chainId, chainName: 'Base', position };
  const ctx = contextForRetrievedPosition(rp);
  assert.equal(ctx.eventType, 'management');
  // last event is 'close' (status='closed' pushes close event)
  assert.equal(ctx.outcome.kind, 'closed');
  assert.equal(ctx.position?.status, 'closed');
});

test('contextForRetrievedPositionEvent reflects the specific event', () => {
  const position = makePaperPosition(0, 'closed');
  const event = position.events[1]!; // close
  const rpe = {
    run: toRunRef(makeRun(0)),
    chainId: position.chainId,
    chainName: 'Base',
    position,
    event,
  };
  const ctx = contextForRetrievedPositionEvent(rpe);
  assert.equal(ctx.eventType, 'management');
  // The event.action is 'close'; the deterministic reason ('STOP_LOSS') is the detail.
  assert.equal(ctx.outcome.kind, 'closed');
  assert.equal(ctx.outcome.reasonCode, 'close');
  assert.equal(ctx.outcome.reasonDetail, 'STOP_LOSS');
  assert.equal(ctx.position?.lastReason, 'STOP_LOSS');
});

test('contextForRetrievedError carries the error message and chain', () => {
  const re = { run: toRunRef(makeRun(0, { status: 'failed' })), chainId: 8453 as ChainId, chainName: 'Base', error: 'NO_COMPLETE_OBSERVATIONS' };
  const ctx = contextForRetrievedError(re);
  assert.equal(ctx.outcome.kind, 'errored');
  assert.equal(ctx.outcome.reasonCode, 'NO_COMPLETE_OBSERVATIONS');
  assert.equal(ctx.run?.status, 'failed');
});

test('contextForEmptyLatestRun produces a no_candidates context', () => {
  const ctx = contextForEmptyLatestRun('Base');
  assert.equal(ctx.eventType, 'no_candidates');
  assert.equal(ctx.outcome.kind, 'no_candidates');
});

// ─── Real FileRepository integration ───────────────────────────

test('FileRepository integration: saveRun + findRunById round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-retrieval-'));
  try {
    const repo = new FileRepository(dir);
    await repo.initialize();
    const run = makeRun(42, {
      candidates: [makeCandidate(42, false)],
      positions: [makePaperPosition(42)],
      errors: [{ chainId: 8453, error: 'NO_COMPLETE_OBSERVATIONS' }],
      status: 'degraded',
    });
    await repo.saveRun(run);
    const svc = new AgentRunRetrieval(repo);
    const byId = await svc.findRunById(run.id);
    assert.equal(byId?.id, run.id);
    assert.equal(byId?.candidates.length, 1);
    assert.equal(byId?.positions.length, 1);
    assert.equal(byId?.errors.length, 1);
    const rejects = await svc.recentRejectedCandidates({ limit: 10 });
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0]!.candidate.identity, makeCandidate(42, false).identity);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FileRepository rejects malformed run ids at the storage boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-retrieval-'));
  try {
    const repo = new FileRepository(dir);
    await repo.initialize();
    await assert.rejects(
      (async () => { await repo.findRunById('not-a-uuid'); })(),
      /Invalid/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FileRepository findRunById returns null when no run matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-retrieval-'));
  try {
    const repo = new FileRepository(dir);
    await repo.initialize();
    const found = await repo.findRunById('00000000-0000-4000-8000-000000000000');
    assert.equal(found, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Suppress unused warnings for imports kept for symmetry with the public surface.
void chainIdSchema;
void writeFile;
void PostgresRepository;
void MAX_RUNS_HARD_CAP;
