/**
 * Strongly typed context for the candidate / pool assisted-analysis
 * layer.
 *
 * Distinct from `ExplanationContext`:
 *   - ExplanationContext answers "what happened and why?" (post-hoc
 *     rationale for a recorded decision or event).
 *   - AnalysisContext answers "what does this data mean?" (advisory
 *     interpretation of a single candidate's metrics and risk
 *     evidence).
 *
 * The two schemas are deliberately not unified — keeping them separate
 * makes the authority boundary explicit: the analysis layer is
 * read-only and never re-classifies a candidate's approved/rejected
 * status, hard limits, or any other deterministic verdict.
 *
 * All fields come from Viero records (Candidate + the matching
 * Observation). When a record lacks a field (e.g. raw top-10 holder
 * percentage), the value is `null` or the field is absent. The LLM is
 * trained to report missing fields in its `missingData` list rather
 * than invent plausible values.
 */
import { type ChainId, type PoolRef } from '../domain.js';
import { type Candidate } from '../screening/pipeline.js';
import { type AgentRun, type RetrievedCandidate } from './retrieval.js';

export const ANALYSIS_PROMPT_VERSION = 'viero-analysis-1';

/**
 * Strictly typed risk row for the analysis layer. Mirrors Viero's
 * `Risk` schema but is bounded to the fields the analyst needs. All
 * values are nullable because the upstream GMGN/RPC may not have
 * returned them.
 */
export type AnalysisRisk = {
  tokenAddress: string;
  tokenSymbol?: string;
  honeypot: boolean | null;
  criticalAdmin: boolean | null;
  sellTaxBps: number | null;
  top10HolderPct: number | null;
  buySimulation: boolean | null;
  sellSimulation: boolean | null;
  smartMoneyScore: number | null;
};

export type AnalysisContext = {
  /** Provenance — the run that produced this candidate. */
  sourceRun: {
    id: string;
    mode: 'live-readonly' | 'live-execution' | 'replay';
    status: 'ok' | 'degraded' | 'failed';
    startedAt: number;
  };

  /** Pool metadata. */
  chain: { id: ChainId; name: string };
  pool: {
    identity: string;
    protocol: 'v3' | 'v4';
    dex: 'uniswap' | 'pancakeswap';
    poolAddress?: string;
    poolId?: string;
  };

  /** Token pair (when the source observation is available). */
  tokenPair?: {
    token0: { address: string; symbol: string };
    token1: { address: string; symbol: string };
  };

  /**
   * Deterministic facts. The LLM MUST report these values verbatim
   * when describing the candidate. It must not reinterpret the
   * approved/rejected status, the rejection codes, or the numeric
   * metrics.
   */
  deterministic: {
    approved: boolean;
    rejectionCodes: ReadonlyArray<{ code: string; detail: string }>;
    policyVersion: string;
    scoreVersion: string;
    metrics: {
      volumeUsd: number | null;
      tvlUsd: number | null;
      depthUsd: number | null;
      depthDownUsd: number | null;
      depthUpUsd: number | null;
      lpFeesUsd: number | null;
      grossFeesUsd: number | null;
      expectedNetFeesUsd: number | null;
      expectedFeesUsd: number | null;
      feeTvlPct: number | null;
      feeDepthPct: number | null;
      volumeDepth: number | null;
      uniqueTraders: number | null;
      swapCount: number | null;
      maximumPriceDivergencePct: number | null;
      volatilityRealizedPct: number | null;
      organicScore: number | null;
      organicTopTraderShare: number | null;
      organicReversalShare: number | null;
      organicBalance: number | null;
      organicTemporal: number | null;
      organicUniqueRatio: number | null;
    };
    /** Normalized 0-1 component scores plus penalty deltas. */
    components: Record<string, number>;
    score: number | null;
    globalScore: number | null;
  };

  /**
   * Token risk evidence from the source observation. Empty when the
   * observation lacks risk records (e.g. pre-enrichment runs).
   */
  risks: ReadonlyArray<AnalysisRisk>;

  /** Pool-level metadata (only present when the observation is reachable). */
  poolMeta?: {
    poolCreatedAt: number | null;
    uniqueLps: number | null;
    positionsCreated: number | null;
    netLiquidityFlowUsd: number | null;
  };

  /**
   * Fields the LLM is told are unavailable for this candidate. The
   * analyst is instructed to surface these in its `missingData` list
   * rather than fabricate plausible values.
   */
  missingFields: string[];
};

/**
 * Helper: build an AnalysisContext from a RetrievedCandidate.
 *
 * Looks up the matching observation in the run's `observations[]`
 * (matched by pool identity and block number) to enrich the context
 * with token risk evidence, pool age, and LP/position counts.
 *
 * Returns `null` when the underlying candidate is missing.
 */
export function contextFromRetrievedCandidate(rc: RetrievedCandidate, run: AgentRun): AnalysisContext | null {
  const candidate = rc.candidate;
  const pool = candidate.pool;

  // Look up the matching observation by pool identity + block number.
  const observation = run.observations.find(
    (o: { state: { pool: PoolRef } }) => o.state.pool.chainId === pool.chainId &&
      poolIdentityMatches(o.state.pool, pool),
  );

  const missing: string[] = [];

  // Token pair is only present when the observation exists.
  let tokenPair: AnalysisContext['tokenPair'];
  if (observation) {
    tokenPair = {
      token0: { address: observation.state.token0.address, symbol: observation.state.token0.symbol },
      token1: { address: observation.state.token1.address, symbol: observation.state.token1.symbol },
    };
  } else {
    missing.push('token pair symbols');
  }

  // Risk rows for the tokens in this pool, if any.
  const risks: AnalysisRisk[] = [];
  if (observation) {
    for (const r of observation.risks) {
      const symbol = r.token === observation.state.token0.address
        ? observation.state.token0.symbol
        : r.token === observation.state.token1.address
          ? observation.state.token1.symbol
          : '';
      risks.push({
        tokenAddress: r.token,
        ...(symbol ? { tokenSymbol: symbol } : {}),
        honeypot: r.honeypot,
        criticalAdmin: r.criticalAdmin,
        sellTaxBps: r.sellTaxBps,
        top10HolderPct: r.top10HolderPct,
        buySimulation: r.buySimulation,
        sellSimulation: r.sellSimulation,
        smartMoneyScore: r.smartMoneyScore,
      });
    }
  }

  // Pool-level meta from the observation.
  const poolMeta = observation
    ? {
        poolCreatedAt: observation.poolCreatedAt,
        uniqueLps: observation.uniqueLps,
        positionsCreated: observation.positionsCreated,
        netLiquidityFlowUsd: candidate.metrics.netLiquidityFlowUsd,
      }
    : undefined;
  if (!poolMeta) missing.push('pool age, unique LP count, position count');
  if (observation && poolMeta?.netLiquidityFlowUsd === null) missing.push('net liquidity flow');

  // Surface missing metric fields explicitly so the LLM does not
  // hallucinate plausible values for them.
  const m = candidate.metrics;
  const nullMetricLabels: Array<[string, unknown]> = [
    ['tvlUsd', m.tvlUsd],
    ['volumeUsd', m.volumeUsd],
    ['depthUsd', m.depthUsd],
    ['lpFeesUsd', m.lpFeesUsd],
    ['expectedNetFeesUsd', m.expectedNetFeesUsd],
    ['feeTvlPct', m.feeTvlPct],
    ['maximumPriceDivergencePct', m.maximumPriceDivergencePct],
    ['volatilityRealizedPct', m.volatility?.realizedPct ?? null],
  ];
  for (const [label, value] of nullMetricLabels) {
    if (value === null || value === undefined) missing.push(`metric.${label}`);
  }

  return {
    sourceRun: {
      id: run.id,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
    },
    chain: { id: rc.chainId, name: rc.chainName },
    pool: {
      identity: candidate.identity,
      protocol: pool.protocol,
      dex: pool.dex,
      ...(pool.protocol === 'v3' && 'poolAddress' in pool && pool.poolAddress
        ? { poolAddress: pool.poolAddress }
        : {}),
      ...(pool.protocol === 'v4' && 'poolId' in pool && pool.poolId
        ? { poolId: pool.poolId }
        : {}),
    },
    ...(tokenPair ? { tokenPair } : {}),
    deterministic: {
      approved: candidate.approved,
      rejectionCodes: candidate.rejections,
      policyVersion: candidate.policyVersion,
      scoreVersion: candidate.scoreVersion,
      metrics: {
        volumeUsd: m.volumeUsd,
        tvlUsd: m.tvlUsd,
        depthUsd: m.depthUsd,
        depthDownUsd: m.depthDownUsd,
        depthUpUsd: m.depthUpUsd,
        lpFeesUsd: m.lpFeesUsd,
        grossFeesUsd: m.grossFeesUsd,
        expectedNetFeesUsd: m.expectedNetFeesUsd,
        expectedFeesUsd: m.expectedFeesUsd,
        feeTvlPct: m.feeTvlPct,
        feeDepthPct: m.feeDepthPct,
        volumeDepth: m.volumeDepth,
        uniqueTraders: m.uniqueTraders,
        swapCount: m.swapCount,
        maximumPriceDivergencePct: m.maximumPriceDivergencePct,
        volatilityRealizedPct: m.volatility?.realizedPct ?? null,
        organicScore: m.organic.score,
        organicTopTraderShare: m.organic.topTraderShare,
        organicReversalShare: m.organic.reversalShare,
        organicBalance: m.organic.balance,
        organicTemporal: m.organic.temporal,
        organicUniqueRatio: m.organic.uniqueRatio,
      },
      components: candidate.components,
      score: candidate.score,
      globalScore: candidate.globalScore,
    },
    risks,
    ...(poolMeta ? { poolMeta } : {}),
    missingFields: missing,
  };
}

function poolIdentityMatches(a: PoolRef, b: PoolRef): boolean {
  if (a.protocol !== b.protocol || a.dex !== b.dex) return false;
  if (a.protocol === 'v3' && b.protocol === 'v3') {
    return a.poolAddress.toLowerCase() === b.poolAddress.toLowerCase();
  }
  if (a.protocol === 'v4' && b.protocol === 'v4') {
    return a.poolId.toLowerCase() === b.poolId.toLowerCase();
  }
  return false;
}

export type { Candidate };
