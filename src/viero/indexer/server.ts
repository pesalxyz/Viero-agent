#!/usr/bin/env node
import express from 'express';
import { z } from 'zod';
import { resolve } from 'node:path';
import { PublicClients } from '../clients/publicClients.js';
import { CHAIN_IDS, getChain } from '../config/chains.js';
import { chainIdSchema, errorMessage, hex32Schema, json, poolSchema, type ChainId } from '../domain.js';
import { Providers, Gmgn, Market } from '../adapters/providers.js';
import { verifyPool } from '../adapters/pools.js';
import { rpcObservation } from '../adapters/events.js';
import { ProtocolPoolIndex } from './protocol.js';

try { process.loadEnvFile?.(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
// Indexer responses are immediately consumed and must not be retained for the
// process lifetime. Agent runs use the default retention behavior separately.
// Viero token-first architecture lets operators disable the indexer entirely
// when targeted token discovery is the primary entry path. Set
// VIERO_INDEXER_DISABLE=1 to skip binding to the indexer.
if (process.env.VIERO_INDEXER_DISABLE === '1') {
  console.error('Viero indexer disabled via VIERO_INDEXER_DISABLE=1; exiting.');
  process.exit(0);
}
const clients = new PublicClients(), providers = new Providers(0), gmgn = new Gmgn(providers), market = new Market(providers, gmgn);
const indexes = new Map<ChainId, ProtocolPoolIndex>();
const dataDir = resolve(process.env.VIERO_INDEXER_DATA_DIR ?? 'data/viero-indexer');
for (const chainId of CHAIN_IDS) {
  const value = process.env[`VIERO_INDEXER_START_${chainId}`];
  if (value && /^\d+$/.test(value)) indexes.set(chainId, new ProtocolPoolIndex(chainId, BigInt(value), resolve(dataDir, `${chainId}.json`)));
}
const requestSchema = z.object({
  pool: poolSchema, blockNumber: z.string().regex(/^\d+$/).transform(BigInt), blockHash: hex32Schema,
  windowStart: z.number().finite().nonnegative(), windowEnd: z.number().finite().nonnegative(),
}).strict();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
async function targetBlock(chainId: ChainId) {
  const head = await clients.get(chainId).getBlockNumber({ cacheTime: 0 });
  return head >= BigInt(getChain(chainId).confirmations) ? head - BigInt(getChain(chainId).confirmations - 1) : 0n;
}
async function syncIndex(chainId: ChainId, index: ProtocolPoolIndex) {
  await index.sync(clients.get(chainId), await targetBlock(chainId));
}
app.get('/health', (_req, res) => res.json({ ok: true, chains: [...indexes].map(([chainId, index]) => ({ chainId,
  indexedBlock: index.snapshot().indexedBlock?.toString() ?? null, pools: index.snapshot().pools.length })) }));
app.get('/v1/pools', async (req, res, next) => {
  try {
    const chainId = chainIdSchema.parse(Number(req.query.chainId)), index = indexes.get(chainId);
    if (!index) throw new Error(`INDEX_START_BLOCK_NOT_CONFIGURED: ${chainId}`);
    await index.load();
    if (index.snapshot().indexedBlock === null) {
      void syncIndex(chainId, index).catch(error => console.error(`Indexer ${chainId}: ${errorMessage(error)}`));
      return res.status(503).json({ error: `INDEX_SYNCING: ${chainId}` });
    }
    await syncIndex(chainId, index);
    const offset = z.coerce.number().int().nonnegative().parse(req.query.cursor ?? 0);
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit ?? 200);
    const snapshot = index.snapshot(), pools = snapshot.pools.slice(offset, offset + limit);
    res.type('application/json').send(json({ chainId, pools, indexedBlock: snapshot.indexedBlock, nextCursor: offset + limit < snapshot.pools.length ? String(offset + limit) : null, complete: true }));
  } catch (error) { next(error); }
});
app.post('/v1/observations', async (req, res, next) => {
  try {
    const input = requestSchema.parse(req.body), client = clients.get(input.pool.chainId);
    const duration = input.windowEnd - input.windowStart;
    if (duration <= 0 || duration % 60 !== 0) throw new Error('WINDOW_MUST_USE_WHOLE_MINUTES');
    const state = await verifyPool(client, input.pool, input.blockNumber);
    if (state.blockHash !== input.blockHash || state.observedAt !== input.windowEnd) throw new Error('INDEXER_SNAPSHOT_MISMATCH');
    const prices = (await Promise.all([state.token0, state.token1].map(token => market.prices(input.pool.chainId, token.address)))).flat();
    const observation = await rpcObservation(client, state, prices, duration / 60);
    res.type('application/json').send(json({ ...observation, source: `viero-protocol-indexer:${input.pool.chainId}` }));
  } catch (error) { next(error); }
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof z.ZodError ? 400 : 503).json({ error: errorMessage(error) });
});
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.VIERO_INDEXER_PORT ?? 9100);
const host = process.env.VIERO_INDEXER_HOST ?? '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Viero protocol indexer listening on http://${host}:${port}`);
  void (async () => {
    for (const [chainId, index] of indexes) {
      try { await syncIndex(chainId, index); }
      catch (error) { console.error(`Indexer ${chainId}: ${errorMessage(error)}`); }
    }
  })();
});
