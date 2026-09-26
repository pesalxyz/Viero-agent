/**
 * Strongly-typed explanation context for the decision-explanation layer.
 *
 * Built exclusively from data Viero already records deterministically
 * (Candidate, Rejection, Selection, PositionPlan, PaperPosition, AgentRun).
 * No blockchain or RPC access lives in this module — callers construct
 * the context from trusted Viero state and pass it to the explainer.
 *
 * Every field except `outcome.kind` is optional. The `outcome` block is
 * the central fact being explained. Other fields are *evidence* that the
 * model may use to flesh out a human-readable explanation; absence of a
 * field means the model must say "unavailable" rather than invent.
 */
import { type ChainId } from '../domain.js';
import { type Rejection, type Candidate } from '../screening/pipeline.js';
import { type PaperPosition } from '../management/paper.js';
import { type PositionPlan } from '../execution/planner.js';

/** Coarse event category. Maps 1:1 to the kind of Viero record that produced it. */
export type ExplanationEventType =
  | 'screening'
  | 'rejected_candidate'
  | 'accepted_candidate'
  | 'candidate_selected_preview'
  | 'plan_created'
  | 'plan_blocked'
  | 'no_candidates'
  | 'management'
  | 'replay'
  | 'run_failed'
  | 'unknown';

export type ExplanationOutcomeKind =
  | 'approved'
  | 'rejected'
  | 'preview'
  | 'plan_created'
  | 'plan_blocked'
  | 'no_candidates'
  | 'held'
  | 'closed'
  | 'emergency_closed'
  | 'rebalanced'
  | 'paused'
  | 'claim'
  | 'errored'
  | 'rejected_chain_paused'
  | 'rejected_no_observations';

export type ExplanationContext = {
  /** Coarse event type — used to select tone and structure of the prompt. */
  eventType: ExplanationEventType;

  /** Unix seconds when the event was recorded, when available. */
  timestamp?: number;

  chain?: {
    id: ChainId;
    name: string;
  };

  /** Pool reference. Matches Candidate.identity exactly when present. */
  pool?: {
    identity: string;
    protocol: 'v3' | 'v4';
    dex: 'uniswap' | 'pancakeswap';
    poolAddress?: string;
    poolId?: string;
  };

  /** Token pair, derived from observation.state when available. */
  tokenPair?: {
    token0: { symbol: string; address: string };
    token1: { symbol: string; address: string };
  };

  /** The central fact being explained. */
  outcome: {
    kind: ExplanationOutcomeKind;
    /** A short code: Rejection.code, ManagementAction+reason, planPosition error code, etc. */
    reasonCode?: string;
    /** Human-readable detail if available (Rejection.detail, errorMessage, etc). */
    reasonDetail?: string;
  };

  /** All rejection codes fired against this candidate, ordered. Empty/absent = no rejections recorded. */
  rejections?: ReadonlyArray<Rejection>;

  /** Policy/score versions that produced the verdict. Useful context for "why". */
  policyVersion?: string;
  scoreVersion?: string;

  /** Selected metrics — only what is actually computed by Viero. Null = unavailable, not zero. */
  metrics?: {
    score?: number | null;
    globalScore?: number | null;
    volumeUsd?: number | null;
    lpFeesUsd?: number | null;
    depthUsd?: number | null;
    depthDownUsd?: number | null;
    depthUpUsd?: number | null;
    expectedNetFeesUsd?: number | null;
    tvlUsd?: number | null;
    feeTvlPct?: number | null;
    organicScore?: number | null;
    uniqueTraders?: number | null;
    maximumPriceDivergencePct?: number | null;
  };

  /** Position facts (management events only). */
  position?: {
    identity: string;
    status?: 'open' | 'closed';
    initialValueUsd?: number;
    currentValueUsd?: number;
    netPnlUsd?: number;
    unclaimedFeesUsd?: number;
    claimedFeesUsd?: number;
    outOfRangeMinutes?: number;
    lastAction?: string;
    /** Free-text reason from PaperPosition.events[].reason for the latest event. */
    lastReason?: string;
  };

  /** Plan facts (only when a PositionPlan was actually created). */
  plan?: {
    mode: 'paper';
    tickLower?: number;
    tickUpper?: number;
    depositUsd?: number;
    maximumGasCostUsd?: number;
    deadline?: number;
  };

  /** Run-level context (cross-event aggregations). */
  run?: {
    id?: string;
    status?: 'ok' | 'degraded' | 'failed';
    mode?: 'live-readonly' | 'live-execution' | 'replay';
    startedAt?: number;
    candidateCount?: number;
    approvedCount?: number;
    rejectedCount?: number;
    errorCount?: number;
  };

  /** Safety/execution block context. */
  safety?: {
    prevented: true;
    reason: string;
  };
};

export type ExplanationSource = 'llm' | 'fallback-disabled' | 'fallback-error' | 'fallback-no-content';

export type ExplanationResult = {
  text: string;
  source: ExplanationSource;
  /** True when the explanation came from the LLM and was non-empty. */
  llmAvailable: boolean;
};

/**
 * Helper: build a context for a rejected candidate directly from a Candidate.
 * Pulls pool, metrics, rejections, policy/score versions in one call.
 */
export function contextFromRejectedCandidate(args: {
  candidate: Candidate;
  chainName: string;
  timestamp?: number;
}): ExplanationContext {
  const { candidate, chainName, timestamp } = args;
  return {
    eventType: 'rejected_candidate',
    timestamp,
    chain: { id: candidate.pool.chainId, name: chainName },
    pool: {
      identity: candidate.identity,
      protocol: candidate.pool.protocol,
      dex: candidate.pool.dex,
      poolAddress: candidate.pool.protocol === 'v3' ? candidate.pool.poolAddress : undefined,
      poolId: candidate.pool.protocol === 'v4' ? candidate.pool.poolId : undefined,
    },
    outcome: {
      kind: 'rejected',
      reasonCode: candidate.rejections[0]?.code,
      reasonDetail: candidate.rejections[0]?.detail,
    },
    rejections: candidate.rejections,
    policyVersion: candidate.policyVersion,
    scoreVersion: candidate.scoreVersion,
    metrics: {
      score: candidate.score,
      globalScore: candidate.globalScore,
      volumeUsd: candidate.metrics.volumeUsd,
      lpFeesUsd: candidate.metrics.lpFeesUsd,
      depthUsd: candidate.metrics.depthUsd,
      depthDownUsd: candidate.metrics.depthDownUsd,
      depthUpUsd: candidate.metrics.depthUpUsd,
      expectedNetFeesUsd: candidate.metrics.expectedNetFeesUsd,
      tvlUsd: candidate.metrics.tvlUsd,
      feeTvlPct: candidate.metrics.feeTvlPct,
      organicScore: candidate.metrics.organic.score,
      uniqueTraders: candidate.metrics.uniqueTraders,
      maximumPriceDivergencePct: candidate.metrics.maximumPriceDivergencePct,
    },
  };
}

/**
 * Helper: build a context for an approved candidate.
 */
export function contextFromApprovedCandidate(args: {
  candidate: Candidate;
  chainName: string;
  timestamp?: number;
}): ExplanationContext {
  const ctx = contextFromRejectedCandidate({
    candidate: { ...args.candidate, approved: true },
    chainName: args.chainName,
    timestamp: args.timestamp,
  });
  return {
    ...ctx,
    eventType: 'accepted_candidate',
    outcome: { kind: 'approved' },
  };
}

/**
 * Helper: build a context for a position-management decision.
 */
export function contextFromManagement(args: {
  position: PaperPosition;
  decision: { action: string; reason: string };
  chainName: string;
  timestamp?: number;
}): ExplanationContext {
  const { position, decision, chainName, timestamp } = args;
  const lastEvent = position.events.at(-1);
  const kind = mapManagementKind(decision.action);
  return {
    eventType: 'management',
    timestamp: timestamp ?? lastEvent?.at,
    chain: { id: position.chainId, name: chainName },
    pool: {
      identity: position.plan.pool.protocol === 'v3'
        ? `${position.plan.pool.chainId}:v3:${position.plan.pool.dex}:${position.plan.pool.poolAddress}`
        : `${position.plan.pool.chainId}:v4:${position.plan.pool.dex}:${position.plan.pool.poolId}`,
      protocol: position.plan.pool.protocol,
      dex: position.plan.pool.dex,
      poolAddress: position.plan.pool.protocol === 'v3' ? position.plan.pool.poolAddress : undefined,
      poolId: position.plan.pool.protocol === 'v4' ? position.plan.pool.poolId : undefined,
    },
    outcome: {
      kind,
      reasonCode: decision.action,
      reasonDetail: decision.reason,
    },
    position: {
      identity: position.id,
      status: position.status,
      initialValueUsd: position.initialValueUsd,
      currentValueUsd: position.currentValueUsd,
      netPnlUsd: position.netPnlUsd,
      unclaimedFeesUsd: position.unclaimedFeesUsd,
      claimedFeesUsd: position.claimedFeesUsd,
      lastAction: lastEvent?.action,
      lastReason: lastEvent?.reason,
    },
  };
}

/**
 * Helper: a planPosition call threw — capture the error code as a blocked plan.
 */
export function contextFromPlanBlocked(args: {
  planAttempt: { pool: { chainId: ChainId } };
  candidateIdentity: string;
  error: unknown;
  chainName: string;
  timestamp?: number;
}): ExplanationContext {
  const message = args.error instanceof Error ? args.error.message.split('\n')[0]! : String(args.error);
  return {
    eventType: 'plan_blocked',
    timestamp: args.timestamp,
    chain: { id: args.planAttempt.pool.chainId, name: args.chainName },
    pool: { identity: args.candidateIdentity, protocol: 'v3', dex: 'uniswap' },
    outcome: {
      kind: 'plan_blocked',
      reasonCode: extractErrorCode(message),
      reasonDetail: message,
    },
    safety: { prevented: true, reason: message },
  };
}

/**
 * Helper: a run-level error or fail-closed event.
 */
export function contextFromError(args: {
  error: unknown;
  chainName?: string;
  chainId?: ChainId;
  timestamp?: number;
  runStatus?: 'ok' | 'degraded' | 'failed';
}): ExplanationContext {
  const message = args.error instanceof Error ? args.error.message.split('\n')[0]! : String(args.error);
  const ctx: ExplanationContext = {
    eventType: args.runStatus === 'failed' ? 'run_failed' : 'unknown',
    timestamp: args.timestamp,
    outcome: {
      kind: 'errored',
      reasonCode: extractErrorCode(message),
      reasonDetail: message,
    },
  };
  if (args.chainId !== undefined && args.chainName) {
    ctx.chain = { id: args.chainId, name: args.chainName };
  }
  if (args.runStatus) {
    ctx.run = { status: args.runStatus };
  }
  return ctx;
}

/**
 * Helper: no candidates passed screening on this run.
 */
export function contextFromNoCandidates(args: {
  chainId?: ChainId;
  chainName?: string;
  observedChains?: ChainId[];
  pausedChains?: ChainId[];
  timestamp?: number;
}): ExplanationContext {
  const ctx: ExplanationContext = {
    eventType: 'no_candidates',
    timestamp: args.timestamp,
    outcome: { kind: 'no_candidates' },
  };
  if (args.chainId !== undefined && args.chainName) {
    ctx.chain = { id: args.chainId, name: args.chainName };
  }
  if (args.observedChains?.length || args.pausedChains?.length) {
    ctx.run = {
      mode: 'live-readonly',
      ...(args.observedChains?.length ? { candidateCount: 0 } : {}),
    };
  }
  return ctx;
}

/**
 * Helper: a plan was successfully created (deterministic, paper-only in current Viero).
 */
export function contextFromPlanCreated(args: {
  candidate: Candidate;
  plan: PositionPlan;
  chainName: string;
  timestamp?: number;
}): ExplanationContext {
  return {
    ...contextFromApprovedCandidate({
      candidate: args.candidate,
      chainName: args.chainName,
      timestamp: args.timestamp,
    }),
    eventType: 'plan_created',
    outcome: { kind: 'plan_created' },
    plan: {
      mode: 'paper',
      tickLower: args.plan.tickLower,
      tickUpper: args.plan.tickUpper,
      depositUsd: args.plan.depositUsd,
      maximumGasCostUsd: args.plan.maximumGasCostUsd,
      deadline: args.plan.deadline,
    },
  };
}

// ─── internal helpers ─────────────────────────────────────────

function mapManagementKind(action: string): ExplanationOutcomeKind {
  switch (action) {
    case 'hold': return 'held';
    case 'close': return 'closed';
    case 'emergency-close': return 'emergency_closed';
    case 'rebalance': return 'rebalanced';
    case 'pause': return 'paused';
    case 'claim': return 'claim';
    case 'open': return 'plan_created';
    default: return 'held';
  }
}

function extractErrorCode(message: string): string | undefined {
  const m = message.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return m?.[1];
}
