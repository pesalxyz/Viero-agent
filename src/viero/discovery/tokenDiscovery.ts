/**
 * Token-discovery orchestrator.
 *
 * Polls GMGN Hot Search for each enabled chain on a 5-minute cadence,
 * caches/dedups results, and runs the per-token screener.
 *
 * Design rules:
 *   - Independent per-chain cadence; a failure in one chain never
 *     affects another.
 *   - Caches are bounded (LRU by `maxCachedTokens`) and TTL'd so
 *     a token that has dropped off Hot Search is forgotten eventually.
 *   - Re-screening is gated by per-token TTL — a token that is still
 *     listed across N fetches is screened at most once per TTL
 *     (unless material evidence changed).
 *   - If GMGN is unavailable or rate-limited, fail CLOSED for new
 *     entries: existing positions and management continue unaffected
 *     because they don't depend on this loop.
 */
import { type Address } from 'viem';
import { addressSchema, chainIdSchema, type ChainId } from '../domain.js';
import { type Gmgn, gmgnHotSearch, type GmgnHotSearchRow } from '../adapters/providers.js';
import { type PublicClients } from '../clients/publicClients.js';
import { TokenScreener, type TokenScreeningPolicy, type TokenScreeningVerdict, type TokenRejectionCode } from './tokenScreener.js';
import type { Risk } from '../domain.js';

export const DEFAULT_HOT_SEARCH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_HOT_SEARCH_LIMIT = 50;

export interface TokenDiscoveryConfig {
  hotSearchIntervalMs?: number;
  hotSearchLimit?: number;
  maxCachedTokens?: number;
  screenerPolicy: TokenScreeningPolicy;
  /** A single re-screening interval; a token listed across N consecutive fetches is screened at most once per TTL. */
  rescreenTtlMs?: number;
  /** Forget tokens that have disappeared from Hot Search after this TTL. */
  cacheTtlMs?: number;
  /** Routine token screening uses GMGN evidence only and performs no RPC calls. */
  gmgnOnly?: boolean;
  /** Resolve persisted control-plane chain selection for the background loop. */
  enabledChains?: () => Promise<readonly ChainId[]>;
  economicFilter?: { marketCapMin: number; volumeMin: number; ageMinSeconds: number; liquidityMin: number };
  blockedTokenRegistry?: () => Promise<ReadonlySet<string> | null>;
}

export const ROBINHOOD_ECONOMIC_FILTER = { marketCapMin: 1_000_000, volumeMin: 125_000, ageMinSeconds: 1_800, liquidityMin: 25_000 } as const;

export type TokenDiscoveryEntry = {
  chainId: ChainId;
  address: Address;
  symbol?: string;
  name?: string;
  /** Last-seen hot-search rank (lower is better). Undefined when first seen. */
  hotSearchRank?: number;
  /** Unix seconds when first added to the cache. */
  firstSeenAt: number;
  /** Unix seconds when last seen across fetches (including consecutive fetches). */
  lastSeenAt: number;
  /** Unix seconds of the most recent screening. */
  lastTokenScreenAt: number;
  /** Last verdict produced by the screener. */
  lastTokenScreenResult: TokenScreeningVerdict['status'];
  /** Most recent rejection code, if any. */
  rejectReason?: TokenRejectionCode;
  /** GMGN evidence retained for deterministic token ranking without a second provider call. */
  risk?: Risk;
  marketCapUsd?: number;
  volume1h?: number;
  liquidity?: number;
  /** Earliest Unix seconds the screener should re-run for this token. */
  nextEligibleScreenAt: number;
  /** Earliest time targeted pool discovery may consume this PASS again. */
  nextEligiblePoolDiscoveryAt: number;
};

export interface TokenDiscoveryTelemetry {
  /** Total number of GMGN requests issued (across all chains + retries). */
  gmgnRequests: number;
  /** Number of GMGN requests that ended in a rate-limit error. */
  gmgnRateLimitErrors: number;
  /** Tokens newly added to the cache (since process start). */
  tokenScreeningCount: number;
  /** PASS verdicts. */
  tokenPassCount: number;
  /** REJECT verdicts. */
  tokenRejectCount: number;
  /** RETRY_LATER verdicts. */
  tokenRetryLaterCount: number;
  /** Current size of the token cache. */
  cacheSize: number;
  /** Last successful fetch Unix seconds per chain (or undefined). */
  lastFetchAt: Partial<Record<ChainId, number>>;
}

export class TokenDiscovery {
  private readonly intervals: Partial<Record<ChainId, ReturnType<typeof setInterval>>> = {};
  private readonly inflight = new Map<ChainId, Promise<TokenDiscoveryCycleResult>>();
  private readonly cache = new Map<string, TokenDiscoveryEntry>();
  private readonly maxCachedTokens: number;
  private readonly hotSearchIntervalMs: number;
  private readonly hotSearchLimit: number;
  private readonly rescreenTtlMs: number;
  private readonly cacheTtlMs: number;
  private readonly gmgnOnly: boolean;
  private readonly telemetry: TokenDiscoveryTelemetry = {
    gmgnRequests: 0, gmgnRateLimitErrors: 0,
    tokenScreeningCount: 0, tokenPassCount: 0, tokenRejectCount: 0, tokenRetryLaterCount: 0,
    cacheSize: 0,
    lastFetchAt: {},
  };
  private readonly screener: TokenScreener;
  private officialStockTokenRegistry: ReadonlySet<string> | null;
  private readonly blockedTokenRegistry?: () => Promise<ReadonlySet<string> | null>;

  private cacheKey(chainId: ChainId, token: Address): string {
    return `${chainIdSchema.parse(chainId)}:${(token as string).toLowerCase()}`;
  }

  constructor(
    private readonly clients: PublicClients,
    private readonly gmgn: Gmgn,
    private readonly chains: readonly ChainId[],
    private readonly config: TokenDiscoveryConfig,
  ) {
    this.hotSearchIntervalMs = config.hotSearchIntervalMs ?? DEFAULT_HOT_SEARCH_INTERVAL_MS;
    this.hotSearchLimit = config.hotSearchLimit ?? DEFAULT_HOT_SEARCH_LIMIT;
    this.maxCachedTokens = config.maxCachedTokens ?? 5000;
    this.rescreenTtlMs = config.rescreenTtlMs ?? 10 * 60_000; // default: re-screen at most every 10 minutes
    this.cacheTtlMs = config.cacheTtlMs ?? 60 * 60_000;
    this.gmgnOnly = config.gmgnOnly ?? false;
    this.screener = new TokenScreener(config.screenerPolicy, { maxCachedTokens: this.maxCachedTokens });
    this.officialStockTokenRegistry = new Set();
    this.blockedTokenRegistry = config.blockedTokenRegistry;
  }

  /** Synchronous getter for telemetry. Safe to read from any thread. */
  getTelemetry(): Readonly<TokenDiscoveryTelemetry> {
    this.telemetry.cacheSize = this.cache.size;
    return this.telemetry;
  }

  getScreener(): TokenScreener { return this.screener; }

  /** All cached tokens. Used by tests + observability. */
  *entries(): IterableIterator<TokenDiscoveryEntry> {
    for (const entry of this.cache.values()) yield entry;
  }

  passed(chainId: ChainId, now = Date.now() / 1000): TokenDiscoveryEntry[] {
    return [...this.cache.values()]
      .filter(entry => entry.chainId === chainId && entry.lastTokenScreenResult === 'PASS' && entry.nextEligiblePoolDiscoveryAt <= now)
      .sort((a, b) => (a.hotSearchRank ?? Number.MAX_SAFE_INTEGER) - (b.hotSearchRank ?? Number.MAX_SAFE_INTEGER)
        || b.lastSeenAt - a.lastSeenAt || a.address.localeCompare(b.address));
  }

  deferPoolDiscovery(entry: TokenDiscoveryEntry, until: number): void {
    const cached = this.cache.get(this.cacheKey(entry.chainId, entry.address));
    if (cached) cached.nextEligiblePoolDiscoveryAt = Math.max(cached.nextEligiblePoolDiscoveryAt, until);
  }

  /** Start the polling loop. Safe to call multiple times — subsequent calls are no-ops. */
  start(): void {
    void this.startConfigured();
  }

  private async startConfigured(): Promise<void> {
    const configured = this.config.enabledChains ? await this.config.enabledChains() : this.chains;
    const allowed = new Set(configured);
    for (const chainId of this.chains.filter(chain => allowed.has(chain))) {
      if (this.intervals[chainId]) continue;
      // Kick off immediately, then on interval.
      void this.fetchAndScreenOnce(chainId);
      this.intervals[chainId] = setInterval(() => {
        void this.fetchAndScreenOnce(chainId);
      }, this.hotSearchIntervalMs);
    }
  }

  /** Stop the polling loop. Safe to call when not running. */
  stop(): void {
    for (const [chainId, handle] of Object.entries(this.intervals)) {
      if (handle) clearInterval(handle);
      delete this.intervals[Number(chainId) as ChainId];
    }
  }

  /**
   * One full fetch + screen cycle. Public for tests.
   * Returns the number of NEW passes (existed nowhere else before this
   * cycle) and the number of rate-limit errors encountered.
   */
  fetchAndScreenOnce(chainId: ChainId, now = Date.now() / 1000): Promise<TokenDiscoveryCycleResult> {
    const existing = this.inflight.get(chainId);
    if (existing) return existing;
    const task = this.fetchAndScreenFresh(chainId, now).finally(() => this.inflight.delete(chainId));
    this.inflight.set(chainId, task);
    return task;
  }

  private async fetchAndScreenFresh(chainId: ChainId, now: number): Promise<TokenDiscoveryCycleResult> {
    this.telemetry.gmgnRequests++;
    let rows: GmgnHotSearchRow[];
    try {
      rows = await gmgnHotSearch(chainId, this.gmgn, '1h', chainId === 4663 ? Math.min(100, this.hotSearchLimit * 2) : this.hotSearchLimit);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (/rate.?limit|429/i.test(message)) this.telemetry.gmgnRateLimitErrors++;
      const rateLimitErrors = /rate.?limit|429/i.test(message) ? 1 : 0;
      console.error(`[viero.token-discovery] chain=${chainId} ok=false discovered=0 new=0 screened=0 pass=0 reject=0 retry_later=0 rate_limit_errors=${rateLimitErrors}`);
      return { ok: false, rawFetched: 0, stockFiltered: 0, discovered: 0, economicFiltered: 0, economicFilterDetails: [], newTokens: 0, screened: 0, pass: 0, reject: 0, retryLater: 0, rateLimitErrors };
    }
    this.telemetry.lastFetchAt[chainId] = now;

    for (const [key, entry] of this.cache) {
      if (entry.chainId === chainId && now - entry.lastSeenAt >= this.cacheTtlMs / 1000) this.cache.delete(key);
    }

    const rawFetched = rows.length;
    if (chainId === 4663 && this.blockedTokenRegistry) {
      this.officialStockTokenRegistry = await this.blockedTokenRegistry();
    }
    if (chainId === 4663 && this.officialStockTokenRegistry === null) {
      console.error('[viero.block-filter] registry_unavailable=true reason=BLOCKED_TOKEN_REGISTRY_UNAVAILABLE');
      return { ok: false, rawFetched, stockFiltered: 0, discovered: 0, economicFiltered: 0, economicFilterDetails: [], newTokens: 0, screened: 0, pass: 0, reject: 0, retryLater: 0, rateLimitErrors: 0, registryUnavailable: true };
    }
    let stockFiltered = 0;
    const stockRegistry = chainId === 4663 ? (this.officialStockTokenRegistry ?? new Set<string>()) : new Set<string>();
    const nonStockRows: GmgnHotSearchRow[] = [];
    for (const row of rows) {
      try {
        const address = addressSchema.parse(row.address).toLowerCase();
        if (stockRegistry.has(address)) { stockFiltered++; console.error(`[viero.block-filter] symbol=${row.symbol ?? 'unknown'} address=${address.slice(0, 8)}… reason=MANUAL_BLOCK`); continue; }
      } catch { /* malformed rows are handled by normal validation below */ }
      // Continue scanning the bounded raw response so stock_filtered counts
      // remain accurate even when the non-stock quota is already filled.
      if (nonStockRows.length < this.hotSearchLimit) nonStockRows.push(row);
    }
    rows = nonStockRows;
    console.error(`[viero.block-filter] raw_fetched=${rawFetched} blocked_filtered=${stockFiltered} discovered=${rows.length}`);
    let newTokens = 0, economicFiltered = 0;
    const economicFilterDetails: TokenDiscoveryCycleResult['economicFilterDetails'] = [];
    let screened = 0;
    const securityDecisions: NonNullable<TokenDiscoveryCycleResult['securityDecisions']> = [];
    let pass = 0, reject = 0, retryLater = 0;
    const rejectionCounts = new Map<string, number>();
    // Robinhood and BNB share the same deterministic discovery economics.
    // Other chains retain their chain-specific discovery behavior until they
    // receive an explicit economic policy.
    const economic = chainId === 4663 || chainId === 56
      ? (this.config.economicFilter ?? ROBINHOOD_ECONOMIC_FILTER)
      : null;
    for (const row of rows) {
      // Defensive address parse — GMGN occasionally returns malformed rows.
      let address: Address;
      try { address = addressSchema.parse(row.address); } catch { continue; }
      if (economic) {
        const number = (value: number | string | null | undefined) => value === null || value === undefined ? NaN : typeof value === 'number' ? value : Number(value);
        const checks: Array<[string, number, number]> = [
          ['MARKET_CAP_TOO_LOW', number(row.market_cap), economic.marketCapMin],
          ['VOLUME_1H_TOO_LOW', number(row.volume), economic.volumeMin],
          ['TOKEN_TOO_YOUNG', now - number(row.creation_timestamp), economic.ageMinSeconds],
          ['LIQUIDITY_TOO_LOW', number(row.liquidity), economic.liquidityMin],
        ];
        const failed = checks.filter(([, value, threshold]) => !Number.isFinite(value) || value < threshold);
        if (failed.length) {
          // A token that was previously a PASS may fall below the economic
          // floor on a later Hot Search fetch. Remove that cached entry so an
          // old PASS cannot leak into Stage-1 ranking or pool discovery.
          this.cache.delete(this.cacheKey(chainId, address));
          economicFiltered++;
          const reasons = failed.map(([reason]) => reason);
          for (const reason of reasons) rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
          const detail = { symbol: row.symbol, address, marketCap: Number.isFinite(checks[0]![1]) ? checks[0]![1] : null, volume1h: Number.isFinite(checks[1]![1]) ? checks[1]![1] : null, liquidity: Number.isFinite(checks[3]![1]) ? checks[3]![1] : null, ageSeconds: Number.isFinite(checks[2]![1]) ? checks[2]![1] : null, reasons };
          economicFilterDetails.push(detail);
          console.error(`[viero.economic-filter] symbol=${row.symbol ?? 'unknown'} address=${address.slice(0, 8)}… market_cap=${detail.marketCap?.toFixed(2) ?? 'null'} volume_1h=${detail.volume1h?.toFixed(2) ?? 'null'} liquidity=${detail.liquidity?.toFixed(2) ?? 'null'} age_seconds=${detail.ageSeconds?.toFixed(0) ?? 'null'} reasons=${reasons.join(',')}`);
          continue;
        }
      }
      const key = this.cacheKey(chainId, address);
      const existing = this.cache.get(key);
      const marketCap = row.market_cap == null ? undefined : Number(row.market_cap);
      const marketCapUsd = marketCap !== undefined && Number.isFinite(marketCap) && marketCap > 0 ? marketCap : undefined;
      if (!existing) {
        const entry: TokenDiscoveryEntry = {
          chainId, address,
          symbol: row.symbol, name: row.name,
          marketCapUsd,
          volume1h: typeof row.volume === 'number' ? row.volume : row.volume == null ? undefined : Number(row.volume),
          liquidity: typeof row.liquidity === 'number' ? row.liquidity : row.liquidity == null ? undefined : Number(row.liquidity),
          hotSearchRank: row.rank,
          firstSeenAt: now, lastSeenAt: now,
          lastTokenScreenAt: 0,
          lastTokenScreenResult: 'RETRY_LATER',
          nextEligibleScreenAt: now, // screen immediately on first sight
          nextEligiblePoolDiscoveryAt: now,
        };
        this.insertWithCap(key, entry);
        newTokens++;
      } else {
        existing.lastSeenAt = now;
        // Update hot-search rank if provided.
        if (row.rank !== undefined) existing.hotSearchRank = row.rank;
        if (row.symbol) existing.symbol = row.symbol;
        if (row.name) existing.name = row.name;
        if (marketCapUsd !== undefined) existing.marketCapUsd = marketCapUsd;
        if (row.volume !== undefined && row.volume !== null) existing.volume1h = Number(row.volume);
        if (row.liquidity !== undefined && row.liquidity !== null) existing.liquidity = Number(row.liquidity);
      }
    }
    this.telemetry.cacheSize = this.cache.size;

    // Now screen eligible tokens.
    const client = this.gmgnOnly ? null : this.clients.get(chainId);
    for (const entry of [...this.cache.values()]) {
      if (entry.chainId !== chainId) continue;
      if (entry.lastTokenScreenResult === 'PASS' && entry.nextEligibleScreenAt > now) continue;
      if (entry.nextEligibleScreenAt > now) continue;
      const verdict = this.gmgnOnly
        ? await this.screener.screenGmgnOnly(chainId, entry.address, this.gmgn, now)
        : await this.screener.screen(chainId, entry.address, { client: client!, gmgn: this.gmgn }, undefined, now);
      this.telemetry.tokenScreeningCount++;
      entry.lastTokenScreenAt = now;
      entry.lastTokenScreenResult = verdict.status;
      entry.rejectReason = verdict.rejection?.code;
      entry.risk = verdict.evidence?.gmgn;
      if (verdict.rejection?.code) rejectionCounts.set(verdict.rejection.code, (rejectionCounts.get(verdict.rejection.code) ?? 0) + 1);
      entry.nextEligibleScreenAt = now + this.rescreenTtlMs / 1000;
      securityDecisions.push({ symbol: entry.symbol, address: entry.address, hotSearchRank: entry.hotSearchRank, criticalAdmin: verdict.evidence?.gmgn?.criticalAdmin, honeypot: verdict.evidence?.gmgn?.honeypot, sellTaxBps: verdict.evidence?.gmgn?.sellTaxBps, top10HolderPct: verdict.evidence?.gmgn?.top10HolderPct, verdict: verdict.status, rejectionCode: verdict.rejection?.code, rejectionDetail: verdict.rejection?.detail });
      if (verdict.status === 'PASS') { this.telemetry.tokenPassCount++; pass++; }
      else if (verdict.status === 'REJECT') { this.telemetry.tokenRejectCount++; reject++; }
      else { this.telemetry.tokenRetryLaterCount++; retryLater++; }
      screened++;
      // LRU eviction (cheap re-sort; cache is bounded)
      while (this.cache.size > this.maxCachedTokens) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    const reasons = [...rejectionCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code}:${count}`).join(',') || 'none';
    console.error(`[viero.token-discovery] chain=${chainId} ok=true discovered=${rows.length} stock_filtered=${stockFiltered} economic_filtered=${economicFiltered} security_screened=${screened} new=${newTokens} pass=${pass} reject=${reject} retry_later=${retryLater} rate_limit_errors=0 reasons=${reasons}`);
    return { ok: true, rawFetched, stockFiltered, discovered: rows.length, economicFiltered, economicFilterDetails, newTokens, screened, pass, reject, retryLater, rateLimitErrors: 0, securityDecisions };
  }

  private insertWithCap(key: string, entry: TokenDiscoveryEntry): void {
    this.cache.set(key, entry);
    while (this.cache.size > this.maxCachedTokens) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export type TokenDiscoveryCycleResult = {
  ok: boolean;
  rawFetched: number;
  stockFiltered: number;
  discovered: number;
  economicFiltered: number;
  economicFilterDetails: Array<{ symbol?: string; address: Address; marketCap: number | null; volume1h: number | null; liquidity: number | null; ageSeconds: number | null; reasons: string[] }>;
  newTokens: number;
  screened: number;
  pass: number;
  reject: number;
  retryLater: number;
  rateLimitErrors: number;
  registryUnavailable?: boolean;
  securityDecisions?: Array<{ symbol?: string; address: Address; hotSearchRank?: number; criticalAdmin?: boolean | null; honeypot?: boolean | null; sellTaxBps?: number | null; top10HolderPct?: number | null; verdict: TokenScreeningVerdict['status']; rejectionCode?: string; rejectionDetail?: string }>;
};
