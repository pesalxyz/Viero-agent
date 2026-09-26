import { randomUUID } from 'node:crypto';
import { type Address, formatUnits } from 'viem';
import { type Observation, type Mode, type ChainId, type PoolRef, type Price, type Risk, poolIdentity, tokenIdentity, errorMessage, observationSchema, addressSchema } from '../domain.js';
import { DEPLOYMENT_VERSION, getChain } from '../config/chains.js';
import { POLICY_VERSION, type Policy } from '../config/policy.js';
import { PublicClients, smokeTest } from '../clients/publicClients.js';
import { Gmgn, Market, Providers } from '../adapters/providers.js';
import { Indexer } from '../adapters/indexer.js';
import { verifyPool } from '../adapters/pools.js';
import { targetedRpcObservation, lightweightManagementObservation } from '../adapters/events.js';
import { type DiscoveryResult } from './discoveryWorker.js';
import { TokenDiscovery } from '../discovery/tokenDiscovery.js';
import { dexScreenerShortlist, searchVerifiedPoolsForToken, type ExternalPoolShortlist } from '../adapters/targetedPoolDiscovery.js';
import { canonicalPrice, rank, screen } from '../screening/pipeline.js';
import { amount0Delta, amount1Delta, humanQuotePriceFromSqrt, sqrtAtTick, tokenValue } from '../screening/math.js';
import { v3PositionManagerAbi, v4PositionManagerAbi, stateViewAbi, v3Abi } from '../adapters/abi.js';
import { selectCandidate, PROMPT_VERSION, type DecisionModel } from '../agent/runtime.js';
import { InsufficientQuoteBalanceError, planPosition, type PortfolioLimits } from '../execution/planner.js';
import { ChainSupervisor } from '../execution/guard.js';
import { type Repository, type AgentRun } from '../storage/repositories.js';
import { type PaperPosition, markPaperPosition, openPaperPosition } from '../management/paper.js';
import { type PoolRef as LivePoolRef } from '../domain.js';
import { SignerClient } from '../execution/signerClient.js';
import { historicalRejections, recordClosedOutcome } from '../execution/history.js';
import { liveManagementDecision, managementPnlPct } from '../management/live.js';
import { effectivePnlDepositUsd, pnlPctFromValues } from '../management/pnl.js';
import { v4FeeGrowthDelta } from '../management/v4Fees.js';
import { feeGrowthInsideV3, v3UnclaimedFees } from '../management/v3Fees.js';
import type { LlmClient } from '../agent/llmClient.js';
import { assertCandidateExecutionAllowed, assertLiveExecutionEnabled, resolveExecutionSettings } from '../strategy/executionSettings.js';
import { TokenMemoryStore } from '../storage/tokenMemory.js';
import { BlockedTokenStore } from '../storage/blockedTokens.js';

export type CandidateOpportunity = { chainId: ChainId; tokenAddress: Address; symbol?: string; hotSearchRank: number; poolId: string; protocol: 'v3' | 'v4'; score: number; volume1hUsd: number; liquidityUsd: number };
export type PersistedTokenRanking = { chainId: ChainId; tokenAddress: Address; symbol?: string; hotSearchRank?: number; volume1h?: number | null; liquidityUsd?: number | null; verdict: 'PASS' | 'REJECT' | 'RETRY_LATER' };
export function rankPersistedTokens(tokens: PersistedTokenRanking[]): Array<PersistedTokenRanking & { score: number }> {
  return tokens.filter(t => t.verdict === 'PASS' && Number.isFinite(t.volume1h) && Number.isFinite(t.liquidityUsd) && (t.liquidityUsd ?? 0) > 0)
    .map(t => ({ ...t, score: t.volume1h! / t.liquidityUsd! }))
    .sort((a, b) => b.score - a.score || (a.hotSearchRank ?? Number.MAX_SAFE_INTEGER) - (b.hotSearchRank ?? Number.MAX_SAFE_INTEGER) || a.tokenAddress.localeCompare(b.tokenAddress));
}
export function rankCandidateOpportunities(items: CandidateOpportunity[]): CandidateOpportunity[] {
  return [...items].sort((a, b) => b.score - a.score || a.hotSearchRank - b.hotSearchRank || a.tokenAddress.localeCompare(b.tokenAddress));
}

/**
 * PnL shown in the close notification must use the same fee-inclusive,
 * percentage-point calculation used by management and the active card.  The
 * receipt-based realized amount remains available for token-memory accounting,
 * but is only a fallback when the close-time management evidence is absent.
 */
export function closeNotificationPnlPct(
  position: import('../execution/liveState.js').LivePosition,
  observation: Observation,
  policy: Policy,
  now: number,
  realizedPnlUsd: number | null | undefined,
): number | null {
  const canonical = managementPnlPct(position, observation, policy, now);
  if (canonical != null) return canonical;
  const basis = position.entryPrincipalUsd ?? position.plan.depositUsd;
  return realizedPnlUsd != null && Number.isFinite(realizedPnlUsd) && basis > 0
    ? realizedPnlUsd / basis * 100
    : null;
}

export type TvlRankedPool<T = unknown> = { pool: PoolRef; tvlUsd: number | null; value: T };

export function selectPoolsByVerifiedTvl<T>(pools: TvlRankedPool<T>[], limit: number): TvlRankedPool<T>[] {
  return [...pools].sort((left, right) => {
    if (left.tvlUsd === null && right.tvlUsd !== null) return 1;
    if (left.tvlUsd !== null && right.tvlUsd === null) return -1;
    if (left.tvlUsd !== null && right.tvlUsd !== null && left.tvlUsd !== right.tvlUsd) return right.tvlUsd - left.tvlUsd;
    return poolIdentity(left.pool).localeCompare(poolIdentity(right.pool));
  }).slice(0, limit);
}

export class Agent {
  readonly providers = new Providers();
  readonly clients = new PublicClients();
  readonly gmgn = new Gmgn(this.providers);
  readonly market = new Market(this.providers, this.gmgn);
  readonly indexer = new Indexer(this.providers);
  readonly tokenDiscovery: TokenDiscovery;
  readonly tokenMemory = new TokenMemoryStore();
  readonly blockedTokens = new BlockedTokenStore();
  private readonly discoverySnapshots = new Map<ChainId, Awaited<ReturnType<TokenDiscovery['fetchAndScreenOnce']>>>();
  readonly supervisor: ChainSupervisor;
  private checkedDeployments = new Set<ChainId>();
  constructor(readonly policy: Policy, readonly repository: Repository, readonly model?: DecisionModel, readonly signer?: SignerClient,
    readonly strategyLlm?: LlmClient) {
    this.supervisor = new ChainSupervisor(policy.pauseAfterFailures);
    this.tokenDiscovery = new TokenDiscovery(this.clients, this.gmgn, policy.enabledChains, {
      hotSearchIntervalMs: 5 * 60_000,
      hotSearchLimit: Math.max(1, Math.min(100, Number(process.env.VIERO_TOKEN_LIMIT ?? 3) || 3)),
      screenerPolicy: {
        maximumSellTaxBps: policy.maximumSellTaxBps,
        maximumHolderPct: policy.maximumHolderPct,
        minimumAgeSeconds: policy.minimumPoolAgeSeconds,
        cooldownSeconds: policy.poolCooldownSeconds,
        blacklist: new Map(),
      },
      gmgnOnly: true,
      blockedTokenRegistry: async () => {
        const state = await this.blockedTokens.load();
        return new Set(Object.keys(state.tokens).filter(key => key.startsWith('4663:')).map(key => key.slice(5)));
      },
      enabledChains: async () => {
        const controls = await this.repository.controls();
        return (controls.enabledChains ?? []).filter(chainId => policy.enabledChains.includes(chainId));
      },
    });
  }

  private async tokenFirstDiscover(chainId: ChainId, _tokenLimit: number, _seeds: PoolRef[] = []): Promise<DiscoveryResult> {
    // ROUTINE 5-MINUTE SCREENING: GMGN hot-search + token screener only.
    // No pool query, no pool discovery, no per-pool observation. The
    // returned DiscoveryResult.pools array is always empty in routine
    // path; pool discovery + verification + planning happen only via the
    // execute-candidate path (see executeCandidateToken below).
    const result: DiscoveryResult = { chainId, pools: [], tokens: [], pairs: [], issues: [], coverage: [] };
    const fetch = await this.tokenDiscovery.fetchAndScreenOnce(chainId);
    this.discoverySnapshots.set(chainId, fetch);
    result.coverage.push('GMGN Hot Search token discovery', 'GMGN on-chain token screening');
    if (!fetch.ok) result.issues.push(fetch.rateLimitErrors
      ? 'GMGN Hot Search unavailable or rate-limited; new entries stopped for this cycle'
      : 'GMGN Hot Search unavailable; new entries stopped for this cycle');
    if (!fetch.ok) return result;
    const entries = this.tokenDiscovery.passed(chainId);
    result.tokens = entries.map(entry => entry.address);
    result.issues = [...new Set(result.issues)];
    console.error(`[viero.token-screening] chain=${chainId} tokens=${entries.length} new=${result.tokens.length}`);
    return result;
  }

  /**
   * Token-level rankings captured during cycle(). Stable, deterministic.
   * Smaller rank = better candidate for execution.
   */
  private rankTokens(tokens: { chainId: ChainId; tokenAddress: Address; risk?: Risk | null; entry: { hotSearchRank?: number | null } }[]): Array<{ chainId: ChainId; tokenAddress: Address; rank: number }> {
    // Composite score: higher is better. We rank by inverse hot-search
    // rank first (smaller GMGN rank number = more relevant), then by
    // better GMGN safety signals (no honeypot / no critical-admin /
    // buy+sell simulation pass / lower sell-tax / lower holder
    // concentration), then by smart-money score, then by recency.
    const scored = tokens.map((t) => {
      let score = 0;
      if (t.entry.hotSearchRank !== null && t.entry.hotSearchRank !== undefined) score += 100 - t.entry.hotSearchRank;
      if (t.risk) {
        if (t.risk.honeypot === false) score += 50;
        if (t.risk.criticalAdmin === false) score += 50;
        if (t.risk.buySimulation === true) score += 25;
        if (t.risk.sellSimulation === true) score += 25;
        if (t.risk.sellTaxBps !== null && t.risk.sellTaxBps !== undefined) score += Math.max(0, 25 - t.risk.sellTaxBps / 100);
        if (t.risk.top10HolderPct !== null && t.risk.top10HolderPct !== undefined) score += Math.max(0, 25 - t.risk.top10HolderPct);
        if (t.risk.smartMoneyScore !== null && t.risk.smartMoneyScore !== undefined) score += t.risk.smartMoneyScore * 10;
      }
      return { ...t, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((t, idx) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress, rank: idx + 1, score: t.score }));
  }

  async cycle(options: { mode: Mode; observations?: Observation[]; now?: number; chains?: ChainId[]; seeds?: PoolRef[]; tokenLimit?: number; poolLimit?: number; scanFrom?: bigint; persist?: boolean }): Promise<AgentRun> {
    const now = options.now ?? Date.now() / 1000;
    const run: AgentRun = { id: randomUUID(), mode: options.mode, startedAt: now, finishedAt: now,
      configVersion: POLICY_VERSION, deploymentVersion: DEPLOYMENT_VERSION, policy: this.policy,
      observations: [], candidates: [], discoveries: [], decisions: [], tokenDecisions: [], positions: [], health: [], providerObservations: [], errors: [], status: 'ok' };
    const chains = options.chains ?? this.policy.enabledChains;
    const handoffCandidates: CandidateOpportunity[] = [];
    const tokenCandidates: Array<{ chainId: ChainId; tokenAddress: Address; symbol?: string; hotSearchRank: number; score: number; volume1hUsd: number; liquidityUsd: number }> = [];
    let passCount = 0;
    let eligibleCount = 0;
    const exclusionCounts = new Map<string, number>();
    const tokenMemory = await this.tokenMemory.load();
    if (options.mode === 'replay') {
      // Replay path: caller provides observations. Do nothing special
      // here; existing replay() below uses them.
    }
    for (const chainId of chains) {
      if (!this.policy.enabledChains.includes(chainId)) {
        run.errors.push({ chainId, error: `CHAIN_DISABLED: ${chainId}` });
        continue;
      }
      try {
        this.supervisor.assertActive(chainId);
        if (options.mode === 'replay') {
          run.observations.push(...(options.observations ?? []).filter(o => o.state.pool.chainId === chainId).map(o => observationSchema.parse(o)));
        } else {
          const discovered = await this.tokenFirstDiscover(chainId, options.tokenLimit ?? 3, options.seeds);
          run.discoveries.push(discovered);
          for (const issue of discovered.issues) run.errors.push({ chainId, error: issue });

          // Pull the freshly-screened entries for ranking + tokenDecisions.
          const entries = this.tokenDiscovery.passed(chainId);
          const state = typeof (this.repository as Partial<Repository>).strategyState === 'function'
            ? await this.repository.strategyState()
            : { blacklist: {}, cooldowns: {}, positions: [] } as unknown as Awaited<ReturnType<Repository['strategyState']>>;
          const nowSeconds = options.now ?? Date.now() / 1000;
          const openTokenSet = new Set<string>();
          for (const position of state.positions.filter(position => position.status === 'open' || position.status === 'closing')) {
            for (const asset of position.plan.depositAssets) openTokenSet.add(`${chainId}:${asset.token.toLowerCase()}`);
          }
          const eligibility = entries.map(entry => {
            const key = `${chainId}:${entry.address.toLowerCase()}`;
            const blacklisted = state.blacklist[key] && state.blacklist[key].until > nowSeconds;
            const cooldown = (state.cooldowns[key] && state.cooldowns[key] > nowSeconds) || (tokenMemory[key]?.cooldownUntil !== undefined && tokenMemory[key]!.cooldownUntil! > nowSeconds);
            const open = openTokenSet.has(key) && state.positions.some(position => position.status === 'open' && position.plan.depositAssets.some(asset => `${chainId}:${asset.token.toLowerCase()}` === key));
            const closing = openTokenSet.has(key) && state.positions.some(position => position.status === 'closing' && position.plan.depositAssets.some(asset => `${chainId}:${asset.token.toLowerCase()}` === key));
            const reason = blacklisted ? 'BLACKLISTED' : cooldown ? 'COOLDOWN' : open ? 'OPEN_POSITION' : closing ? 'CLOSING_POSITION' : 'none';
            if (reason !== 'none') exclusionCounts.set(reason, (exclusionCounts.get(reason) ?? 0) + 1);
            console.error(`[viero.candidate-eligibility] symbol=${entry.symbol ?? entry.name ?? 'unknown'} address=${entry.address.slice(0, 8)}… eligible=${reason === 'none'} reason=${reason}`);
            return { entry, eligible: reason === 'none' };
          });
          const eligibleEntries = eligibility.filter(item => item.eligible).map(item => item.entry);
          passCount += entries.length;
          eligibleCount += eligibleEntries.length;
          const rankedForReport = this.rankScreenedTokens(chainId, entries);
          const ranked = this.rankScreenedTokens(chainId, eligibleEntries);
          run.tokenDecisions = (run.tokenDecisions ?? []).concat(
            rankedForReport.map((t) => ({
              chainId: t.chainId,
              tokenAddress: t.tokenAddress,
              symbol: t.symbol,
              name: t.name,
              verdict: t.verdict,
              rejectReason: t.rejectReason,
              holdersTop10Pct: t.holdersTop10Pct,
              sellTaxBps: t.sellTaxBps,
              buySimulation: t.buySimulation,
              sellSimulation: t.sellSimulation,
              honeypot: t.honeypot,
              criticalAdmin: t.criticalAdmin,
              smartMoneyScore: t.smartMoneyScore,
              volume1h: t.volume1h,
              liquidityUsd: (() => { const e = entries.find(entry => entry.address.toLowerCase() === t.tokenAddress.toLowerCase()); return Number.isFinite(e?.liquidity) ? e?.liquidity : null; })(),
              hotSearchRank: t.hotSearchRank,
              tokenAgeSeconds: t.tokenAgeSeconds,
              rank: t.rank,
            })),
          );
          for (const token of ranked.filter(t => t.verdict === 'PASS')) {
            const volume = token.volume1h, liquidity = entries.find(e => e.address.toLowerCase() === token.tokenAddress.toLowerCase())?.liquidity;
            if (Number.isFinite(volume) && Number.isFinite(liquidity) && (liquidity ?? 0) > 0) tokenCandidates.push({ chainId, tokenAddress: token.tokenAddress, symbol: token.symbol, hotSearchRank: token.hotSearchRank ?? token.rank, score: volume! / liquidity!, volume1hUsd: volume!, liquidityUsd: liquidity! });
          }
        }
        this.supervisor.success(chainId);
      } catch (error) {
        const message = errorMessage(error);
        this.supervisor.failure(chainId, message); run.errors.push({ chainId, error: message });
      }
    }
    const controls = await this.repository.controls();
    const rankedStage1 = [...tokenCandidates].sort((a, b) => b.score - a.score || a.hotSearchRank - b.hotSearchRank || a.tokenAddress.localeCompare(b.tokenAddress));
    run.stage1Ranking = {
      eligibleCount,
      exclusions: [...exclusionCounts.entries()].map(([reason, count]) => ({ reason, count })),
      ranked: rankedStage1.map(item => ({ chainId: item.chainId, tokenAddress: item.tokenAddress, symbol: item.symbol, score: item.score, volume1h: item.volume1hUsd, liquidityUsd: item.liquidityUsd, hotSearchRank: item.hotSearchRank })),
    };
    if (rankedStage1.length > 0) {
      const winner = rankedStage1[0]!;
      const volume = winner.volume1hUsd;
      run.selectedTokenAddress = winner.tokenAddress;
      run.selectedTokenSymbol = winner.symbol;
      run.selectedTokenVolume1h = volume;
      const initialBotState = controls.botState ?? 'STOPPED';
      run.candidateHandoff = { selectedTokenAddress: winner.tokenAddress, selectedTokenSymbol: winner.symbol, status: 'NOT_ATTEMPTED', reason: null, controlsBotState: initialBotState, initialBotState, timestamp: Date.now() / 1000 };
    }
    const snapshots = [...this.discoverySnapshots.values()];
    if (snapshots.length) {
      const securityDecisions = snapshots.flatMap(snapshot => snapshot.securityDecisions ?? []);
      run.discoverySnapshot = {
        rawFetched: snapshots.reduce((n, s) => n + s.rawFetched, 0), blockedFiltered: snapshots.reduce((n, s) => n + s.stockFiltered, 0),
        discovered: snapshots.reduce((n, s) => n + s.discovered, 0), economicFiltered: snapshots.reduce((n, s) => n + s.economicFiltered, 0),
        securityScreened: snapshots.reduce((n, s) => n + s.screened, 0), pass: snapshots.reduce((n, s) => n + s.pass, 0), reject: snapshots.reduce((n, s) => n + s.reject, 0), eligible: eligibleCount, securityDecisions,
      };
    }
    let selectedDexShortlist: ExternalPoolShortlist | undefined;
    const preEnrichmentControls = await this.repository.controls();
    if (rankedStage1.length > 0 && run.candidateHandoff) { const state = preEnrichmentControls.botState ?? 'STOPPED'; run.candidateHandoff.preEnrichmentBotState = state; run.candidateHandoff.controlsBotState = state; }
    if (preEnrichmentControls.botState === 'RUNNING' && tokenCandidates.length > 0) {
      const winner = rankedStage1[0]!;
      if (run.candidateHandoff) run.candidateHandoff.status = 'POOL_LOOKUP';
      console.error(`[viero.token-ranking] ${tokenCandidates.map((x, i) => `${i + 1} ${x.symbol ?? x.tokenAddress.slice(0, 8) + '…'} score=${x.score.toFixed(4)} volume1h=${x.volume1hUsd} liquidity=${x.liquidityUsd}`).join('\n[viero.token-ranking] ')}`);
      const external = await dexScreenerShortlist(winner.chainId, winner.tokenAddress);
      selectedDexShortlist = external;
      const chain = getChain(winner.chainId), allowed = new Set([chain.primaryStable.toLowerCase(), ...(chain.wrappedNative ? [chain.wrappedNative.toLowerCase()] : [])]);
      const pools = external.hints.filter(h => allowed.has(h.token0.toLowerCase()) || allowed.has(h.token1.toLowerCase())).sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || a.identity.localeCompare(b.identity)).slice(0, 10);
      pools.forEach((p, i) => console.error(`[viero.pool-shortlist] token=${winner.symbol ?? winner.tokenAddress} ${i + 1} pool=${p.identity} liquidity=${p.liquidityUsd ?? 'unavailable'}`));
      const bestPool = pools[0];
      if (bestPool) { handoffCandidates.push({ ...winner, poolId: bestPool.identity, protocol: bestPool.protocol }); if (run.candidateHandoff) run.candidateHandoff.status = 'READY'; }
      else {
        // DEX Screener is advisory; let executeCandidateToken perform the
        // broad targeted-RPC fallback when no external hint is usable.
        handoffCandidates.push({ ...winner, poolId: 'external-pending', protocol: 'v4' });
        if (run.candidateHandoff) { run.candidateHandoff.status = 'READY'; run.candidateHandoff.reason = null; }
      }
    } else if (rankedStage1.length > 0 && run.candidateHandoff) {
      run.candidateHandoff.status = 'SKIPPED'; run.candidateHandoff.reason = 'BOT_STOPPED';
    }
    const preExecutionControls = await this.repository.controls();
    if (run.candidateHandoff) { const state = preExecutionControls.botState ?? 'STOPPED'; run.candidateHandoff.preExecutionBotState = state; run.candidateHandoff.controlsBotState = state; }
    if (preExecutionControls.botState === 'RUNNING' && handoffCandidates.length > 0) {
      handoffCandidates.splice(0, handoffCandidates.length, ...rankCandidateOpportunities(handoffCandidates));
      handoffCandidates.forEach((item, index) => console.error(`[viero.candidate-ranking] ${index + 1} ${item.symbol ?? item.tokenAddress.slice(0, 8) + '…'} score=${item.score.toFixed(4)} volume1h=${item.volume1hUsd} liquidity=${item.liquidityUsd}`));
      console.error(`[viero.candidate-selection] pass=${passCount} eligible=${eligibleCount} selected=${handoffCandidates[0]!.tokenAddress.slice(0, 8)}… selected_address=${handoffCandidates[0]!.tokenAddress}`);
      const selected = handoffCandidates[0]!;
      const selectedDecision = (run.tokenDecisions ?? []).find(item => item.chainId === selected.chainId && item.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase());
      run.selectedTokenAddress = selected.tokenAddress;
      run.selectedTokenSymbol = selectedDecision?.symbol;
      run.selectedTokenVolume1h = selectedDecision?.volume1h ?? null;
      const memoryKey = `${selected.chainId}:${selected.tokenAddress.toLowerCase()}`;
      const memoryEntry = tokenMemory[memoryKey];
      if (memoryEntry) { memoryEntry.candidateAttempts += 1; memoryEntry.lastAttemptAt = Date.now() / 1000; memoryEntry.lastAttemptResult = 'HANDED_OFF'; memoryEntry.lastPoolId = selected.poolId; await this.tokenMemory.save(tokenMemory); }
      if (run.candidateHandoff) run.candidateHandoff.status = 'EXECUTED';
      await this.executeCandidateToken({ chainId: selected.chainId, tokenAddress: selected.tokenAddress, mode: options.mode as Extract<Mode, 'live-execution' | 'live-readonly'>, run, dexShortlist: selectedDexShortlist });
    } else if (passCount > 0) { if (run.candidateHandoff && run.candidateHandoff.status !== 'SKIPPED') { run.candidateHandoff.status = 'SKIPPED'; run.candidateHandoff.reason = preExecutionControls.botState !== 'RUNNING' ? 'BOT_STOPPED' : null; } console.error(`[viero.candidate-selection] pass=${passCount} eligible=${eligibleCount} selected=none selected_address=none`); }
    run.finishedAt = options.mode === 'replay' ? now : Date.now() / 1000;
    // Some lightweight discovery/test repositories do not expose strategyState;
    // keep the run persistence path backwards-compatible in that case.
    const strategyStateReader = (this.repository as Partial<Repository>).strategyState;
    const currentStrategy = typeof strategyStateReader === 'function'
      ? await strategyStateReader.call(this.repository)
      : null;
    run.livePositions = currentStrategy ? (await Promise.all(currentStrategy.positions
      .filter((position): position is typeof position & { status: 'open' | 'closing' } => position.status === 'open' || position.status === 'closing')
      .map(async position => {
        try {
          const enriched: any = position.pool.protocol === 'v4' ? await this.enrichV4Position(position) : await this.enrichV3Position(position);
          const feeUsd = enriched.feeUsd ?? null;
          const pnlBase = feeUsd != null && enriched.valueUsd != null ? enriched.valueUsd + feeUsd : enriched.valueUsd;
          const pnlDepositUsd = effectivePnlDepositUsd({ persistedDepositUsd: position.plan.depositUsd, entryPrincipalUsd: position.entryPrincipalUsd, principalValueUsd: enriched.valueUsd ?? null,
            token0Address: enriched.token0?.address, token1Address: enriched.token1?.address, amount0: enriched.amount0, amount1: enriched.amount1,
            primaryStable: getChain(position.chainId).primaryStable });
          const pnlPct = pnlPctFromValues(pnlBase, pnlDepositUsd);
          const feeDetails = enriched.feeEvidence && enriched.fee0Human != null && enriched.fee1Human != null
            ? `${enriched.fee0Human} ${enriched.token0.symbol} + ${enriched.fee1Human} ${enriched.token1.symbol}` : null;
          return { id: position.id, tokenId: position.tokenId.toString(), protocol: position.pool.protocol, status: position.status,
            symbol: enriched.baseSymbol, openedAt: position.openedAt, closeReason: position.closeReason, valueUsd: enriched.valueUsd ?? null, feeUsd,
            feeDetails, pnlPct, inRange: enriched.inRange, currentPrice: enriched.currentPrice, lowerPrice: enriched.lowerPrice, upperPrice: enriched.upperPrice,
            baseSymbol: enriched.baseSymbol, quoteSymbol: enriched.quoteSymbol, peakPnlPct: position.peakPnlPct,
            trailingTakeProfitArmed: position.trailingTakeProfitArmed, outOfRangeSince: position.outOfRangeSince,
            poolAddress: position.pool.protocol === 'v3' ? position.pool.poolAddress : undefined };
        } catch {
          return { id: position.id, tokenId: position.tokenId.toString(), protocol: position.pool.protocol, status: position.status,
            openedAt: position.openedAt, closeReason: position.closeReason, valueUsd: null, feeUsd: null, feeDetails: null, pnlPct: null,
            peakPnlPct: position.peakPnlPct, trailingTakeProfitArmed: position.trailingTakeProfitArmed, outOfRangeSince: position.outOfRangeSince,
            poolAddress: position.pool.protocol === 'v3' ? position.pool.poolAddress : undefined };
        }
      }))) : [];
    run.health = [...this.providers.health.values()];
    run.providerObservations = this.providers.observations.splice(0);
    // status reflects whether every enabled chain produced a tokenDecisions
    // entry. If a chain was paused/disabled/errored, it's reflected in errors.
    run.status = run.errors.length === 0 ? 'ok' : (run.tokenDecisions && run.tokenDecisions.length > 0 ? 'degraded' : 'failed');
    for (const item of run.tokenDecisions ?? []) {
      const key = `${item.chainId}:${item.tokenAddress.toLowerCase()}`;
      const prior = tokenMemory[key];
      tokenMemory[key] = { symbol: item.symbol, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now, candidateAttempts: prior?.candidateAttempts ?? 0, successfulOpens: prior?.successfulOpens ?? 0, failedAttempts: prior?.failedAttempts ?? 0, closedPositions: prior?.closedPositions ?? 0, wins: prior?.wins ?? 0, losses: prior?.losses ?? 0, averagePnlPct: prior?.averagePnlPct ?? 0, consecutiveOutOfRangeCloses: prior?.consecutiveOutOfRangeCloses ?? 0, consecutiveStopLossCloses: prior?.consecutiveStopLossCloses ?? 0, ...(prior?.cooldownUntil !== undefined ? { cooldownUntil: prior.cooldownUntil } : {}), ...(prior?.cooldownReason ? { cooldownReason: prior.cooldownReason } : {}) };
    }
    // Discovery-only repository doubles may not provide strategy persistence;
    // production repositories do, and retain durable token memory there.
    if (typeof (this.repository as Partial<Repository>).strategyState === 'function') {
      await this.tokenMemory.save(tokenMemory);
    }
    if (options.persist !== false) await this.repository.saveRun(run);
    return run;
  }

  /**
   * Rank freshly-PASSed tokens from evidence retained by TokenDiscovery.
   * This performs no provider or RPC calls.
   */
  private rankScreenedTokens(chainId: ChainId, entries: ReadonlyArray<{ address: Address; hotSearchRank?: number | null; symbol?: string; name?: string; volume1h?: number | null; lastTokenScreenResult: 'PASS' | 'REJECT' | 'RETRY_LATER'; rejectReason?: import('../discovery/tokenScreener.js').TokenRejectionCode; risk?: Risk }>) {
    const items = entries.map(entry => ({ chainId, tokenAddress: entry.address, risk: entry.risk ?? null, entry: { hotSearchRank: entry.hotSearchRank ?? null } }));
    const ranked = this.rankTokens(items);
    return ranked.map((r) => {
      const entry = entries.find((e) => e.address === r.tokenAddress)!;
      const risk = items.find((i) => i.tokenAddress === r.tokenAddress)?.risk ?? null;
      return {
        chainId: r.chainId, tokenAddress: r.tokenAddress, rank: r.rank,
        symbol: entry.symbol, name: entry.name,
        volume1h: entry.volume1h ?? null,
        verdict: entry.lastTokenScreenResult,
        rejectReason: entry.rejectReason,
        hotSearchRank: entry.hotSearchRank ?? null,
        holdersTop10Pct: risk?.top10HolderPct ?? null,
        sellTaxBps: risk?.sellTaxBps ?? null,
        buySimulation: risk?.buySimulation ?? null,
        sellSimulation: risk?.sellSimulation ?? null,
        honeypot: risk?.honeypot ?? null,
        criticalAdmin: risk?.criticalAdmin ?? null,
        smartMoneyScore: risk?.smartMoneyScore ?? null,
        tokenAgeSeconds: risk?.observedAt ? Math.floor((Date.now() / 1000) - (risk.observedAt as unknown as number)) : null,
      };
    });
  }

  /**
   * EXECUTION-CANDIDATE PATH: from a SELECTED token, do pool discovery,
   * pool screening, on-chain verification, simulation, and planner /
   * execution. This is the ONLY path that issues gmgn token-pool queries,
   * RPC factory / event calls, and execution transactions.
   *
   * Caller supplies the AgentRun to attach the result to. Caller is
   * responsible for setting the run.id and run.startedAt.
   */
  async executeCandidateToken(input: { chainId: ChainId; tokenAddress: Address; mode: Extract<Mode, 'live-execution' | 'live-readonly'>; run: AgentRun; dexShortlist?: ExternalPoolShortlist }): Promise<AgentRun> {
    const { chainId, tokenAddress, mode, run } = input;
    run.startedAt = run.startedAt ?? (Date.now() / 1000);
    run.finishedAt = run.startedAt;
    run.mode = mode;
    run.configVersion = POLICY_VERSION;
    run.deploymentVersion = DEPLOYMENT_VERSION;
    run.policy = this.policy;
    run.observations ??= [];
    run.candidates ??= [];
    run.discoveries ??= [];
    run.decisions ??= [];
    run.tokenDecisions ??= [];
    run.positions ??= [];
    run.health ??= [];
    run.providerObservations ??= [];
    run.errors ??= [];
    run.status ??= 'ok';
    const now = Date.now() / 1000;
    try {
      const controls = await this.repository.controls();
      assertCandidateExecutionAllowed(controls, chainId);
      assertLiveExecutionEnabled(mode);
      this.supervisor.assertActive(chainId);
      if (!this.checkedDeployments.has(chainId)) {
        const smoke = await smokeTest(this.clients, chainId);
        if (!smoke.ok) throw new Error(`DEPLOYMENT_SMOKE_FAILED: ${smoke.checks.filter(check => !check.ok).map(check => check.address).join(',')}`);
        this.checkedDeployments.add(chainId);
      }
      // Search both protocols completely before choosing by external USD TVL.
      const search = await searchVerifiedPoolsForToken(this.clients.get(chainId), chainId, tokenAddress, { dex: input.dexShortlist });
      run.poolDiscovery = search.evidence;
      const shortlist = search.pools;
      console.error(`[viero.pool-discovery] graphql_v4=${search.evidence.graphqlV4Hints.length} dex_v4=${search.evidence.dexV4Hints.length} dex_v3=${search.evidence.dexV3Hints.length} gecko_v3=${search.evidence.geckoV3Hints.length} verified=${shortlist.length} selected=${search.evidence.selectedPool ?? 'none'}`);
      if (search.evidence.finalOutcome === 'PROVIDER_FAILURE') throw new Error('POOL_DISCOVERY_PROVIDER_FAILURE');
      if (shortlist.length === 0) throw new Error(`NO_SUPPORTED_POOL: ${tokenAddress}`);
      const poolRef = shortlist[0]!.ref;
      const selectedPoolIdentity = shortlist[0]!.pool.poolId ?? shortlist[0]!.pool.poolAddress;
      const selectedMemory = await this.tokenMemory.load();
      const selectedMemoryEntry = selectedMemory[`${chainId}:${tokenAddress.toLowerCase()}`];
      if (selectedMemoryEntry && selectedPoolIdentity && selectedMemoryEntry.lastPoolId !== selectedPoolIdentity) {
        selectedMemoryEntry.lastPoolId = selectedPoolIdentity;
        await this.tokenMemory.save(selectedMemory);
      }

      // Step 2: on-chain verifyPool (RPC).
      const head = await this.clients.get(chainId).getBlockNumber({ cacheTime: 0 });
      const state = await verifyPool(this.clients.get(chainId), poolRef, head);

      // Step 3: GMGN prices for both pool tokens.
      const prices = (await Promise.all([state.token0, state.token1].map(t => this.market.prices(chainId, t.address)))).flat();

      // Step 4: GMGN risks for both pool tokens.
      const enriched = await Promise.all([state.token0.address, state.token1.address].map(t => this.gmgn.security(chainId, t)));
      const risks = enriched.filter((r): r is Risk => r !== null);

      // Step 5: build full Observation + run the FULL deterministic screener.
      const chain = getChain(chainId);
      const nativeUsd = chain.native.isErc20Backed ? 1 : chain.wrappedNative
        ? (await this.market.prices(chainId, chain.wrappedNative))[0]?.usd ?? null : null;
      const observation = await targetedRpcObservation(this.clients.get(chainId), state, prices, this.policy.windowMinutes, nativeUsd);
      for (const risk of risks) if (!observation.risks.some((existing) => existing.token === risk.token)) observation.risks.push(risk);
      const finalNow = Date.now() / 1000;
      const candidate = screen(observation, this.policy, finalNow, { tokenVolume1h: run.selectedTokenVolume1h }); // token-level GMGN volume is authoritative
      run.observations.push(observation);
      const strategy = mode === 'live-execution' ? await this.repository.strategyState() : null;
      if (strategy) {
        const history = historicalRejections(candidate, observation, strategy, this.policy, now);
        if (history.length) { candidate.rejections.push(...history); candidate.approved = false; }
      }
      if (!candidate.approved) {
        run.candidates.push(candidate);
        run.status = 'degraded';
        run.finishedAt = Date.now() / 1000;
        run.health = [...this.providers.health.values()];
        run.providerObservations = this.providers.observations.splice(0);
        await this.repository.saveRun(run);
        return run;
      }
      run.candidates.push(candidate);

      // Step 6: deterministic pool ranking (only one pool here; rank=1).
      const ranked = rank([candidate]);
      const winner = ranked.find((c) => c.approved) ?? candidate;
      run.candidates = ranked;

      // Step 7: deterministic planning after historical gating.
      const open = strategy?.positions.filter((p) => p.status === 'open') ?? [];
      const day = new Date(now * 1000).toISOString().slice(0, 10);
      const exposure: PortfolioLimits = {
        totalExposureUsd: open.reduce((sum, p) => sum + p.plan.depositUsd, 0),
        chainExposureUsd: {},
        dailyLossUsd: strategy?.dailyRealizedLossUsd[day] ?? 0,
      };
      for (const p of open) exposure.chainExposureUsd[p.chainId] = (exposure.chainExposureUsd[p.chainId] ?? 0) + p.plan.depositUsd;
      const selection = await selectCandidate(ranked, this.model);
      const decision: AgentRun['decisions'][number] = { chainId, promptVersion: PROMPT_VERSION, model: this.model ? 'injected-bounded-model' : 'deterministic', selection };
      if (selection.action === 'preview') {
        const walletTokens = poolRef.protocol === 'v3'
          ? [state.token0.address, state.token1.address]
          : [poolRef.poolKey.currency0, poolRef.poolKey.currency1];
        if (!walletTokens.includes(getChain(chainId).primaryStable)) walletTokens.push(getChain(chainId).primaryStable);
        const wallet = mode === 'live-execution' ? await this.signer?.balances(chainId, walletTokens) : undefined;
        if (mode === 'live-execution' && (!this.signer || !strategy || !wallet)) throw new Error('SIGNER_NOT_CONFIGURED');
        const tokenPrices = new Map(state ? [state.token0, state.token1].map(token => [token.address,
          canonicalPrice(observation.prices, token.address, now, this.policy)?.usd ?? null] as const) : []);
        const availableExecutionBalanceUsd = wallet ? [state.token0, state.token1].reduce((sum, token) => {
          const price = tokenPrices.get(token.address), amount = wallet.tokens.get(token.address);
          return price != null && amount !== undefined ? sum + Number(amount) / 10 ** token.decimals * price : sum;
        }, 0) : null;
        const settings = await resolveExecutionSettings({
          controls, chainId, llm: this.strategyLlm,
          sizeContext: {
            walletEquityUsd: availableExecutionBalanceUsd === null ? null : availableExecutionBalanceUsd + exposure.totalExposureUsd,
            availableExecutionBalanceUsd,
            existingExposureUsd: exposure.totalExposureUsd,
            activePositions: open.length,
            tokenRisk: risks,
            volatilityPct: winner.metrics.volatility?.realizedPct ?? null,
            liquidityUsd: winner.metrics.tvlUsd,
            marketData: { volumeUsd: winner.metrics.volumeUsd, depthUsd: winner.metrics.depthUsd },
          },
          rangeContext: {
            volatilityPct: winner.metrics.volatility?.realizedPct ?? null,
            poolFeeTier: state.fee,
            liquidityUsd: winner.metrics.tvlUsd,
            marketActivity: { volumeUsd: winner.metrics.volumeUsd, swapCount: winner.metrics.swapCount },
            direction: 'single-side',
          },
        });
        decision.plan = planPosition(observation, winner, settings.positionSizeUsd, this.policy, exposure, now, wallet,
          mode === 'live-execution' ? 'live' : 'paper', settings);
        exposure.totalExposureUsd += decision.plan.depositUsd;
        exposure.chainExposureUsd[chainId] = (exposure.chainExposureUsd[chainId] ?? 0) + decision.plan.depositUsd;
        if (mode === 'live-execution') {
          const executed = await this.signer!.open(decision.plan, observation, this.policy);
          // The planner's depositUsd is a transfer/budget bound.  A mint can
          // consume less (for example when the entry state moves during the
          // transaction), so capture the actual principal immediately after
          // the confirmed mint and use it as the canonical PnL cost basis.
          let openedPosition = executed.value;
          try {
            const enriched = openedPosition.pool.protocol === 'v4'
              ? await this.enrichV4Position(openedPosition)
              : await this.enrichV3Position(openedPosition);
            if (enriched.valueUsd != null && Number.isFinite(enriched.valueUsd) && enriched.valueUsd > 0) {
              openedPosition = { ...openedPosition, entryPrincipalUsd: enriched.valueUsd };
            }
          } catch (error) {
            console.error(`[viero.execution] post-mint principal observation unavailable: ${errorMessage(error)}`);
          }
          strategy!.positions.push(openedPosition); strategy!.transactions.push(...executed.transactions);
          strategy!.transactions = strategy!.transactions.slice(-5000);
          decision.transactionHashes = executed.transactions.map((t) => t.hash);
          const mint = executed.transactions.find((t) => t.action === 'mint');
          if (mint) {
            decision.opened = { positionId: openedPosition.id, tokenId: openedPosition.tokenId.toString(), protocol: openedPosition.pool.protocol, txHash: mint.hash, sizeUsd: decision.plan.positionSizeUsd };
            strategy!.managementNotifications ??= [];
            strategy!.managementNotifications.push({ id: `${executed.value.id}:opened:${mint.hash}`, kind: 'opened', positionId: executed.value.id, symbol: run.selectedTokenSymbol, protocol: executed.value.pool.protocol, tokenId: executed.value.tokenId.toString(), valueUsd: decision.plan.positionSizeUsd, txHash: mint.hash, status: 'SUCCESS', at: Date.now() / 1000 });
            strategy!.managementNotifications = strategy!.managementNotifications.slice(-500);
          }
          await this.repository.setStrategyState(strategy!);
          const openedMemory = await this.tokenMemory.load(), openedKey = `${chainId}:${tokenAddress.toLowerCase()}`;
          const openedEntry = openedMemory[openedKey];
          if (openedEntry) { openedEntry.successfulOpens += 1; openedEntry.lastAttemptResult = 'OPENED'; openedEntry.lastAttemptAt = Date.now() / 1000; await this.tokenMemory.save(openedMemory); }
        }
      }
      run.decisions.push(decision);
      run.status = run.errors.length === 0 ? 'ok' : 'degraded';
    } catch (error) {
      const failure = errorMessage(error);
      const candidateSpecific = /^(NO_SUPPORTED_POOL|INSUFFICIENT_QUOTE_BALANCE|POOL_|FIXED_RANGE_|RANGE_LIMIT|SIMULATION_REQUIRED|EXECUTION_TRANSACTION_REVERTED)/.test(failure);
      if (candidateSpecific) {
        const key = `${chainId}:${tokenAddress.toLowerCase()}`, memory = await this.tokenMemory.load();
        const entry = memory[key] ?? { firstSeenAt: Date.now() / 1000, lastSeenAt: Date.now() / 1000, candidateAttempts: 1, successfulOpens: 0, failedAttempts: 0, closedPositions: 0, wins: 0, losses: 0, averagePnlPct: 0, consecutiveOutOfRangeCloses: 0, consecutiveStopLossCloses: 0 };
        if (entry.lastAttemptResult !== failure.split(':')[0]) {
          entry.failedAttempts += 1; entry.lastAttemptResult = failure.split(':')[0];
          const seconds = entry.lastAttemptResult === 'NO_SUPPORTED_POOL' ? this.policy.noSupportedPoolCooldownSeconds : entry.lastAttemptResult === 'INSUFFICIENT_QUOTE_BALANCE' ? this.policy.insufficientQuoteBalanceCooldownSeconds : this.policy.poolCooldownSeconds;
          entry.cooldownUntil = Date.now() / 1000 + seconds; entry.cooldownReason = entry.lastAttemptResult;
          await this.tokenMemory.save(memory);
          console.error(`[viero.token-memory] token=${tokenAddress} candidateAttempts=${entry.candidateAttempts} failedAttempts=${entry.failedAttempts} lastResult=${entry.lastAttemptResult} cooldownUntil=${entry.cooldownUntil} cooldownReason=${entry.cooldownReason}`);
        }
      }
      if (error instanceof InsufficientQuoteBalanceError) {
        run.errors.push({ chainId, error: error.message, code: error.code, details: {
          ...error.details,
          requiredRaw: error.details.requiredRaw.toString(), availableRaw: error.details.availableRaw.toString(),
        }});
      } else run.errors.push({ chainId, error: failure });
      run.status = 'failed';
    }
    run.finishedAt = Date.now() / 1000;
    run.health = [...this.providers.health.values()];
    run.providerObservations = this.providers.observations.splice(0);
    await this.repository.saveRun(run);
    return run;
  }
  /**
   * Build a fresh observation for an open position. Uses RPC directly
   * (verifyPool + rpcObservation + gmgn security) and does NOT require
   * the local indexer. This is the token-first architecture's preferred
   * path for management: the pool identity is already known from the
   * stored LivePosition, so we never need a pool universe lookup.
   */
  async observePool(pool: LivePoolRef): Promise<Observation> {
    const client = this.clients.get(pool.chainId);
    const state = await verifyPool(client, pool);
    // Fetch prices for both pool tokens.
    const tokens = pool.protocol === 'v3'
      ? [pool.poolAddress]
      : [pool.poolKey.currency0, pool.poolKey.currency1];
    const prices = (await Promise.all([state.token0, state.token1].map(t => this.market.prices(pool.chainId, t.address)))).flat();
    const chain = getChain(pool.chainId);
    const nativeUsd = chain.native.isErc20Backed ? 1 : chain.wrappedNative
      ? (await this.market.prices(pool.chainId, chain.wrappedNative))[0]?.usd ?? null : null;
    const observation = await targetedRpcObservation(client, state, prices, this.policy.windowMinutes, nativeUsd);
    const risks = await Promise.all([state.token0.address, state.token1.address].map(token => this.gmgn.security(pool.chainId, token)));
    for (const risk of risks) if (!observation.risks.some(existing => existing.token === risk.token)) observation.risks.push(risk);
    void tokens;
    return observation;
  }
  async observePoolLightweight(pool: LivePoolRef): Promise<Observation> {
    const client = this.clients.get(pool.chainId), state = await verifyPool(client, pool);
    const prices = (await Promise.all([state.token0, state.token1].map(t => this.market.prices(pool.chainId, t.address)))).flat();
    return lightweightManagementObservation(state, prices);
  }
  private async attachV4Fees(position: import('../execution/liveState.js').LivePosition, observation: Observation) {
    if (position.pool.protocol !== 'v4') return observation as Observation & { feeEvidence: false };
    try {
      const client = this.clients.get(position.chainId), poolId = position.pool.poolId;
      const [current, stored] = await Promise.all([
      client.readContract({ address: getChain(position.chainId).v4.stateView, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [poolId, position.plan.tickLower, position.plan.tickUpper] }),
      client.readContract({ address: getChain(position.chainId).v4.stateView, abi: stateViewAbi, functionName: 'getPositionInfo', args: [poolId, position.positionManager, position.plan.tickLower, position.plan.tickUpper, `0x${position.tokenId.toString(16).padStart(64, '0')}`] }),
      ]);
      const liquidity = BigInt(stored[0] as bigint), { fee0Raw, fee1Raw } = v4FeeGrowthDelta(BigInt(current[0]), BigInt(current[1]), BigInt(stored[1]), BigInt(stored[2]), liquidity);
      const prices = [observation.state.token0, observation.state.token1].map(t => canonicalPrice(observation.prices, t.address, Date.now() / 1000, this.policy)?.usd ?? null);
      const feeUsd = prices[0] == null || prices[1] == null ? null : tokenValue(fee0Raw, observation.state.token0.decimals, prices[0]) + tokenValue(fee1Raw, observation.state.token1.decimals, prices[1]);
      return Object.assign(observation, { fee0Raw, fee1Raw, feeUsd, fee0Human: formatUnits(fee0Raw, observation.state.token0.decimals), fee1Human: formatUnits(fee1Raw, observation.state.token1.decimals), feeEvidence: feeUsd !== null });
    } catch { return Object.assign(observation, { feeEvidence: false, fee0Raw: null, fee1Raw: null, feeUsd: null }); }
  }
  private async attachV3Fees(position: import('../execution/liveState.js').LivePosition, observation: Observation) {
    try {
      if (position.pool.protocol !== 'v3' || !position.pool.poolAddress) throw new Error('V3_POOL_REQUIRED');
      const client = this.clients.get(position.chainId), raw = await client.readContract({ address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'positions', args: [position.tokenId] }) as readonly unknown[];
      const liquidity = BigInt(raw[7] as bigint), tickLower = Number(raw[5]), tickUpper = Number(raw[6]);
      const [global0, global1, lower, upper] = await Promise.all([
        client.readContract({ address: position.pool.poolAddress, abi: v3Abi, functionName: 'feeGrowthGlobal0X128' }), client.readContract({ address: position.pool.poolAddress, abi: v3Abi, functionName: 'feeGrowthGlobal1X128' }),
        client.readContract({ address: position.pool.poolAddress, abi: v3Abi, functionName: 'ticks', args: [tickLower] as any }), client.readContract({ address: position.pool.poolAddress, abi: v3Abi, functionName: 'ticks', args: [tickUpper] as any })]);
      const inside0 = feeGrowthInsideV3(BigInt(global0 as unknown as bigint), BigInt((lower as readonly unknown[])[2] as bigint), BigInt((upper as readonly unknown[])[2] as bigint), observation.state.tick, tickLower, tickUpper);
      const inside1 = feeGrowthInsideV3(BigInt(global1 as unknown as bigint), BigInt((lower as readonly unknown[])[3] as bigint), BigInt((upper as readonly unknown[])[3] as bigint), observation.state.tick, tickLower, tickUpper);
      const fees = v3UnclaimedFees({ tokensOwed0: BigInt(raw[10] as bigint), tokensOwed1: BigInt(raw[11] as bigint), feeGrowthInside0Now: inside0, feeGrowthInside1Now: inside1, feeGrowthInside0Last: BigInt(raw[8] as bigint), feeGrowthInside1Last: BigInt(raw[9] as bigint), liquidity });
      const prices = [observation.state.token0, observation.state.token1].map(t => canonicalPrice(observation.prices, t.address, Date.now() / 1000, this.policy)?.usd ?? null);
      const feeUsd = prices[0] == null || prices[1] == null ? null : tokenValue(fees.fee0Raw, observation.state.token0.decimals, prices[0]) + tokenValue(fees.fee1Raw, observation.state.token1.decimals, prices[1]);
      return Object.assign(observation, { fee0Raw: fees.fee0Raw, fee1Raw: fees.fee1Raw, fee0Human: formatUnits(fees.fee0Raw, observation.state.token0.decimals), fee1Human: formatUnits(fees.fee1Raw, observation.state.token1.decimals), feeUsd, feeEvidence: feeUsd !== null });
    } catch { return Object.assign(observation, { feeEvidence: false, fee0Raw: null, fee1Raw: null, feeUsd: null }); }
  }
  private async observePositionLightweight(position: import('../execution/liveState.js').LivePosition) {
    const observed = await this.observePoolLightweight(position.pool);
    return position.pool.protocol === 'v4' ? this.attachV4Fees(position, observed) : this.attachV3Fees(position, observed);
  }
  private carryFreshManagementPrices(fresh: Observation, prior: Observation, now: number): Observation {
    const tokens = [fresh.state.token0, fresh.state.token1];
    const prices = [...fresh.prices];
    for (const token of tokens) {
      if (canonicalPrice(prices, token.address, now, this.policy)) continue;
      const usablePrior = prior.prices.filter(price => price.token.toLowerCase() === token.address.toLowerCase());
      if (canonicalPrice(usablePrior, token.address, now, this.policy)) prices.push(...usablePrior);
    }
    fresh.prices = prices;
    const fee0Raw = (fresh as Observation & { fee0Raw?: bigint | null }).fee0Raw;
    const fee1Raw = (fresh as Observation & { fee1Raw?: bigint | null }).fee1Raw;
    if (fee0Raw != null && fee1Raw != null) {
      const p0 = canonicalPrice(prices, fresh.state.token0.address, now, this.policy)?.usd;
      const p1 = canonicalPrice(prices, fresh.state.token1.address, now, this.policy)?.usd;
      if (p0 != null && p1 != null) Object.assign(fresh, {
        feeUsd: tokenValue(fee0Raw, fresh.state.token0.decimals, p0) + tokenValue(fee1Raw, fresh.state.token1.decimals, p1),
        feeEvidence: true,
      });
    }
    return fresh;
  }

  /** Read-only V3 NFT enrichment for Telegram position cards. */
  async enrichV3Position(position: import('../execution/liveState.js').LivePosition) {
    if (position.pool.protocol !== 'v3') throw new Error('V3_POSITION_REQUIRED');
    const observation = await this.observePositionLightweight(position);
    const client = this.clients.get(position.chainId);
    const raw = await client.readContract({ address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'positions', args: [position.tokenId] }) as readonly unknown[];
    const token0 = observation.state.token0, token1 = observation.state.token1;
    const liquidity = raw[7] as bigint, tickLower = Number(raw[5]), tickUpper = Number(raw[6]);
    const current = observation.state.sqrtPriceX96;
    const lo = sqrtAtTick(tickLower), hi = sqrtAtTick(tickUpper);
    const amount0 = current <= lo ? amount0Delta(lo, hi, liquidity) : current >= hi ? 0n : amount0Delta(current, hi, liquidity);
    const amount1 = current >= hi ? amount1Delta(lo, hi, liquidity) : current <= lo ? 0n : amount1Delta(lo, current, liquidity);
    const prices = new Map([token0, token1].map(t => [t.address.toLowerCase(), canonicalPrice(observation.prices, t.address, Date.now() / 1000, this.policy)?.usd ?? null]));
    const p0 = prices.get(token0.address.toLowerCase()), p1 = prices.get(token1.address.toLowerCase());
    const valueUsd = p0 != null && p1 != null ? tokenValue(amount0, token0.decimals, p0) + tokenValue(amount1, token1.decimals, p1) : null;
    const chain = getChain(position.chainId), quoteIs0 = token0.address.toLowerCase() === chain.primaryStable.toLowerCase() || token0.address.toLowerCase() === chain.wrappedNative?.toLowerCase();
    const quote = quoteIs0 ? token0 : token1, base = quoteIs0 ? token1 : token0;
    const quotePrice = prices.get(quote.address.toLowerCase()), basePrice = prices.get(base.address.toLowerCase());
    const human = (sqrt: bigint) => quotePrice && basePrice ? humanQuotePriceFromSqrt({ sqrtPriceX96: sqrt, quoteIsToken0: quoteIs0, decimals0: token0.decimals, decimals1: token1.decimals }) : null;
    const currentPrice = human(current), lowerPrice = human(sqrtAtTick(tickLower)), upperPrice = human(sqrtAtTick(tickUpper));
    return { observation, token0, token1, liquidity, tickLower, tickUpper, amount0, amount1, valueUsd, fee0: (observation as any).fee0Raw ?? null, fee1: (observation as any).fee1Raw ?? null, fee0Human: (observation as any).fee0Human ?? null, fee1Human: (observation as any).fee1Human ?? null, feeUsd: (observation as any).feeUsd ?? null, feeEvidence: (observation as any).feeEvidence === true,
      currentPrice, lowerPrice, upperPrice, inRange: observation.state.tick >= tickLower && observation.state.tick < tickUpper,
      baseSymbol: base.symbol, quoteSymbol: quote.symbol };
  }
  /** Read-only V4 position enrichment for Telegram position cards. */
  async enrichV4Position(position: import('../execution/liveState.js').LivePosition) {
    if (position.pool.protocol !== 'v4') throw new Error('V4_POSITION_REQUIRED');
    const observation = await this.observePositionLightweight(position);
    const token0 = observation.state.token0, token1 = observation.state.token1;
    // Use the verified position liquidity carried by the persisted plan. A
    // second PositionManager lookup can resolve a different key/slot and was
    // the source of cycle-only valuation drift; Refresh and management use
    // this same canonical liquidity input.
    const liquidity = position.plan.liquidity;
    const tickLower = position.plan.tickLower, tickUpper = position.plan.tickUpper, current = observation.state.sqrtPriceX96;
    const lo = sqrtAtTick(tickLower), hi = sqrtAtTick(tickUpper);
    const amount0 = current <= lo ? amount0Delta(lo, hi, liquidity) : current >= hi ? 0n : amount0Delta(current, hi, liquidity);
    const amount1 = current >= hi ? amount1Delta(lo, hi, liquidity) : current <= lo ? 0n : amount1Delta(lo, current, liquidity);
    const prices = new Map([token0, token1].map(t => [t.address.toLowerCase(), canonicalPrice(observation.prices, t.address, Date.now() / 1000, this.policy)?.usd ?? null]));
    const p0 = prices.get(token0.address.toLowerCase()), p1 = prices.get(token1.address.toLowerCase());
    const valueUsd = p0 != null && p1 != null ? tokenValue(amount0, token0.decimals, p0) + tokenValue(amount1, token1.decimals, p1) : null;
    const chain = getChain(position.chainId), quoteIs0 = token0.address.toLowerCase() === chain.primaryStable.toLowerCase() || token0.address.toLowerCase() === chain.wrappedNative?.toLowerCase();
    const quote = quoteIs0 ? token0 : token1, base = quoteIs0 ? token1 : token0;
    const quotePrice = prices.get(quote.address.toLowerCase()), basePrice = prices.get(base.address.toLowerCase());
    const human = (sqrt: bigint) => quotePrice && basePrice ? humanQuotePriceFromSqrt({ sqrtPriceX96: sqrt, quoteIsToken0: quoteIs0, decimals0: token0.decimals, decimals1: token1.decimals }) : null;
    return { observation, token0, token1, liquidity, tickLower, tickUpper, amount0, amount1, valueUsd, fee0: (observation as any).fee0Raw ?? null, fee1: (observation as any).fee1Raw ?? null, fee0Human: (observation as any).fee0Human ?? null, fee1Human: (observation as any).fee1Human ?? null, feeUsd: (observation as any).feeUsd ?? null, feeEvidence: (observation as any).feeEvidence === true,
      currentPrice: human(current), lowerPrice: human(lo), upperPrice: human(hi), inRange: observation.state.tick >= tickLower && observation.state.tick < tickUpper,
      baseSymbol: base.symbol, quoteSymbol: quote.symbol };
  }
  async manageLive(now = Date.now() / 1000) {
    if (!this.signer) throw new Error('SIGNER_NOT_CONFIGURED');
    const state = await this.repository.strategyState();
    const positionSymbol = (position: import('../execution/liveState.js').LivePosition, observation?: Observation): string | undefined => {
      const token0 = observation?.state.token0, token1 = observation?.state.token1;
      if (!token0 || !token1) return undefined;
      const chain = getChain(position.chainId);
      const quoteAddresses = [chain.primaryStable, chain.wrappedNative].filter(Boolean).map(address => address!.toLowerCase());
      const quote = quoteAddresses.includes(token0.address.toLowerCase()) ? token0
        : quoteAddresses.includes(token1.address.toLowerCase()) ? token1 : undefined;
      return (quote?.address.toLowerCase() === token0.address.toLowerCase() ? token1 : quote?.address.toLowerCase() === token1.address.toLowerCase() ? token0 : undefined)?.symbol;
    };
    const positionTargetSymbol = (position: import('../execution/liveState.js').LivePosition, observation?: Observation): string | undefined => {
      const chain = getChain(position.chainId);
      const target = (position.normalization.targetToken ?? chain.primaryStable).toLowerCase();
      const observed = [observation?.state.token0, observation?.state.token1].find(token => token?.address.toLowerCase() === target);
      if (observed?.symbol) return observed.symbol;
      if (target === chain.primaryStable.toLowerCase()) return 'USDG';
      if (chain.wrappedNative && target === chain.wrappedNative.toLowerCase()) return 'WETH';
      return undefined;
    };
    const enqueue = (event: import('../execution/liveState.js').ManagementNotification) => {
      if (!state.managementNotifications.some(existing => existing.id === event.id)) state.managementNotifications.push(event);
      state.managementNotifications = state.managementNotifications.slice(-500);
    };
    const results: Array<{ positionId: string; action: string; reason: string; transactionHashes: string[] }> = [];
    for (let index = 0; index < state.positions.length; index++) {
      const position = state.positions[index]!;
      const controls = await this.repository.controls();
      const writesAllowed = (controls.botState ?? 'STOPPED') === 'RUNNING';
      if (position.status === 'closing') {
        if (!writesAllowed) {
          results.push({ positionId: position.id, action: 'pause', reason: 'BOT_STOPPED_WRITE_SUPPRESSED', transactionHashes: [] });
          continue;
        }
        // A close is only a durable CLOSING state once a broadcast/pending
        // transaction exists. Legacy records without that evidence are stale
        // intents; leave the live on-chain position OPEN and require a fresh
        // decision rather than retrying blindly.
        if (!state.transactions.some(tx => tx.positionId === position.id && (tx.action === 'decrease' || tx.action === 'burn' || tx.action === 'claim'))) {
          position.status = 'open'; position.closeReason = null; position.lastAction = 'hold'; position.updatedAt = now;
          state.positions[index] = position; await this.repository.setStrategyState(state);
          results.push({ positionId: position.id, action: 'reconciled_open', reason: 'STALE_CLOSING_NO_TX_EVIDENCE', transactionHashes: [] });
          continue;
        }
        try {
    const observation = await this.observePositionLightweight(position);
          const executed = await this.signer.close(position, observation, this.policy, position.lastAction === 'emergency-close');
          state.positions[index] = executed.value; state.transactions.push(...executed.transactions);
          recordClosedOutcome(state, observation, position.id, position.closeReason ?? 'CLOSE_RECOVERY', now, this.policy, executed.value.realizedPnlUsd);
          results.push({ positionId: position.id, action: 'close', reason: position.closeReason ?? 'CLOSE_RECOVERY', transactionHashes: executed.transactions.map(transaction => transaction.hash) });
        } catch (error) {
          position.updatedAt = now;
          results.push({ positionId: position.id, action: 'pause', reason: `CLOSE_RECOVERY_FAILED: ${errorMessage(error)}`, transactionHashes: [] });
        }
        state.transactions = state.transactions.slice(-5000);
        await this.repository.setStrategyState(state);
        continue;
      }
      if (position.status === 'closed' && ['pending', 'failed'].includes(position.normalization.status)) {
        if (!writesAllowed) {
          results.push({ positionId: position.id, action: 'pause', reason: 'BOT_STOPPED_NORMALIZATION_SUPPRESSED', transactionHashes: [] });
          continue;
        }
        try {
          const normalized = await this.signer.normalize(position);
          state.positions[index] = normalized.value; state.transactions.push(...normalized.transactions);
          const normalizationTx = normalized.transactions.find(transaction => transaction.action === 'swap')?.hash ?? normalized.transactions.at(-1)?.hash;
          enqueue({ id: `${position.id}:normalization:${normalized.value.normalization.attempts}`, kind: 'normalization', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), symbol: positionSymbol(position), targetSymbol: positionTargetSymbol(position), status: 'SUCCESS', txHash: normalizationTx, at: now });
          results.push({ positionId: position.id, action: 'normalize', reason: 'POST_CLOSE_INVENTORY_NORMALIZED', transactionHashes: normalized.transactions.map(transaction => transaction.hash) });
        } catch (error) {
          position.updatedAt = now;
          position.normalization = { ...position.normalization, status: 'failed', attempts: position.normalization.attempts + 1, lastError: errorMessage(error) };
          results.push({ positionId: position.id, action: 'normalize', reason: `POST_CLOSE_NORMALIZATION_FAILED: ${errorMessage(error)}`, transactionHashes: [] });
        }
        state.transactions = state.transactions.slice(-5000);
        await this.repository.setStrategyState(state);
        continue;
      }
      if (position.status !== 'open') continue;
      try {
        let observation = await this.observePositionLightweight(position);
        // PnL evidence can be absent from an otherwise valid lightweight
        // snapshot when one canonical price read is transiently unavailable.
        // Retry the complete read twice before evaluating rules; if evidence
        // remains absent, PnL rules still fail closed while range rules run.
        for (let retry = 0; managementPnlPct(position, observation, this.policy, now) === null && retry < 2; retry += 1) {
          observation = await this.observePositionLightweight(position);
        }
        const inRange = observation.state.tick >= position.plan.tickLower && observation.state.tick < position.plan.tickUpper;
        position.outOfRangeSince = inRange ? null : position.outOfRangeSince ?? now;
        const decision = liveManagementDecision(position, observation, this.policy, now);
        console.error(`[viero.position-management] position=${position.id} rule=${decision.reason} confirmed=false in_range=${inRange}`);
        let hashes: string[] = [];
        if (decision.action === 'claim') {
          if (((await this.repository.controls()).botState ?? 'STOPPED') !== 'RUNNING') {
            results.push({ positionId: position.id, action: 'would_claim', reason: 'BOT_STOPPED_WRITE_SUPPRESSED', transactionHashes: [] });
            continue;
          }
          const executed = await this.signer.claim(position); state.positions[index] = executed.value;
          state.transactions.push(...executed.transactions); hashes = executed.transactions.map(transaction => transaction.hash);
        } else if (['close', 'rebalance', 'emergency-close'].includes(decision.action)) {
          let confirmation = this.carryFreshManagementPrices(await this.observePositionLightweight(position), observation, now);
          let confirmInRange = confirmation.state.tick >= position.plan.tickLower && confirmation.state.tick < position.plan.tickUpper;
          let confirmedDecision = liveManagementDecision(position, confirmation, this.policy, now);
          // Canonical prices can be transiently unavailable from a single
          // provider read. PnL-triggered closes still require an independent
          // fresh confirmation, but get two bounded fresh retries rather than
          // silently cancelling a proven SL/TP on one incomplete snapshot.
          const pnlRule = ['STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_TAKE_PROFIT'].includes(decision.reason);
          for (let retry = 0; pnlRule && confirmedDecision.reason.startsWith('PnL unavailable') && retry < 2; retry += 1) {
            confirmation = this.carryFreshManagementPrices(await this.observePositionLightweight(position), observation, now);
            confirmInRange = confirmation.state.tick >= position.plan.tickLower && confirmation.state.tick < position.plan.tickUpper;
            confirmedDecision = liveManagementDecision(position, confirmation, this.policy, now);
          }
          console.error(`[viero.position-confirmation] position=${position.id} reason=${decision.reason} pnl=${managementPnlPct(position, confirmation, this.policy, now) ?? 'unavailable'} result=${confirmedDecision.reason}`);
          if (confirmedDecision.reason !== decision.reason) {
            console.error(`[viero.position-close-trigger] position=${position.id} reason=${decision.reason} confirmed=false cancelled=true`);
            position.outOfRangeSince = confirmInRange ? null : position.outOfRangeSince ?? now;
            state.positions[index] = position;
            await this.repository.setStrategyState(state);
            continue;
          }
          const preWriteControls = await this.repository.controls();
          if ((preWriteControls.botState ?? 'STOPPED') !== 'RUNNING') {
            console.error(`[viero.position-close-trigger] position=${position.id} reason=${decision.reason} confirmed=true executionSuppressed=true suppressionReason=BOT_STOPPED`);
            results.push({ positionId: position.id, action: 'would_close', reason: `${decision.reason}:BOT_STOPPED`, transactionHashes: [] });
            continue;
          }
          console.error(`[viero.position-close-trigger] position=${position.id} reason=${decision.reason} confirmed=true`);
          enqueue({ id: `${position.id}:closing:${Math.floor(now)}`, kind: 'closing', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), symbol: positionSymbol(position, confirmation), reason: decision.reason, pnlPct: (confirmation as any).pnlPct ?? null, valueUsd: (confirmation as any).valueUsd ?? null, feeUsd: (confirmation as any).feeUsd ?? null, at: now });
          await this.repository.setStrategyState(state);
          await this.signer.health();
          const closeAttempt: typeof position = { ...position, lastAction: (decision.action === 'emergency-close' ? 'emergency-close' : 'close') as 'emergency-close' | 'close', closeReason: decision.reason, updatedAt: now };
          const executed = await this.signer.close(closeAttempt, confirmation, this.policy, decision.action === 'emergency-close');
          state.positions[index] = executed.value; state.transactions.push(...executed.transactions); hashes = executed.transactions.map(transaction => transaction.hash);
          recordClosedOutcome(state, observation, position.id, decision.reason, now, this.policy, executed.value.realizedPnlUsd);
          const closeHash = executed.transactions.find(transaction => transaction.action === 'decrease' || transaction.action === 'claim')?.hash;
          enqueue({ id: `${position.id}:closed:${closeHash ?? Math.floor(now)}`, kind: 'closed', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), symbol: positionSymbol(position, confirmation), reason: decision.reason, pnlPct: closeNotificationPnlPct(position, confirmation, this.policy, now, executed.value.realizedPnlUsd), valueUsd: (confirmation as any).valueUsd ?? null, feeUsd: (confirmation as any).feeUsd ?? null, txHash: closeHash, status: 'SUCCESS', at: now });
          const closedMemory = await this.tokenMemory.load(), closedKey = `${position.chainId}:${(position.plan.depositAssets[0]?.token ?? '').toLowerCase()}`, closedEntry = closedMemory[closedKey];
          if (closedEntry) { closedEntry.closedPositions += 1; closedEntry.lastCloseAt = now; closedEntry.lastCloseReason = decision.reason; const closeBasisUsd = position.entryPrincipalUsd ?? position.plan.depositUsd; const pnl = executed.value.realizedPnlUsd == null || !closeBasisUsd ? null : executed.value.realizedPnlUsd / closeBasisUsd * 100; if (pnl != null) { const n = closedEntry.closedPositions; closedEntry.averagePnlPct = ((closedEntry.averagePnlPct * (n - 1)) + pnl) / n; } if (decision.reason === 'TAKE_PROFIT' || decision.reason === 'TRAILING_TAKE_PROFIT') { closedEntry.wins += 1; closedEntry.consecutiveStopLossCloses = 0; closedEntry.consecutiveOutOfRangeCloses = 0; } else if (decision.reason === 'STOP_LOSS') { closedEntry.losses += 1; closedEntry.consecutiveStopLossCloses += 1; closedEntry.consecutiveOutOfRangeCloses = 0; } else if (decision.reason === 'OUT_OF_RANGE_TIMEOUT') { closedEntry.consecutiveOutOfRangeCloses += 1; closedEntry.consecutiveStopLossCloses = 0; } else if (decision.reason === 'FAR_ABOVE_RANGE') { closedEntry.consecutiveOutOfRangeCloses = 0; closedEntry.consecutiveStopLossCloses = 0; if (pnl != null) pnl >= 0 ? closedEntry.wins += 1 : closedEntry.losses += 1; } await this.tokenMemory.save(closedMemory); }
          // Persist the confirmed close before normalization. If Relay fails
          // or the process restarts, the position remains CLOSED and the
          // pending/failed normalization is retried from observed balances.
          state.transactions = state.transactions.slice(-5000);
          await this.repository.setStrategyState(state);
          const beforeNormalize = await this.repository.controls();
          if ((beforeNormalize.botState ?? 'STOPPED') !== 'RUNNING') {
            const closed = state.positions[index]!;
            closed.normalization = { ...closed.normalization, status: 'pending' };
            await this.repository.setStrategyState(state);
            results.push({ positionId: position.id, action: 'close', reason: 'NORMALIZATION_SUPPRESSED_BOT_STOPPED', transactionHashes: hashes });
            continue;
          }
          try {
            const normalized = await this.signer.normalize(executed.value);
            state.positions[index] = normalized.value; state.transactions.push(...normalized.transactions);
            hashes.push(...normalized.transactions.map(transaction => transaction.hash));
          } catch (error) {
            const closed = state.positions[index]!;
            closed.normalization = { ...closed.normalization, status: 'failed', attempts: closed.normalization.attempts + 1, lastError: errorMessage(error) };
            results.push({ positionId: position.id, action: 'normalize', reason: `POST_CLOSE_NORMALIZATION_FAILED: ${errorMessage(error)}`, transactionHashes: [] });
            enqueue({ id: `${position.id}:normalization:${closed.normalization.attempts}`, kind: 'normalization', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), symbol: positionSymbol(position, confirmation), targetSymbol: positionTargetSymbol(position, confirmation), status: 'FAILED', error: errorMessage(error), at: now });
          }
          if (state.positions[index]?.normalization.status === 'complete') {
            const normalized = state.positions[index]!;
            const normalizationTx = hashes.at(-1);
            enqueue({ id: `${position.id}:normalization:${normalized.normalization.attempts}`, kind: 'normalization', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), symbol: positionSymbol(position, confirmation), targetSymbol: positionTargetSymbol(position, confirmation), status: 'SUCCESS', txHash: normalizationTx, at: now });
          }
        } else {
          position.updatedAt = now; position.lastAction = decision.action;
        }
        results.push({ positionId: position.id, ...decision, transactionHashes: hashes });
      } catch (error) {
        position.updatedAt = now;
        position.lastAction = 'pause';
        results.push({ positionId: position.id, action: 'pause', reason: errorMessage(error), transactionHashes: [] });
        if (position.closeReason) enqueue({ id: `${position.id}:close-failed:${Math.floor(now)}`, kind: 'close_failed', positionId: position.id, protocol: position.plan.pool.protocol, tokenId: position.tokenId.toString(), reason: position.closeReason, error: errorMessage(error), at: now });
      }
      state.transactions = state.transactions.slice(-5000);
      await this.repository.setStrategyState(state);
    }
    return results;
  }

  /** Execute one Telegram/manual position action through the existing signer boundary. */
  async executePositionAction(positionId: string, action: 'claim' | 'close' | 'autoswap') {
    if (!this.signer) throw new Error('SIGNER_NOT_CONFIGURED');
    const state = await this.repository.strategyState();
    const index = state.positions.findIndex(position => position.id === positionId || position.tokenId.toString() === positionId);
    if (index < 0) throw new Error('POSITION_NOT_FOUND');
    const position = state.positions[index]!;
    const controls = await this.repository.controls();
    if ((controls.botState ?? 'STOPPED') !== 'RUNNING') throw new Error('BOT_STOPPED_WRITE_DISABLED');
    if (action === 'claim' && position.status !== 'open') throw new Error('POSITION_NOT_OPEN');
    if ((action === 'close' || action === 'autoswap') && position.status !== 'open' && !(position.status === 'closed' && action === 'autoswap' && ['pending', 'failed'].includes(position.normalization.status))) {
      throw new Error('POSITION_NOT_OPEN');
    }
    await this.signer.health();
    if (action === 'claim') {
      const executed = await this.signer.claim(position);
      state.positions[index] = executed.value;
      state.transactions.push(...executed.transactions);
      state.transactions = state.transactions.slice(-5000);
      await this.repository.setStrategyState(state);
      return { position: executed.value, transactions: executed.transactions, normalized: false };
    }
    let current = position;
    let transactions = [] as Awaited<ReturnType<SignerClient['close']>>['transactions'];
    if (current.status === 'open') {
      const observation = await this.observePoolLightweight(current.pool);
      const preWriteControls = await this.repository.controls();
      if ((preWriteControls.botState ?? 'STOPPED') !== 'RUNNING') throw new Error('BOT_STOPPED_WRITE_DISABLED');
      await this.signer.health();
      const closeAttempt = { ...current, lastAction: 'close' as const, closeReason: 'MANUAL', updatedAt: Date.now() / 1000 };
      const executed = await this.signer.close(closeAttempt, observation, this.policy);
      current = executed.value;
      transactions = [...executed.transactions];
      state.positions[index] = current;
      state.transactions.push(...executed.transactions);
      await this.repository.setStrategyState(state);
    }
    if (action === 'close') return { position: current, transactions, normalized: false };
    const preNormalizeControls = await this.repository.controls();
    if ((preNormalizeControls.botState ?? 'STOPPED') !== 'RUNNING') throw new Error('BOT_STOPPED_WRITE_DISABLED');
    try {
      const normalized = await this.signer.normalize(current);
      state.positions[index] = normalized.value;
      state.transactions.push(...normalized.transactions);
      state.transactions = state.transactions.slice(-5000);
      await this.repository.setStrategyState(state);
      return { position: normalized.value, transactions: [...transactions, ...normalized.transactions], normalized: true };
    } catch (error) {
      const failed = { ...current, normalization: { ...current.normalization, status: 'failed' as const, attempts: current.normalization.attempts + 1, lastError: errorMessage(error) }, updatedAt: Date.now() / 1000 };
      state.positions[index] = failed;
      state.transactions = state.transactions.slice(-5000);
      await this.repository.setStrategyState(state);
      return { position: failed, transactions, normalized: false, normalizationError: errorMessage(error) };
    }
  }
  async replay(windows: Observation[][]) {
    let positions: PaperPosition[] = [];
    const runs: AgentRun[] = [];
    let previousEnd = -Infinity;
    for (const observations of windows) {
      if (!observations.length) throw new Error('EMPTY_REPLAY_WINDOW');
      const now = Math.max(...observations.map(o => o.windowEnd));
      if (now <= previousEnd) throw new Error('NON_MONOTONIC_REPLAY');
      previousEnd = now;
      const run = await this.cycle({ mode: 'replay', observations, now, chains: [...new Set(observations.map(o => o.state.pool.chainId))], persist: false });
      positions = positions.map(p => {
        const observation = observations.find(o => poolIdentity(o.state.pool) === poolIdentity(p.plan.pool));
        if (!observation) {
          const paused = structuredClone(p);
          paused.events.push({ at: now, action: 'pause', reason: 'Position observation unavailable', netPnlUsd: paused.netPnlUsd });
          return paused;
        }
        return markPaperPosition(p, observation, this.policy, now);
      });
      if (!runs.length) for (const decision of run.decisions) if (decision.plan) positions.push(openPaperPosition(decision.plan, now));
      run.positions = structuredClone(positions);
      await this.repository.saveRun(run); runs.push(run);
    }
    return { runs, positions, netPnlUsd: positions.reduce((sum, p) => sum + p.netPnlUsd, 0),
      note: 'Synthetic/paper accounting. Fees use a TVL-share estimate; this is not a fill-accurate historical backtest.' };
  }
}
