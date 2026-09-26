import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { type Address, zeroAddress } from 'viem';
import { getChain, sourceSlug } from '../config/chains.js';
import { addressSchema, chainIdSchema, errorMessage, poolSchema, priceSchema, riskSchema, type ChainId, type PoolRef, type Price, type Risk } from '../domain.js';

export type ProviderHealth = { chainId: ChainId; provider: string; consecutiveFailures: number; lastSuccessAt?: number; latencyMs: number; error?: string; retryAt?: number };
export type ProviderObservation = { chainId: ChainId; provider: string; fetchedAt: number; payload: unknown };
export class Providers {
  readonly health = new Map<string, ProviderHealth>();
  readonly observations: ProviderObservation[] = [];
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly observationLimit = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(observationLimit) && observationLimit !== Number.POSITIVE_INFINITY) throw new Error('INVALID_OBSERVATION_LIMIT');
    if (observationLimit < 0) throw new Error('INVALID_OBSERVATION_LIMIT');
  }
  async run<T>(chainId: ChainId, provider: string, requestKey: string, operation: () => Promise<T>): Promise<T> {
    chainIdSchema.parse(chainId);
    const key = `${chainId}:${provider}`, request = `${key}:${requestKey}`;
    const existing = this.inflight.get(request);
    if (existing) return existing as Promise<T>;
    const prior = this.health.get(key);
    if (prior?.retryAt && Date.now() < prior.retryAt) throw new Error(`${provider}: backoff active`);
    const task = (async () => {
      const started = Date.now();
      try {
        const result = await operation();
        if (this.observationLimit > 0) {
          this.observations.push({ chainId, provider, fetchedAt: Date.now() / 1000, payload: result });
          if (this.observations.length > this.observationLimit) {
            this.observations.splice(0, this.observations.length - this.observationLimit);
          }
        }
        this.health.set(key, { chainId, provider, consecutiveFailures: 0, latencyMs: Date.now() - started, lastSuccessAt: Date.now() / 1000 });
        return result;
      } catch (error) {
        const failures = (prior?.consecutiveFailures ?? 0) + 1;
        this.health.set(key, { chainId, provider, consecutiveFailures: failures, lastSuccessAt: prior?.lastSuccessAt,
          latencyMs: Date.now() - started, error: errorMessage(error), retryAt: Date.now() + Math.min(60000, 1000 * 2 ** failures) });
        throw error;
      } finally { this.inflight.delete(request); }
    })();
    this.inflight.set(request, task);
    return task;
  }
  async json(chainId: ChainId, provider: string, url: string, init: RequestInit = {}): Promise<unknown> {
    return this.run(chainId, provider, `${url}:${init.body ?? ''}`, async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`${provider}: HTTP ${response.status}`);
      return response.json();
    });
  }
}
export const trendingWindow = z.enum(['1m', '5m', '1h', '6h', '24h']);
const runFile = promisify(execFile);
export class Gmgn {
  private rateQueue: Promise<void> = Promise.resolve();
  private nextCallAt = 0;
  constructor(private providers: Providers, private executable = process.env.VIERO_GMGN_BIN || 'gmgn-cli') {}
  private async waitForRateSlot() {
    let release!: () => void;
    const previous = this.rateQueue;
    this.rateQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextCallAt - Date.now());
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.nextCallAt = Date.now() + 1_500;
    } finally {
      release();
    }
  }
  private async call(args: string[], chainId: ChainId, cacheKey: string) {
    return this.providers.run(chainId, 'gmgn', cacheKey, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.waitForRateSlot();
          const { stdout } = await runFile(this.executable, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', shell: false });
          const payload: unknown = JSON.parse(stdout);
          if (payload && typeof payload === 'object' && 'code' in payload && ![0, '0'].includes((payload as { code: string | number }).code)) throw new Error('GMGN returned unsuccessful response');
          return payload;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') throw new Error('GMGN CLI unavailable');
          if (attempt === 2) throw new Error('GMGN query failed; check CLI installation, quota, and GMGN_API_KEY');
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      throw new Error('GMGN query failed');
    });
  }
  async query(chainId: ChainId, command: 'trending' | 'info' | 'security' | 'holders' | 'pool' | 'hotsearch', options: { token?: Address; interval?: z.infer<typeof trendingWindow>; limit?: number } = {}) {
    const chain = sourceSlug(chainId, 'gmgn');
    let args: string[];
    switch (command) {
      case 'trending':
        args = ['market', 'trending', '--chain', chain, '--interval', trendingWindow.parse(options.interval ?? '1h'), '--limit', String(z.number().int().min(1).max(100).parse(options.limit ?? 10)), '--raw'];
        break;
      case 'hotsearch':
        // gmgn-cli 1.6.x names this command `hot-searches` and returns
        // one chain envelope containing a `tokens` array.
        args = ['market', 'hot-searches', '--chain', chain, '--interval', trendingWindow.parse(options.interval ?? '1h'), '--limit', String(z.number().int().min(1).max(100).parse(options.limit ?? 50)), '--raw'];
        break;
      case 'info':
      case 'security':
      case 'holders':
      case 'pool':
        args = ['token', command, '--chain', chain, '--address', addressSchema.parse(options.token), '--raw'];
        break;
    }
    if (options.token === zeroAddress) throw new Error('GMGN_REQUIRES_ERC20_ADDRESS');
    return this.call(args, chainId, args.join(':'));
  }
  async trending(chainId: ChainId, interval: z.infer<typeof trendingWindow> = '1h', limit = 10): Promise<Address[]> {
    const payload = await this.query(chainId, 'trending', { interval, limit });
    const envelope = z.object({ data: z.unknown().optional() }).passthrough().safeParse(payload);
    const data = envelope.success && envelope.data.data !== undefined ? envelope.data.data : payload;
    const rows = Array.isArray(data) ? data : z.object({ rank: z.array(z.unknown()) }).parse(data).rank;
    return [...new Set(rows.map(row => z.object({ address: addressSchema }).passthrough().parse(row).address))];
  }
  async security(chainId: ChainId, token: Address): Promise<Risk> {
    return normalizeGmgnRisk(await this.query(chainId, 'security', { token }), chainId, token, Date.now() / 1000);
  }
  async price(chainId: ChainId, token: Address): Promise<Price> {
    return normalizeGmgnPrice(await this.query(chainId, 'info', { token }), chainId, token, Date.now() / 1000);
  }
  /**
   * Primary pool info for a token. Calls `gmgn-cli token pool --chain <slug> --address <token>`.
   * Returns raw GMGN JSON. Caller normalizes / type-checks. Returns null on
   * any failure or if GMGN reports no pool.
   */
  async poolInfo(chainId: ChainId, token: Address): Promise<unknown | null> {
    if (token === zeroAddress) return null;
    try {
      return await this.query(chainId, 'pool', { token });
    } catch {
      return null;
    }
  }
}

/**
 * Normalized pool-info response from `gmgn-cli token pool`. Used to build
 * a `PoolRef` from GMGN without an RPC factory query.
 *
 * GMGN's actual field names differ from the snake_case here; we accept
 * several variants for forward compatibility.
 */
const gmgnPoolInfoSchema = z.object({
  pool_address: z.string().optional(),
  address: z.string().optional(),
  exchange: z.string().optional(),
  quote_address: z.string().optional(),
  pair_label: z.string().optional(),
  token0_address: z.string().optional(),
  token1_address: z.string().optional(),
}).passthrough();
export type GmgnPoolInfo = z.infer<typeof gmgnPoolInfoSchema>;

/**
 * Resolve a `gmgn-cli token pool` response to a `PoolRef`. Returns null
 * if the pool address or exchange cannot be extracted, or if the exchange
 * is not a Viero-supported venue.
 */
export function gmgnPoolInfoToPoolRef(chainId: ChainId, info: GmgnPoolInfo): PoolRef | null {
  const address = info.pool_address ?? info.address;
  if (!address) return null;
  const addr = addressSchema.safeParse(address);
  if (!addr.success) return null;
  const exchange = (info.exchange ?? '').toLowerCase();
  const protocol: PoolRef['protocol'] = exchange.includes('v4') ? 'v4' : 'v3';
  const dex: PoolRef['dex'] = exchange.includes('pancake') ? 'pancakeswap' : 'uniswap';
  if (protocol === 'v4') {
    const token0 = info.token0_address ? addressSchema.safeParse(info.token0_address) : null;
    const token1 = info.token1_address ? addressSchema.safeParse(info.token1_address) : null;
    if (!token0?.success || !token1?.success) return null;
    return {
      chainId, protocol: 'v4', dex: 'uniswap',
      poolId: addr.data,
      poolKey: {
        currency0: token0.data, currency1: token1.data,
        fee: 0, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
      },
    };
  }
  return { chainId, protocol: 'v3', dex, poolAddress: addr.data };
}

/**
 * Hot search result row. Optional fields because the gmgn-cli payload
 * shape varies by chain and timeframe.
 */
export const gmgnHotSearchRowSchema = z.object({
  address: addressSchema,
  symbol: z.string().optional(),
  name: z.string().optional(),
  rank: z.number().int().optional(),
  open_timestamp: z.union([z.number(), z.string()]).optional(),
  market_cap: z.union([z.number(), z.string()]).nullish(),
  volume: z.union([z.number(), z.string()]).nullish(),
  liquidity: z.union([z.number(), z.string()]).nullish(),
  creation_timestamp: z.union([z.number(), z.string()]).nullish(),
}).passthrough();
export type GmgnHotSearchRow = z.infer<typeof gmgnHotSearchRowSchema>;

/**
 * Fetch GMGN Hot Search tokens for one chain. The gmgn-cli command is
 * `market hotsearch --chain <slug> --interval <window> --limit <n> --raw`.
 *
 * Output rows are normalized via `gmgnHotSearchRowSchema`. If GMGN
 * returns an unrecognized shape we throw — the caller is expected to
 * fail-closed for new entries when GMGN is unavailable.
 */
export async function gmgnHotSearch(chainId: ChainId, gmgn: Gmgn, interval: z.infer<typeof trendingWindow> = '1h', limit = 50): Promise<GmgnHotSearchRow[]> {
  const payload = await gmgn.query(chainId, 'hotsearch', { interval, limit });
  const envelope = z.object({ data: z.unknown().optional() }).passthrough().safeParse(payload);
  const data = envelope.success && envelope.data.data !== undefined ? envelope.data.data : payload;
  let rows: unknown[];
  if (Array.isArray(data)) {
    const chainEnvelopes = z.array(z.object({ tokens: z.array(z.unknown()) }).passthrough()).safeParse(data);
    rows = chainEnvelopes.success ? chainEnvelopes.data.flatMap(item => item.tokens) : data;
  } else {
    const object = z.object({ rank: z.array(z.unknown()).optional(), tokens: z.array(z.unknown()).optional() }).parse(data);
    rows = object.tokens ?? object.rank ?? [];
  }
  return z.array(gmgnHotSearchRowSchema).parse(rows);
}
function unwrapData(payload: unknown) {
  return payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')
    ? (payload as { data: unknown }).data : payload;
}
export function normalizeGmgnPrice(payload: unknown, chainId: ChainId, token: Address, observedAt: number): Price {
  const body = unwrapData(payload);
  const raw = z.object({ address: addressSchema.optional(), price: z.union([
    z.object({ price: z.union([z.number(), z.string()]) }).passthrough(), z.number(), z.string(),
  ]) }).passthrough().parse(body);
  if (raw.address && raw.address !== addressSchema.parse(token)) throw new Error('GMGN_TOKEN_MISMATCH');
  const value = typeof raw.price === 'object' ? raw.price.price : raw.price;
  return priceSchema.parse({ chainId, token, usd: Number(value), source: 'gmgn', observedAt, fetchedAt: Date.now() / 1000 });
}
const optionalRate = z.union([z.number(), z.string()]).nullish().transform(value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
});
const gmgnSecuritySchema = z.object({
  address: addressSchema, is_honeypot: z.boolean().nullable().optional(), honeypot: z.number().int().optional(),
  sell_tax: optionalRate, top_10_holder_rate: optionalRate,
  is_open_source: z.boolean().nullable().optional(), open_source: z.number().int().optional(),
  flags: z.array(z.unknown()).nullable().optional(), privileges: z.array(z.unknown()).nullable().optional(),
}).passthrough();
export function normalizeGmgnRisk(payload: unknown, chainId: ChainId, token: Address, observedAt: number): Risk {
  const body = unwrapData(payload);
  const raw = gmgnSecuritySchema.parse(body);
  if (raw.address !== addressSchema.parse(token)) throw new Error('GMGN_TOKEN_MISMATCH');
  const honeypot = typeof raw.is_honeypot === 'boolean' ? raw.is_honeypot : raw.honeypot === 0 ? false : raw.honeypot === 1 ? true : null;
  const openSource = typeof raw.is_open_source === 'boolean' ? raw.is_open_source : raw.open_source === 1 ? true : raw.open_source === 0 ? false : null;
  const capabilitiesKnown = Array.isArray(raw.flags) && Array.isArray(raw.privileges) && openSource !== null;
  const criticalAdmin = capabilitiesKnown ? !openSource || raw.flags!.length > 0 || raw.privileges!.length > 0 : null;
  const holderRate = raw.top_10_holder_rate;
  const top10HolderPct = holderRate === null ? null : holderRate <= 1 ? holderRate * 100 : holderRate <= 100 ? holderRate : null;
  const taxRate = raw.sell_tax;
  // GMGN documents EVM tax as a fractional rate. Values outside [0,1] stay unknown.
  const sellTaxBps = taxRate === null || taxRate > 1 ? null : Math.round(taxRate * 10_000);
  return riskSchema.parse({ chainId, token, observedAt, source: 'gmgn', honeypot, criticalAdmin, sellTaxBps,
    top10HolderPct, buySimulation: null, sellSimulation: null, smartMoneyScore: null });
}
export const dexPairSchema = z.object({
  chainId: z.string(), dexId: z.string(), pairAddress: z.string(), labels: z.array(z.string()).optional(),
  baseToken: z.object({ address: addressSchema, symbol: z.string().optional() }),
  quoteToken: z.object({ address: addressSchema, symbol: z.string().optional() }),
  priceUsd: z.string().nullish(), liquidity: z.object({ usd: z.number().finite().nonnegative().optional() }).nullish(),
  pairCreatedAt: z.number().finite().nonnegative().optional(),
}).passthrough();
export type DexPair = z.infer<typeof dexPairSchema>;
export class Market {
  constructor(private providers: Providers, private gmgn = new Gmgn(providers)) {}
  async pools(chainId: ChainId, token: Address): Promise<DexPair[]> {
    const slug = sourceSlug(chainId, 'dexScreener');
    const response = await this.providers.json(chainId, 'dexscreener', `https://api.dexscreener.com/token-pairs/v1/${slug}/${addressSchema.parse(token)}`);
    const pairs = z.array(dexPairSchema).parse(response);
    if (pairs.some(p => p.chainId !== slug)) throw new Error('DEXSCREENER_CHAIN_MISMATCH');
    return pairs;
  }
  async prices(chainId: ChainId, token: Address): Promise<Price[]> {
    const address = addressSchema.parse(token), now = Date.now() / 1000;
    if (getChain(chainId).stableTokens.includes(address)) return [priceSchema.parse({ chainId, token: address, usd: 1, source: 'stable', observedAt: now, fetchedAt: now })];
    try { return [await this.gmgn.price(chainId, address)]; } catch {}
    try {
      const payload = await this.providers.json(chainId, 'geckoterminal', `https://api.geckoterminal.com/api/v2/simple/networks/${sourceSlug(chainId, 'gecko')}/token_price/${address}`);
      const data = z.object({ data: z.object({ attributes: z.object({ token_prices: z.record(z.string()) }) }) }).parse(payload);
      return [priceSchema.parse({ chainId, token: address, usd: Number(data.data.attributes.token_prices[address]), source: 'geckoterminal', observedAt: now, fetchedAt: Date.now() / 1000 })];
    } catch { return []; }
  }
}
