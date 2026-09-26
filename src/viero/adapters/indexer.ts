import { z } from 'zod';
import { poolSchema, poolIdentity, observationSchema, type ChainId, type PoolRef, type PoolState } from '../domain.js';
import { Providers } from './providers.js';

const pageSchema = z.object({ chainId: z.number(), pools: z.array(poolSchema), nextCursor: z.string().min(1).nullable(), complete: z.boolean() });
export class Indexer {
  constructor(private providers: Providers, private env: NodeJS.ProcessEnv = process.env) {}
  configured(chainId: ChainId) { return Boolean(this.env[`VIERO_INDEXER_${chainId}`]); }
  private url(chainId: ChainId, path: string) {
    const base = this.env[`VIERO_INDEXER_${chainId}`];
    if (!base) throw new Error(`INDEXER_NOT_CONFIGURED: ${chainId}`);
    return `${base.replace(/\/$/, '')}${path}`;
  }
  async discover(chainId: ChainId): Promise<PoolRef[]> {
    const result: PoolRef[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ chainId: String(chainId) });
      if (cursor) query.set('cursor', cursor);
      const data = pageSchema.parse(await this.providers.json(chainId, 'indexer', this.url(chainId, `/v1/pools?${query}`)));
      if (data.chainId !== chainId || data.pools.some(p => p.chainId !== chainId)) throw new Error('INDEXER_CHAIN_MISMATCH');
      if (!data.complete) throw new Error('INCOMPLETE_INDEXER_PAGE');
      result.push(...data.pools);
      cursor = data.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('INDEXER_CURSOR_DID_NOT_ADVANCE');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 10000) throw new Error('INDEXER_PAGINATION_LIMIT');
    } while (cursor);
    return [...new Map(result.map(p => [poolIdentity(p), p])).values()];
  }
  async observe(state: PoolState, windowMinutes: number) {
    const payload = await this.providers.json(state.pool.chainId, 'indexer', this.url(state.pool.chainId, '/v1/observations'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pool: state.pool, blockNumber: String(state.blockNumber), blockHash: state.blockHash,
        windowStart: state.observedAt - windowMinutes * 60, windowEnd: state.observedAt }),
    });
    const observation = observationSchema.parse(payload);
    if (poolIdentity(observation.state.pool) !== poolIdentity(state.pool) || observation.state.blockHash !== state.blockHash || observation.state.blockNumber !== state.blockNumber) throw new Error('INDEXER_SNAPSHOT_MISMATCH');
    if (observation.state.token0.address !== state.token0.address || observation.state.token1.address !== state.token1.address || observation.state.token0.decimals !== state.token0.decimals || observation.state.token1.decimals !== state.token1.decimals) throw new Error('INDEXER_TOKEN_MISMATCH');
    return { ...observation, state };
  }
}
