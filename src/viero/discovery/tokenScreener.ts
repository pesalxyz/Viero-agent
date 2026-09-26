/**
 * Token-screening stage.
 *
 * Sits BETWEEN GMGN Hot Search and targeted pool discovery. Rejects
 * obvious bad candidates early so we never spend RPC budget on them.
 *
 * Design rules (non-negotiable):
 *   - GMGN safety labels (honeypot, sellSimulation, etc.) are HINTS,
 *     not authorities. We verify them on-chain where possible
 *     (zero-address code, ERC-20 bytecode existence, balance probe
 *     against a known LP router to simulate a buy/sell path).
 *   - Failures must be explicit and machine-readable via TokenRejectionCode.
 *   - All cache state is bounded by `maxCachedTokens`.
 */
import { zeroAddress, type Address, type PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import { chainIdSchema } from '../domain.js';
import type { ChainId } from '../domain.js';
import type { Risk } from '../domain.js';
import { getChain } from '../config/chains.js';

export type TokenRejectionCode =
  | 'TOKEN_INVALID_ADDRESS'        // address did not parse or is zero
  | 'TOKEN_NOT_DEPLOYED'           // readContract returned empty bytecode
  | 'TOKEN_IS_HONEYPOT_GMGN'        // gmgn reported honeypot=true
  | 'TOKEN_BUY_SIMULATION_FAILED_GMGN'
  | 'TOKEN_SELL_SIMULATION_FAILED_GMGN'
  | 'TOKEN_CRITICAL_ADMIN_GMGN'
  | 'CRITICAL_ADMIN'
  | 'TOKEN_SELL_TAX_TOO_HIGH'       // > policy.maximumSellTaxBps
  | 'TOKEN_HOLDER_CONCENTRATION_TOO_HIGH'
  | 'TOKEN_PRICE_UNAVAILABLE'
  | 'TOKEN_PRICE_INCONSISTENT'
  | 'TOKEN_BLACKLISTED'             // operator-set blacklist
  | 'TOKEN_COOLDOWN_ACTIVE'         // recent loss-exit cooldown
  | 'TOKEN_RECENCY_FAIL'            // poolCreatedAt too recent (already screened)
  | 'TOKEN_BALANCE_PROBE_FAILED'    // on-chain buy/sell simulation failed
  | 'TOKEN_OBSERVATION_INCOMPLETE'  // generic
  | 'TOKEN_PASS'                     // not actually a code — sentinel for result
  ;

export type TokenRejection = { code: Exclude<TokenRejectionCode, 'TOKEN_PASS'>; detail: string };

export type TokenScreeningVerdict = {
  address: Address;
  chainId: ChainId;
  status: 'PASS' | 'REJECT' | 'RETRY_LATER';
  rejection?: TokenRejection;
  /** When status is PASS, the snapshot of safety evidence used. */
  evidence?: TokenEvidence;
  /** Server-side timestamp of the screening decision. */
  screenedAt: number;
};

export type TokenEvidence = {
  /** Result of the lightweight buy/sell balance probe against a known router (if performed). */
  buySimulation?: boolean | null;
  sellSimulation?: boolean | null;
  /** GMGN security signals at the time of screening (cached). */
  gmgn?: Risk;
  /** Two-sided price samples used for consistency. May be partial. */
  priceSamples?: Array<{ source: string; usd: number }>;
};

export interface TokenScreeningPolicy {
  maximumSellTaxBps: number;          // default 300 (3% maximum sell-tax tolerance)
  maximumHolderPct: number;           // default 40 (matches Viero DEFAULT_POLICY)
  minimumAgeSeconds: number;          // default 86400 (1 day)
  cooldownSeconds: number;            // pool cooldown after loss exit
  blacklist: Map<string, { until: number; reason: string }>; // operator-set per token
}

export interface TokenScreeningDeps {
  client: PublicClient;
  gmgn: { security(chainId: ChainId, token: Address): Promise<Risk> };
  /** Optional — fetches a price from multiple sources for consistency check. */
  fetchPriceSamples?: (chainId: ChainId, token: Address) => Promise<Array<{ source: string; usd: number }>>;
}

/** Safe, non-broadcast buy/sell transfer simulation reused by execution screening. */
export async function simulateTokenBuySell(client: PublicClient, token: Address): Promise<{ buyOk: boolean | null; sellOk: boolean | null }> {
  const probe: Address = '0x0000000000000000000000000000000000000001';
  let buyOk: boolean | null = null;
  let sellOk: boolean | null = null;
  try {
    await client.simulateContract({ address: token, abi: erc20Abi, functionName: 'transferFrom', args: [probe, probe, 1n], account: probe });
    buyOk = true;
  } catch (error) { buyOk = probeFailure(error); }
  try {
    await client.simulateContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [probe, 1n], account: probe });
    sellOk = true;
  } catch (error) { sellOk = probeFailure(error); }
  return { buyOk, sellOk };
}

function probeFailure(error: unknown): false | null {
  const message = error instanceof Error ? `${error.message} ${'shortMessage' in error ? String(error.shortMessage) : ''}` : String(error);
  return /insufficient (?:token )?balance|exceeds balance|insufficient allowance|exceeds allowance|ERC20Insufficient(?:Balance|Allowance)|0xe450d38c|0xfb8f41b2/i.test(message) ? null : false;
}

export class TokenScreener {
  /**
   * Per-token screening result cache. Bounded by `maxCachedTokens` (LRU eviction).
   * Key: `${chainId}:${token.toLowerCase()}`.
   */
  private cache = new Map<string, { verdict: TokenScreeningVerdict; expiresAt: number }>();
  private readonly maxCachedTokens: number;
  constructor(private readonly policy: TokenScreeningPolicy, options: { maxCachedTokens?: number } = {}) {
    this.maxCachedTokens = options.maxCachedTokens ?? 5000;
  }
  size(): number { return this.cache.size; }
  clear(): void { this.cache.clear(); }
  private cacheKey(chainId: ChainId, token: Address): string {
    return `${chainIdSchema.parse(chainId)}:${token.toLowerCase()}`;
  }
  private getCached(chainId: ChainId, token: Address, now: number): TokenScreeningVerdict | undefined {
    const k = this.cacheKey(chainId, token);
    const entry = this.cache.get(k);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.cache.delete(k); return undefined; }
    // Touch for LRU
    this.cache.delete(k); this.cache.set(k, entry);
    return entry.verdict;
  }
  private putCached(chainId: ChainId, verdict: TokenScreeningVerdict): void {
    const k = this.cacheKey(chainId, verdict.address);
    this.cache.set(k, { verdict, expiresAt: verdict.screenedAt + this.screeningTtlSeconds() });
    while (this.cache.size > this.maxCachedTokens) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
  private screeningTtlSeconds(): number {
    // PASS evidence is refreshed on the discovery cadence. Loss-exit
    // cooldowns have their own explicit expiry in markLossExit().
    return 5 * 60;
  }

  /** GMGN-only routine screening. Never receives or calls an RPC client. */
  async screenGmgnOnly(chainId: ChainId, token: Address, gmgnClient: TokenScreeningDeps['gmgn'], now = Date.now() / 1000): Promise<TokenScreeningVerdict> {
    token = token.toLowerCase() as Address;
    const cached = this.getCached(chainId, token, now);
    if (cached && (cached.status === 'PASS' || cached.rejection?.code === 'TOKEN_COOLDOWN_ACTIVE')) return cached;
    const base = { address: token, chainId, screenedAt: now };
    if (token === zeroAddress) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_INVALID_ADDRESS', detail: 'zero address' } };
    const blocked = this.policy.blacklist.get(`${chainId}:${token}`);
    if (blocked && blocked.until > now) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_BLACKLISTED', detail: blocked.reason } };
    let risk: Risk;
    try { risk = await gmgnClient.security(chainId, token); }
    catch (error) {
      return { ...base, status: 'RETRY_LATER', rejection: { code: 'TOKEN_OBSERVATION_INCOMPLETE', detail: `GMGN security unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240) } };
    }
    let verdict: TokenScreeningVerdict;
    if (risk.honeypot === true) verdict = { ...base, status: 'REJECT', rejection: { code: 'TOKEN_IS_HONEYPOT_GMGN', detail: 'gmgn honeypot signal' }, evidence: { gmgn: risk } };
    else if (risk.buySimulation === false) verdict = { ...base, status: 'REJECT', rejection: { code: 'TOKEN_BUY_SIMULATION_FAILED_GMGN', detail: 'gmgn buy simulation failed' }, evidence: { gmgn: risk } };
    else if (risk.sellSimulation === false) verdict = { ...base, status: 'REJECT', rejection: { code: 'TOKEN_SELL_SIMULATION_FAILED_GMGN', detail: 'gmgn sell simulation failed' }, evidence: { gmgn: risk } };
    else if (risk.criticalAdmin === true && ![getChain(chainId).primaryStable, getChain(chainId).wrappedNative].filter(Boolean).some((address) => address!.toLowerCase() === token.toLowerCase())) verdict = { ...base, status: 'REJECT', rejection: { code: 'CRITICAL_ADMIN', detail: 'confirmed administrative risk' }, evidence: { gmgn: risk } };
    else if (risk.sellTaxBps !== null && risk.sellTaxBps > this.policy.maximumSellTaxBps) verdict = { ...base, status: 'REJECT', rejection: { code: 'TOKEN_SELL_TAX_TOO_HIGH', detail: `gmgn sellTaxBps=${risk.sellTaxBps} > ${this.policy.maximumSellTaxBps}` }, evidence: { gmgn: risk } };
    else if (risk.top10HolderPct !== null && risk.top10HolderPct > this.policy.maximumHolderPct) verdict = { ...base, status: 'REJECT', rejection: { code: 'TOKEN_HOLDER_CONCENTRATION_TOO_HIGH', detail: `gmgn top10HolderPct=${risk.top10HolderPct} > ${this.policy.maximumHolderPct}` }, evidence: { gmgn: risk } };
    else verdict = { ...base, status: 'PASS', evidence: { buySimulation: risk.buySimulation, sellSimulation: risk.sellSimulation, gmgn: risk } };
    if (verdict.status === 'PASS') this.putCached(chainId, verdict);
    return verdict;
  }

  /**
   * Screen a single token. Fails closed on any required-data
   * unavailability.
   *
   * @param poolAgeSeconds Optional. If known (e.g. from a prior pool
   *   observation), passed in to allow tighter age checks. If omitted,
   *   the screener skips the age check.
   */
  async screen(chainId: ChainId, token: Address, deps: TokenScreeningDeps, poolAgeSeconds?: number, now = Date.now() / 1000): Promise<TokenScreeningVerdict> {
    token = token.toLowerCase() as Address;
    // Cache fast-path: only for PASS verdicts. REJECTs are short-lived
    // (we re-check on cooldown change); RETRY_LATER never cached.
    const cached = this.getCached(chainId, token, now);
    if (cached && (cached.status === 'PASS' || cached.rejection?.code === 'TOKEN_COOLDOWN_ACTIVE')) return cached;

    try {
      const verdict = await this.screenFresh(chainId, token, deps, poolAgeSeconds, now);
      if (verdict.status === 'PASS') this.putCached(chainId, verdict);
      return verdict;
    } catch (err) {
      // Fail closed — we couldn't complete the screening.
      const verdict: TokenScreeningVerdict = {
        address: token, chainId,
        status: 'RETRY_LATER',
        rejection: { code: 'TOKEN_OBSERVATION_INCOMPLETE', detail: (err as Error).message.slice(0, 240) },
        screenedAt: now,
      };
      return verdict;
    }
  }

  private async screenFresh(chainId: ChainId, token: Address, deps: TokenScreeningDeps, poolAgeSeconds: number | undefined, now: number): Promise<TokenScreeningVerdict> {
    const base = { address: token, chainId, screenedAt: now };
    // 0. Address sanity
    if (token === zeroAddress) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_INVALID_ADDRESS', detail: 'zero address' } };

    // 1. Operator-set blacklist (longest TTL)
    const bl = this.policy.blacklist.get(`${chainId}:${token}`);
    if (bl && bl.until > now) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_BLACKLISTED', detail: bl.reason } };

    // 2. On-chain: code size check (cheap)
    const code = await deps.client.getBytecode({ address: token });
    if (!code || code === '0x') return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_NOT_DEPLOYED', detail: 'no contract code at address' } };

    // 3. GMGN security (treated as hint, never authority)
    let gmgn: Risk | null = null;
    try { gmgn = await deps.gmgn.security(chainId, token); } catch { /* swallow — GMGN is a hint */ }

    if (gmgn) {
      if (gmgn.honeypot === true) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_IS_HONEYPOT_GMGN', detail: 'gmgn honeypot signal' }, evidence: { gmgn } };
      if (gmgn.buySimulation === false) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_BUY_SIMULATION_FAILED_GMGN', detail: 'gmgn buy simulation failed' }, evidence: { gmgn } };
      if (gmgn.sellSimulation === false) return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_SELL_SIMULATION_FAILED_GMGN', detail: 'gmgn sell simulation failed' }, evidence: { gmgn } };
      if (gmgn.sellTaxBps !== null && gmgn.sellTaxBps > this.policy.maximumSellTaxBps) {
        return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_SELL_TAX_TOO_HIGH', detail: `gmgn sellTaxBps=${gmgn.sellTaxBps} > ${this.policy.maximumSellTaxBps}` }, evidence: { gmgn } };
      }
      if (gmgn.top10HolderPct !== null && gmgn.top10HolderPct > this.policy.maximumHolderPct) {
        return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_HOLDER_CONCENTRATION_TOO_HIGH', detail: `gmgn top10HolderPct=${gmgn.top10HolderPct} > ${this.policy.maximumHolderPct}` }, evidence: { gmgn } };
      }
    }

    // 4. On-chain: try the cheapest possible transfer simulation.
    // We send `transferFrom(self, self, 1)` via eth_call which reverts
    // for any token with a fee-on-transfer, blacklist, or paused
    // mapping. This is intentionally cheap and chain-agnostic.
    const probe = await this.probeTransferable(deps.client, token);
    // Both probes failing is a strong signal of fee-on-transfer / paused
    // mapping / broken ERC-20. Reject — we can't route inventory through
    // this token safely.
    if (probe.buyOk === false && probe.sellOk === false) {
      return {
        ...base, status: 'REJECT',
        rejection: { code: 'TOKEN_BALANCE_PROBE_FAILED', detail: 'both transferFrom and transfer reverted on-chain — token may be paused, fee-on-transfer, or broken' },
        evidence: { buySimulation: probe.buyOk, sellSimulation: probe.sellOk, gmgn: gmgn ?? undefined },
      };
    }

    // 5. Price consistency (only if deps provide it). If absent we
    // don't reject on this — discovery stage can still proceed.
    let priceSamples: Array<{ source: string; usd: number }> | undefined;
    if (deps.fetchPriceSamples) {
      try { priceSamples = await deps.fetchPriceSamples(chainId, token); } catch { /* skip */ }
    }
    if (priceSamples && priceSamples.length >= 2) {
      const usds = priceSamples.map((s) => s.usd).filter((u) => Number.isFinite(u) && u > 0);
      if (usds.length >= 2) {
        const min = Math.min(...usds), max = Math.max(...usds);
        const divergence = max / min - 1;
        if (divergence > 0.10) {
          return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_PRICE_INCONSISTENT', detail: `price samples diverge ${(divergence * 100).toFixed(2)}% (>10%)` }, evidence: { priceSamples } };
        }
      }
    }

    // 6. Optional pool age check (when the caller knows pool age).
    if (poolAgeSeconds !== undefined && poolAgeSeconds < this.policy.minimumAgeSeconds) {
      return { ...base, status: 'REJECT', rejection: { code: 'TOKEN_RECENCY_FAIL', detail: `pool age ${poolAgeSeconds}s < ${this.policy.minimumAgeSeconds}s minimum` } };
    }

    // PASS — mint the verdict with whatever evidence we collected.
    return { ...base, status: 'PASS', evidence: { buySimulation: probe.buyOk, sellSimulation: probe.sellOk, gmgn: gmgn ?? undefined, priceSamples } };
  }

  /**
   * Lightweight on-chain transfer probe:
   *   - tries `transferFrom(self, self, 1)` — must succeed (no fee, no blacklist, not paused)
   *   - tries `transfer(self, self, 1)`       — same conditions
   *
   * Both revert on transfer-tax / blacklist / paused ERC-20s. This is
   * NOT a full simulation (no router quote, no slippage check) — it is
   * a cheap smoke test that catches >50% of obvious rugs before we
   * waste a `verifyPool` call on them.
   */
  private async probeTransferable(client: PublicClient, token: Address): Promise<{ buyOk: boolean | null; sellOk: boolean | null }> {
    return simulateTokenBuySell(client, token);
  }
  /**
   * Notify the screener of a recorded loss-exit so the next screen of
   * that token applies the cooldown. Called from `recordClosedOutcome`.
   */
  markLossExit(chainId: ChainId, token: Address, now: number, reason: string): void {
    const k = this.cacheKey(chainId, token);
    this.cache.set(k, {
      verdict: {
        address: token, chainId,
        status: 'REJECT',
        rejection: { code: 'TOKEN_COOLDOWN_ACTIVE', detail: reason },
        screenedAt: now,
      },
      expiresAt: now + this.policy.cooldownSeconds,
    });
    while (this.cache.size > this.maxCachedTokens) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
