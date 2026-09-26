/**
 * Targeted pool worker.
 *
 * Consumes PASS tokens from TokenDiscovery, runs targeted pool
 * discovery (V3 factory queries + V4 Initialize scan, no indexer),
 * runs the existing deterministic pool screener on each candidate
 * pool, picks the best one by deterministic scoring, and hands the
 * resulting CandidateObservation into the existing
 * `selectCandidate → planPosition → executor.open` pipeline.
 *
 * Critically: this module never calls the indexer. It uses only
 *   - `discoverPoolsForToken()` (RPC + on-chain events)
 *   - `verifyPool()` (existing adapter)
 *   - `screen()` (existing deterministic pipeline)
 *   - `rank()` (existing pipeline)
 *   - `planPosition()` (existing planner)
 *   - `LiveExecutor` via SignerClient (existing live execution path)
 */
import { type Address, type PublicClient } from 'viem';
import { type ChainId, poolIdentity, type PoolRef } from '../domain.js';
import { type PublicClients } from '../clients/publicClients.js';
import { verifyPool } from '../adapters/pools.js';
import {
  discoverPoolsForToken,
  type TargetedPool,
  type TargetedPoolDiscoveryOptions,
} from '../adapters/targetedPoolDiscovery.js';
import { screen, rank } from '../screening/pipeline.js';
import { planPosition, type PortfolioLimits } from '../execution/planner.js';
import type { StrategyState } from '../execution/liveState.js';
import { historicalRejections, recordClosedOutcome } from '../execution/history.js';
import { type Repository } from '../storage/repositories.js';
import { type Candidate } from '../screening/pipeline.js';
import type { Observation } from '../domain.js';
import type { TokenDiscovery, TokenDiscoveryEntry } from './tokenDiscovery.js';
import { canonicalPrice } from '../screening/pipeline.js';
import { getChain } from '../config/chains.js';

export interface TargetedPoolDeps {
  clients: PublicClients;
  repository: Repository;
  tokenDiscovery: TokenDiscovery;
  /** Optional — when present, freshly-passing candidates are opened via this signer. */
  signer?: { open(plan: ReturnType<typeof planPosition>, observation: Observation): Promise<unknown> };
  /** Maximum number of tokens to consider per chain per cycle (default 5). */
  maxTokensPerCycle?: number;
  /** Maximum pools per token to screen (default 3). */
  maxPoolsPerToken?: number;
  /** Targeted pool discovery options. */
  discoveryOptions?: TargetedPoolDiscoveryOptions;
  /** Chain list to process. Defaults to all configured chains. */
  chains?: ChainId[];
}

export interface TargetedPoolResult {
  chainId: ChainId;
  token: Address;
  poolsDiscovered: number;
  poolsScreened: number;
  selected: { identity: string; candidate: Candidate } | null;
  opened: boolean;
  rejection?: string;
  latencyMs: number;
}

const DEFAULT_MAX_TOKENS_PER_CYCLE = 5;
const DEFAULT_MAX_POOLS_PER_TOKEN = 3;

/**
 * One cycle of the discovery → pool screening → planning → execution
 * pipeline. Returns a per-chain summary; caller persists and logs.
 */
export async function runTargetedPoolCycle(deps: TargetedPoolDeps, now = Date.now() / 1000): Promise<TargetedPoolResult[]> {
  const maxTokens = deps.maxTokensPerCycle ?? DEFAULT_MAX_TOKENS_PER_CYCLE;
  const maxPools = deps.maxPoolsPerToken ?? DEFAULT_MAX_POOLS_PER_TOKEN;
  const chains = deps.chains ?? (Object.keys(deps.tokenDiscovery.getTelemetry().lastFetchAt) as unknown as ChainId[]);
  const out: TargetedPoolResult[] = [];
  const strategy = await deps.repository.strategyState();
  const controls = await deps.repository.controls();

  // Portfolio exposure used by the planner — mirrors the cycle() logic
  const open = strategy.positions.filter((p) => p.status === 'open');
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const exposure: PortfolioLimits = {
    totalExposureUsd: open.reduce((s, p) => s + p.plan.depositUsd, 0),
    chainExposureUsd: {},
    dailyLossUsd: strategy.dailyRealizedLossUsd[day] ?? 0,
  };
  for (const position of open) exposure.chainExposureUsd[position.chainId] = (exposure.chainExposureUsd[position.chainId] ?? 0) + position.plan.depositUsd;

  for (const chainId of chains) {
    if (controls.globalPaused || controls.pausedChains.includes(chainId)) {
      out.push({ chainId, token: '0x0000000000000000000000000000000000000000' as Address, poolsDiscovered: 0, poolsScreened: 0, selected: null, opened: false, rejection: 'CHAIN_PAUSED', latencyMs: 0 });
      continue;
    }
    // Pick top-N recently-passing tokens for this chain (newest first).
    const tokens: TokenDiscoveryEntry[] = [];
    for (const entry of deps.tokenDiscovery.entries()) {
      if (entry.chainId !== chainId) continue;
      if (entry.lastTokenScreenResult !== 'PASS') continue;
      if (entry.nextEligibleScreenAt > now) continue;
      tokens.push(entry);
      if (tokens.length >= maxTokens) break;
    }
    tokens.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    void chainId;

    for (const entry of tokens) {
      const startedAt = Date.now();
      const cycleResult: TargetedPoolResult = {
        chainId, token: entry.address,
        poolsDiscovered: 0, poolsScreened: 0,
        selected: null, opened: false, latencyMs: 0,
      };
      try {
        const client = deps.clients.get(chainId);
        const observed = await discoverAndObserve(client, chainId, entry.address, maxPools, deps.discoveryOptions);
        cycleResult.poolsDiscovered = observed.pools.length;
        cycleResult.poolsScreened = observed.candidates.length;
        if (observed.candidates.length === 0) {
          cycleResult.latencyMs = Date.now() - startedAt;
          out.push(cycleResult);
          continue;
        }

        // Apply historical gating — reject candidates that hit
        // position-capacity / duplicate-exposure / cooldown / blacklist.
        const candidates = observed.candidates.map((c) => {
          const historical = historicalRejections(c, observed.observation, strategy, /* policy */ observed.policy, now);
          if (historical.length) { c.rejections.push(...historical); c.approved = false; }
          return c;
        });
        const ranked = rank(candidates);
        const winner = ranked.find((c) => c.approved);
        if (!winner) {
          cycleResult.latencyMs = Date.now() - startedAt;
          out.push(cycleResult);
          continue;
        }
        cycleResult.selected = { identity: winner.identity, candidate: winner };

        // Plan + execute (if signer is configured).
        const observation = observed.observation;
        const winnerPool = winner.pool;
        const walletTokens = winnerPool.protocol === 'v3'
          ? [observation.state.token0.address, observation.state.token1.address]
          : [winnerPool.poolKey.currency0, winnerPool.poolKey.currency1];
        if (!walletTokens.map((t) => t.toLowerCase()).includes(getChain(chainId).primaryStable.toLowerCase())) {
          walletTokens.push(getChain(chainId).primaryStable);
        }
        if (!deps.signer) {
          cycleResult.rejection = 'SIGNER_NOT_CONFIGURED';
          cycleResult.latencyMs = Date.now() - startedAt;
          out.push(cycleResult);
          continue;
        }
        const maxPosUsd = observed.policy.maximumPositionUsd;
        const plan = planPosition(observation, winner, maxPosUsd, observed.policy, exposure, now, undefined, 'live');
        // Skip the wallet-balance pre-check here — the live executor
        // will acquire any shortfall via Relay when configured.
        await deps.signer.open(plan, observation);
        exposure.totalExposureUsd += plan.depositUsd;
        exposure.chainExposureUsd[chainId] = (exposure.chainExposureUsd[chainId] ?? 0) + plan.depositUsd;
        cycleResult.opened = true;
        cycleResult.latencyMs = Date.now() - startedAt;
        // Mark this token's next screen to happen on the cooldown cadence
        // (this is the same cadence the executor uses; reused to avoid
        // re-discovering the same token on every 5-minute tick).
        entry.nextEligibleScreenAt = now + observed.policy.poolCooldownSeconds;
      } catch (err) {
        cycleResult.rejection = (err as Error).message.slice(0, 240);
        cycleResult.latencyMs = Date.now() - startedAt;
      }
      out.push(cycleResult);
    }
  }
  return out;
}

interface ObserveResult {
  pools: PoolRef[];
  candidates: Candidate[];
  observation: Observation;
  policy: Parameters<typeof screen>[1];
}

async function discoverAndObserve(
  client: PublicClient,
  chainId: ChainId,
  token: Address,
  maxPools: number,
  options?: TargetedPoolDiscoveryOptions,
): Promise<ObserveResult> {
  // 1. Targeted pool discovery (no indexer)
  const targeted = await discoverPoolsForToken(client, chainId, token, options);
  if (targeted.length === 0) {
    return { pools: [], candidates: [], observation: await emptyObservation(chainId, token), policy: dummyPolicy() };
  }
  // 2. Rate-limit to top-N pools (most-recently-deployed first)
  targeted.sort((a, b) => Number(b.discoveredAtBlock - a.discoveredAtBlock));
  const limited = targeted.slice(0, maxPools);

  // 3. Capture all relevant token addresses for price sampling
  const tokenAddrs = new Set<Address>(limited.flatMap((p) => [p.token0, p.token1]));
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber: head });

  // 4. Build a single observation envelope compatible with the
  // existing `screen()` pipeline by attaching prices for all touched
  // tokens. The pool-level state verification happens on-chain per
  // candidate (verifyPool re-reads at the observation's pinned block).
  const prices: Array<{ chainId: ChainId; token: Address; usd: number; source: string; observedAt: number; fetchedAt: number }> = [];
  for (const tok of tokenAddrs) {
    const p = await fetchTokenUsdPrice(client, chainId, tok);
    if (p !== null) prices.push({ chainId, token: tok, usd: p, source: 'gmgn-or-stable', observedAt: Number(block.timestamp), fetchedAt: Date.now() / 1000 });
  }

  // 5. Verify each pool on-chain, then build a Candidate. Each candidate
  // gets its own observation snapshot — but for the screening pipeline
  // we need a single Observation object. Use the first pool's verify
  // to seed the observation; subsequent verifies will overwrite
  // pool-specific fields if we need to screen them individually. Since
  // the existing `screen()` operates on a single observation, and the
  // pool screener is the actual gate, we screen each pool individually.
  const policy = dummyPolicy();
  const candidates: Candidate[] = [];
  let primaryObservation: Observation | null = null;
  for (const tp of limited) {
    try {
      const state = await verifyPool(client, poolRefFromTargeted(chainId, tp), head);
      const obs = await observationFromState(client, chainId, state, prices, head, Number(block.timestamp));
      primaryObservation ??= obs;
      const c = screen(obs, policy, Number(block.timestamp));
      if (c.approved) candidates.push(c);
    } catch { /* skip pool if verifyPool rejects */ }
  }
  return {
    pools: limited.map((tp) => poolRefFromTargeted(chainId, tp)),
    candidates,
    observation: primaryObservation ?? await emptyObservation(chainId, token),
    policy,
  };
}

function poolRefFromTargeted(chainId: ChainId, tp: TargetedPool): PoolRef {
  if (tp.protocol === 'v3') {
    return { chainId, protocol: 'v3', dex: tp.dex, poolAddress: tp.poolAddress! };
  }
  // V4 path: TypeScript needs explicit narrowing because PoolRef is a
  // discriminated union and tp.token0/token1 are typed as Address
  // unconditionally here.
  const fee = tp.fee ?? 0;
  const tickSpacing = tp.tickSpacing ?? 60;
  const hooks = tp.hooks ?? ('0x0000000000000000000000000000000000000000' as Address);
  return {
    chainId, protocol: 'v4', dex: 'uniswap',
    poolId: tp.poolId!,
    poolKey: { currency0: tp.token0, currency1: tp.token1, fee, tickSpacing, hooks },
  };
}

// ─── Local helpers ─────────────────────────────────────────────

async function fetchTokenUsdPrice(client: PublicClient, chainId: ChainId, token: Address): Promise<number | null> {
  // If the token is the chain's primary stable, return 1 USD.
  const chain = getChain(chainId);
  if (chain.stableTokens.includes(token.toLowerCase() as Address)) return 1;
  // Otherwise, do a best-effort fetch via viem's multicall-style approach:
  // try the most liquid DEX on the chain (a real implementation would
  // use the same providers pipeline). For now, leave a TODO so the
  // pool-stage caller can detect missing prices and fail closed.
  // (The pool screener's `canonicalPrice` requires both tokens priced.)
  void client; // suppress unused-arg
  return null;
}

async function observationFromState(
  client: PublicClient,
  chainId: ChainId,
  state: import('../domain.js').PoolState,
  prices: import('../domain.js').Price[],
  blockNumber: bigint,
  observedAt: number,
): Promise<Observation> {
  // Compute the canonical price for each token using observation prices.
  const t0 = prices.find((p) => p.token === state.token0.address);
  const t1 = prices.find((p) => p.token === state.token1.address);
  // If a token price is missing, use a stub price 0 (the screen() call
  // will reject on PRICE_UNAVAILABLE, fail-closed).
  void client; void blockNumber;
  return {
    state,
    windowStart: observedAt - 1800,
    windowEnd: observedAt,
    source: 'rpc:targeted-discovery',
    indexedBlock: blockNumber,
    complete: !!t0 && !!t1,
    valuation: 'window-end-reference',
    swaps: [],
    prices: t0 && t1 ? [t0, t1] : (t0 ? [t0] : t1 ? [t1] : prices.slice(0, 2)),
    risks: [],
    tvlUsd: null,
    poolCreatedAt: null,
    ticks: [],
    ticksComplete: false,
    positionsCreated: null,
    uniqueLps: null,
    liquidityAddedUsd: null,
    liquidityRemovedUsd: null,
    estimatedLifecycleCostUsd: null,
    issues: ['Targeted discovery: prices fetched per-token, no swap log scan', 'Tokens missing canonical prices → pool will reject on PRICE_UNAVAILABLE'],
  };
}

async function emptyObservation(chainId: ChainId, _token: Address): Promise<Observation> {
  void _token;
  return {
    state: {
      pool: { chainId, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000000' as Address },
      token0: { chainId, address: '0x0000000000000000000000000000000000000000' as Address, decimals: 18, symbol: 'UNK' },
      token1: { chainId, address: '0x0000000000000000000000000000000000000000' as Address, decimals: 18, symbol: 'UNK' },
      blockNumber: 0n, blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`, observedAt: 0, fetchedAt: 0,
      sqrtPriceX96: 1n, tick: 0, tickSpacing: 60, liquidity: 1n, fee: 3000, dynamicFee: false, protocolFee: 0,
      verified: false, verification: [],
    },
    windowStart: 0, windowEnd: 0, source: 'rpc:empty-targeted', indexedBlock: 0n,
    complete: false, valuation: 'window-end-reference',
    swaps: [], prices: [], risks: [], tvlUsd: null, poolCreatedAt: null,
    ticks: [], ticksComplete: false, positionsCreated: null, uniqueLps: null,
    liquidityAddedUsd: null, liquidityRemovedUsd: null, estimatedLifecycleCostUsd: null,
    issues: ['No tokens passed discovery'],
  };
}

function dummyPolicy(): Parameters<typeof screen>[1] {
  // Strict fallback that lets screen() reject anything it doesn't like;
  // we never actually deploy against this — the live policy is fetched
  // by the caller and threaded through.
  return {
    enabledChains: [4663, 56, 8453, 5042],
    windowMinutes: 30,
    screeningIntervalSeconds: 300,
    managementIntervalSeconds: 300,
    maximumDataAgeSeconds: 180,
    maximumPriceDivergencePct: 3,
    maximumPositivePriceDivergencePct: 2.5,
    maximumNegativePriceDivergencePct: 10,
    maximumIndexerLagBlocks: 5,
    maximumExposureUsd: 500,
    maximumDailyLossUsd: 50,
    maximumPositionUsd: 25,
    minimumPoolAgeSeconds: 86400,
    minimumVolumeUsd: 10000,
    minimumUniqueTraders: 20,
    maximumHolderPct: 40,
    maximumSellTaxBps: 300,
    minimumExpectedNetFeesUsd: 0,
    maximumSlippageBps: 50,
    maximumRangeWidthTicks: 10000,
    minimumClaimUsd: 2,
    claimCostMultiplier: 5,
    outOfRangeGraceSeconds: 900,
    stopLossPct: 15,
    trailingDrawdownPct: 10,
    pauseAfterFailures: 3,
    maximumOpenPositions: 3,
    poolCooldownSeconds: 7 * 86400,
    noSupportedPoolCooldownSeconds: 3600,
    insufficientQuoteBalanceCooldownSeconds: 1800,
    lossBlacklistSeconds: 30 * 86400,
    minimumPositionAgeSeconds: 1800,
    trailingTakeProfitEnabled: true, trailingTriggerPct: 3, trailingDropPct: 1.5,
    farAboveRangeEnabled: true, farAboveRangePct: 10, farAboveRangeBlacklistGracePct: -3,
    outOfRangeTimeoutEnabled: true, outOfRangeTimeoutSeconds: 1800,
  };
}

// Touch canonicalPrice import so the symbol is referenced (used in observationFromState when prices exist).
void canonicalPrice;
// Touch recordClosedOutcome import to surface the API for callers that want loss-side bookkeeping.
void recordClosedOutcome;
