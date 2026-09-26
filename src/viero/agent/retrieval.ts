/**
 * Read-only decision/event retrieval service.
 *
 * Sits on top of the existing `Repository` abstraction. Answers the
 * question "which actual Viero event/decision is the user referring to?"
 * by locating typed structured records in the persisted history.
 *
 * Strict guarantees:
 *   - READ-ONLY: never mutates AgentRun, positions, candidates, controls,
 *     or any other Viero state.
 *   - NO LLM: never instantiates or calls an LlmClient. The retrieval
 *     layer only finds facts; the explanation layer (DecisionExplainer)
 *     explains them.
 *   - NO INVENTED FACTS: when a record lacks a field (e.g. live token
 *     symbols, on-chain transaction hashes, wallet balances), the field
 *     is simply absent from the returned object. Callers can build an
 *     ExplanationContext without speculating.
 *
 * Limits:
 *   - Bounded result sizes on every "recent" query (default 10, max 100).
 *   - In-memory filtering: file and Postgres repositories both expose
 *     `history()` which returns all runs. For deployments with thousands
 *     of runs this becomes expensive. The MAX_RUNS_HARD_CAP below is a
 *     safety net. For Postgres deployments with many runs, prefer
 *     extending the schema with indexable columns.
 */
import { type ChainId } from '../domain.js';
import { type Candidate } from '../screening/pipeline.js';
import { type PaperPosition, type ManagementAction } from '../management/paper.js';
import { type AgentRun, type Repository } from '../storage/repositories.js';
import { getChain } from '../config/chains.js';
import {
  contextFromApprovedCandidate,
  contextFromError,
  contextFromManagement,
  contextFromNoCandidates,
  contextFromPlanBlocked,
  contextFromPlanCreated,
  contextFromRejectedCandidate,
  type ExplanationContext,
} from './explanationContext.js';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
/**
 * Hard ceiling on the number of runs loaded per query. Protects against
 * unbounded memory growth when a deployment has thousands of runs.
 */
export const MAX_RUNS_HARD_CAP = 1000;

// ─── Result wrapper types ──────────────────────────────────────

export type RunRef = {
  id: string;
  startedAt: number;
  finishedAt: number;
  mode: 'live-readonly' | 'live-execution' | 'replay';
  status: 'ok' | 'degraded' | 'failed';
};

export type { AgentRun };

export type RetrievedCandidate = {
  run: RunRef;
  chainId: ChainId;
  chainName: string;
  candidate: Candidate;
};

export type RetrievedDecision = {
  run: RunRef;
  chainId: ChainId;
  chainName: string;
  decision: AgentRun['decisions'][number];
};

export type RetrievedPosition = {
  run: RunRef;
  chainId: ChainId;
  chainName: string;
  position: PaperPosition;
};

export type RetrievedPositionEvent = {
  run: RunRef;
  chainId: ChainId;
  chainName: string;
  position: PaperPosition;
  event: PaperPosition['events'][number];
};

export type RetrievedError = {
  run: RunRef;
  chainId: ChainId;
  chainName: string;
  pool?: string;
  error: string;
};

// ─── Query option types ─────────────────────────────────────────

export type RunQueryOptions = {
  chainId?: ChainId;
  limit?: number;
  /** Only include runs whose `startedAt >= sinceTimestamp`. */
  sinceTimestamp?: number;
};

export type CandidateQueryOptions = {
  chainId?: ChainId;
  /** Substring match against pool identity or address. */
  poolHint?: string;
  limit?: number;
  sinceTimestamp?: number;
};

export type PositionQueryOptions = {
  chainId?: ChainId;
  limit?: number;
  sinceTimestamp?: number;
};

export type PositionEventQueryOptions = {
  /** Restrict to specific actions (e.g. 'close', 'rebalance', 'emergency-close', 'claim', 'hold', 'pause', 'open'). */
  actions?: ReadonlyArray<ManagementAction>;
  chainId?: ChainId;
  poolHint?: string;
  limit?: number;
  sinceTimestamp?: number;
};

export type ErrorQueryOptions = {
  chainId?: ChainId;
  /** Substring match against error message. */
  messageHint?: string;
  limit?: number;
  sinceTimestamp?: number;
};

export type DecisionQueryOptions = {
  chainId?: ChainId;
  limit?: number;
  sinceTimestamp?: number;
};

// ─── Service interface ─────────────────────────────────────────

export interface RetrievalService {
  // Run-level queries
  latestRun(): Promise<AgentRun | null>;
  recentRuns(options?: RunQueryOptions): Promise<AgentRun[]>;
  findRunById(id: string): Promise<AgentRun | null>;
  latestRunForChain(chainId: ChainId): Promise<AgentRun | null>;

  // Candidate queries
  recentRejectedCandidates(options?: CandidateQueryOptions): Promise<RetrievedCandidate[]>;
  recentApprovedCandidates(options?: CandidateQueryOptions): Promise<RetrievedCandidate[]>;
  findCandidatesByIdentity(identity: string, options?: { limit?: number; sinceTimestamp?: number }): Promise<RetrievedCandidate[]>;

  // Decision queries
  recentDecisions(options?: DecisionQueryOptions): Promise<RetrievedDecision[]>;

  // Position queries
  openPositions(options?: PositionQueryOptions): Promise<RetrievedPosition[]>;
  closedPositions(options?: PositionQueryOptions): Promise<RetrievedPosition[]>;
  findPositionById(id: string): Promise<RetrievedPosition | null>;
  positionsForPool(identity: string, options?: { limit?: number }): Promise<RetrievedPosition[]>;

  // Event queries
  recentPositionEvents(options?: PositionEventQueryOptions): Promise<RetrievedPositionEvent[]>;
  recentCloseEvents(options?: PositionEventQueryOptions): Promise<RetrievedPositionEvent[]>;

  // Error queries
  recentErrors(options?: ErrorQueryOptions): Promise<RetrievedError[]>;
}

// ─── Service implementation ─────────────────────────────────────

export class AgentRunRetrieval implements RetrievalService {
  constructor(private readonly repository: Repository) {}

  async latestRun(): Promise<AgentRun | null> {
    return this.repository.latest();
  }

  async recentRuns(options: RunQueryOptions = {}): Promise<AgentRun[]> {
    const { chainId, sinceTimestamp } = options;
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const filtered: AgentRun[] = [];
    for (const run of all) {
      if (filtered.length >= limit) break;
      if (chainId !== undefined && !runTouchesChain(run, chainId)) continue;
      if (sinceTimestamp !== undefined && run.startedAt < sinceTimestamp) continue;
      filtered.push(run);
    }
    return filtered;
  }

  async findRunById(id: string): Promise<AgentRun | null> {
    return this.repository.findRunById(id);
  }

  async latestRunForChain(chainId: ChainId): Promise<AgentRun | null> {
    const all = await this.loadRunsNewestFirst();
    for (const run of all) {
      if (runTouchesChain(run, chainId)) return run;
    }
    return null;
  }

  async recentRejectedCandidates(options: CandidateQueryOptions = {}): Promise<RetrievedCandidate[]> {
    return this.recentCandidates(options, /*approved=*/ false);
  }

  async recentApprovedCandidates(options: CandidateQueryOptions = {}): Promise<RetrievedCandidate[]> {
    return this.recentCandidates(options, /*approved=*/ true);
  }

  async findCandidatesByIdentity(identity: string, options: { limit?: number; sinceTimestamp?: number } = {}): Promise<RetrievedCandidate[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedCandidate[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const candidate of run.candidates) {
        if (out.length >= limit) break;
        if (candidate.identity !== identity) continue;
        out.push({
          run: toRunRef(run),
          chainId: candidate.pool.chainId,
          chainName: getChain(candidate.pool.chainId).name,
          candidate,
        });
      }
    }
    return out;
  }

  async recentDecisions(options: DecisionQueryOptions = {}): Promise<RetrievedDecision[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedDecision[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const decision of run.decisions) {
        if (out.length >= limit) break;
        if (options.chainId !== undefined && decision.chainId !== options.chainId) continue;
        out.push({
          run: toRunRef(run),
          chainId: decision.chainId,
          chainName: getChain(decision.chainId).name,
          decision,
        });
      }
    }
    return out;
  }

  async openPositions(options: PositionQueryOptions = {}): Promise<RetrievedPosition[]> {
    return this.positionsByStatus('open', options);
  }

  async closedPositions(options: PositionQueryOptions = {}): Promise<RetrievedPosition[]> {
    return this.positionsByStatus('closed', options);
  }

  async findPositionById(id: string): Promise<RetrievedPosition | null> {
    const all = await this.loadRunsNewestFirst();
    for (const run of all) {
      const position = run.positions.find((p) => p.id === id);
      if (position) {
        return {
          run: toRunRef(run),
          chainId: position.chainId,
          chainName: getChain(position.chainId).name,
          position,
        };
      }
    }
    return null;
  }

  async positionsForPool(identity: string, options: { limit?: number } = {}): Promise<RetrievedPosition[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedPosition[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      for (const position of run.positions) {
        if (out.length >= limit) break;
        if (positionIdentity(position) !== identity) continue;
        out.push({
          run: toRunRef(run),
          chainId: position.chainId,
          chainName: getChain(position.chainId).name,
          position,
        });
      }
    }
    return out;
  }

  async recentPositionEvents(options: PositionEventQueryOptions = {}): Promise<RetrievedPositionEvent[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedPositionEvent[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const position of run.positions) {
        if (options.chainId !== undefined && position.chainId !== options.chainId) continue;
        if (options.poolHint !== undefined && !positionIdentity(position).includes(options.poolHint)) continue;
        // Position events are stored oldest-first; iterate oldest-first
        // so newest-first ordering of the OUTPUT list is preserved by
        // pushing all events from a run, then later runs come earlier.
        for (const event of position.events) {
          if (out.length >= limit) break;
          if (options.actions !== undefined && !options.actions.includes(event.action as ManagementAction)) continue;
          out.push({
            run: toRunRef(run),
            chainId: position.chainId,
            chainName: getChain(position.chainId).name,
            position,
            event,
          });
        }
      }
    }
    return out;
  }

  async recentCloseEvents(options: PositionEventQueryOptions = {}): Promise<RetrievedPositionEvent[]> {
    const closeActions: ReadonlyArray<ManagementAction> = ['close', 'emergency-close', 'rebalance'];
    return this.recentPositionEvents({ ...options, actions: closeActions });
  }

  async recentErrors(options: ErrorQueryOptions = {}): Promise<RetrievedError[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedError[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const err of run.errors) {
        if (out.length >= limit) break;
        if (options.chainId !== undefined && err.chainId !== options.chainId) continue;
        if (options.messageHint !== undefined && !err.error.includes(options.messageHint)) continue;
        out.push({
          run: toRunRef(run),
          chainId: err.chainId,
          chainName: getChain(err.chainId).name,
          ...(err.pool !== undefined ? { pool: err.pool } : {}),
          error: err.error,
        });
      }
    }
    return out;
  }

  // ─── private helpers ────────────────────────────────────────────

  private async recentCandidates(options: CandidateQueryOptions, approved: boolean): Promise<RetrievedCandidate[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedCandidate[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const candidate of run.candidates) {
        if (out.length >= limit) break;
        if (candidate.approved !== approved) continue;
        if (options.chainId !== undefined && candidate.pool.chainId !== options.chainId) continue;
        if (options.poolHint !== undefined && !candidate.identity.includes(options.poolHint)) continue;
        out.push({
          run: toRunRef(run),
          chainId: candidate.pool.chainId,
          chainName: getChain(candidate.pool.chainId).name,
          candidate,
        });
      }
    }
    return out;
  }

  private async positionsByStatus(status: 'open' | 'closed', options: PositionQueryOptions): Promise<RetrievedPosition[]> {
    const limit = clampLimit(options.limit);
    const all = await this.loadRunsNewestFirst();
    const out: RetrievedPosition[] = [];
    for (const run of all) {
      if (out.length >= limit) break;
      if (options.sinceTimestamp !== undefined && run.startedAt < options.sinceTimestamp) continue;
      for (const position of run.positions) {
        if (out.length >= limit) break;
        if (position.status !== status) continue;
        if (options.chainId !== undefined && position.chainId !== options.chainId) continue;
        out.push({
          run: toRunRef(run),
          chainId: position.chainId,
          chainName: getChain(position.chainId).name,
          position,
        });
      }
    }
    return out;
  }

  private async loadRunsNewestFirst(): Promise<AgentRun[]> {
    const all = await this.repository.history();
    if (all.length > MAX_RUNS_HARD_CAP) {
      // Truncate oldest. Newest-first ordering puts latest at index 0.
      return all.slice(-MAX_RUNS_HARD_CAP).reverse();
    }
    return [...all].reverse();
  }
}

// ─── Pure helpers (exported for tests + reuse) ──────────────────

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export function runTouchesChain(run: AgentRun, chainId: ChainId): boolean {
  if (run.decisions.some((d) => d.chainId === chainId)) return true;
  if (run.candidates.some((c) => c.pool.chainId === chainId)) return true;
  if (run.positions.some((p) => p.chainId === chainId)) return true;
  if (run.errors.some((e) => e.chainId === chainId)) return true;
  return false;
}

export function positionIdentity(position: PaperPosition): string {
  return position.id;
}

export function toRunRef(run: AgentRun): RunRef {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    mode: run.mode,
    status: run.status,
  };
}

// ─── Convenience: build an ExplanationContext from a retrieved record ──
//
// These adapters are thin: they call the existing explanationContext
// helpers where possible, and pass through `run` info as supplementary
// fields on the returned context. The retrieval layer never generates
// English text — it only locates facts.

export function contextForRetrievedCandidate(rc: RetrievedCandidate): ExplanationContext {
  const base = rc.candidate.approved
    ? contextFromApprovedCandidate({ candidate: rc.candidate, chainName: rc.chainName, timestamp: rc.run.startedAt })
    : contextFromRejectedCandidate({ candidate: rc.candidate, chainName: rc.chainName, timestamp: rc.run.startedAt });
  return { ...base, run: { id: rc.run.id, mode: rc.run.mode, startedAt: rc.run.startedAt, status: rc.run.status } };
}

export function contextForRetrievedDecision(rd: RetrievedDecision): ExplanationContext {
  const plan = rd.decision.plan;
  if (rd.decision.selection.action === 'preview' && plan) {
    return contextFromPlanCreated({
      candidate: {
        pool: plan.pool,
        identity: `${plan.chainId}:${plan.pool.protocol}:${plan.pool.dex}:${plan.pool.protocol === 'v3' ? plan.pool.poolAddress : plan.pool.poolId}`,
        approved: true,
        rejections: [],
        metrics: emptyMetricsStub(),
        group: 'retrieval',
        score: null,
        globalScore: null,
        components: {},
        policyVersion: '',
        scoreVersion: '',
      },
      plan,
      chainName: rd.chainName,
      timestamp: rd.run.startedAt,
    });
  }
  return {
    eventType: 'screening',
    timestamp: rd.run.startedAt,
    chain: { id: rd.chainId, name: rd.chainName },
    outcome: {
      kind: rd.decision.selection.action === 'preview' ? 'preview' : 'held',
      reasonCode: rd.decision.selection.action,
      reasonDetail: rd.decision.selection.reason,
    },
    run: { id: rd.run.id, mode: rd.run.mode, startedAt: rd.run.startedAt, status: rd.run.status },
  };
}

export function contextForRetrievedError(re: RetrievedError): ExplanationContext {
  return {
    ...contextFromError({
      error: re.error,
      chainId: re.chainId,
      chainName: re.chainName,
      timestamp: re.run.startedAt,
      runStatus: re.run.status === 'failed' ? 'failed' : 'degraded',
    }),
    run: { id: re.run.id, mode: re.run.mode, startedAt: re.run.startedAt, status: re.run.status },
  };
}

export function contextForRetrievedPositionEvent(rpe: RetrievedPositionEvent): ExplanationContext {
  const base = contextFromManagement({
    position: rpe.position,
    decision: { action: rpe.event.action, reason: rpe.event.reason },
    chainName: rpe.chainName,
    timestamp: rpe.event.at,
  });
  return { ...base, run: { id: rpe.run.id, mode: rpe.run.mode, startedAt: rpe.run.startedAt, status: rpe.run.status } };
}

export function contextForRetrievedPosition(rp: RetrievedPosition): ExplanationContext {
  const lastEvent = rp.position.events.at(-1);
  if (!lastEvent) {
    return {
      eventType: 'management',
      timestamp: rp.position.openedAt,
      chain: { id: rp.chainId, name: rp.chainName },
      outcome: { kind: 'plan_created' },
      position: {
        identity: rp.position.id,
        status: rp.position.status,
        initialValueUsd: rp.position.initialValueUsd,
        currentValueUsd: rp.position.currentValueUsd,
        netPnlUsd: rp.position.netPnlUsd,
        unclaimedFeesUsd: rp.position.unclaimedFeesUsd,
        claimedFeesUsd: rp.position.claimedFeesUsd,
      },
      run: { id: rp.run.id, mode: rp.run.mode, startedAt: rp.run.startedAt, status: rp.run.status },
    };
  }
  return {
    ...contextFromManagement({
      position: rp.position,
      decision: { action: lastEvent.action, reason: lastEvent.reason },
      chainName: rp.chainName,
      timestamp: lastEvent.at,
    }),
    run: { id: rp.run.id, mode: rp.run.mode, startedAt: rp.run.startedAt, status: rp.run.status },
  };
}

export function contextForEmptyLatestRun(chainName?: string): ExplanationContext {
  return contextFromNoCandidates({
    ...(chainName !== undefined ? { chainName } : {}),
  });
}

// Used by contextForRetrievedDecision when we don't have the original
// Candidate record (decisions only carry the plan + selection). The LLM
// will not see this stub — only the structured plan fields.
function emptyMetricsStub(): Candidate['metrics'] {
  return {
    version: 'retrieval-stub',
    pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0' },
    source: 'retrieval',
    sourceBlock: 0n,
    fetchedAt: 0,
    windowStart: 0,
    windowEnd: 0,
    valuation: 'historical-usd',
    volumeUsd: 0,
    swapCount: 0,
    uniqueTraders: 0,
    grossFeesUsd: 0,
    lpFeesUsd: null,
    feesPerMinute: null,
    feeTvlPct: null,
    depthDownUsd: null,
    depthUpUsd: null,
    depthUsd: null,
    feeDepthPct: null,
    volumeDepth: null,
    tvlUsd: null,
    volatility: null,
    organic: { uniqueRatio: 0, topTraderShare: 0, balance: 0, temporal: 0, reversalShare: 0, score: 0 },
    netLiquidityFlowUsd: null,
    expectedFeesUsd: null,
    expectedNetFeesUsd: null,
    maximumPriceDivergencePct: null,
  };
}

export { AgentRunRetrieval as RetrievalServiceImpl };
