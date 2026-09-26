import { type PublicClient } from 'viem';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { getChain } from '../config/chains.js';
import { chainIdSchema, hex32Schema, json, poolIdentity, poolSchema, type ChainId, type PoolRef } from '../domain.js';
import { initializeEvent, poolCreatedEvent } from '../adapters/abi.js';
import { pagedLogs } from '../adapters/events.js';

export const INDEX_BLOCK_CHUNK_SIZE = 50_000n;
const CHECKPOINT_PERSIST_CHUNKS = 20;

export async function scanProtocolPools(client: PublicClient, chainId: ChainId, fromBlock: bigint, toBlock: bigint): Promise<PoolRef[]> {
  if (fromBlock < 0n || toBlock < fromBlock) throw new Error('INVALID_INDEX_RANGE');
  const chain = getChain(chainId), pools: PoolRef[] = [], identities = new Set<string>();
  const add = (pool: PoolRef) => {
    const identity = poolIdentity(pool);
    if (!identities.has(identity)) { identities.add(identity); pools.push(pool); }
  };
  for (const [dex, deployment] of Object.entries(chain.v3)) {
    const logs = await pagedLogs(fromBlock, toBlock, (start, end) => client.getLogs({
      address: deployment.factory, event: poolCreatedEvent, strict: true, fromBlock: start, toBlock: end,
    }), INDEX_BLOCK_CHUNK_SIZE);
    for (const log of logs) {
      if (log.removed) throw new Error('REORG_DURING_V3_INDEX');
      add(poolSchema.parse({ chainId, protocol: 'v3', dex, poolAddress: log.args.pool }));
    }
  }
  const v4Logs = await pagedLogs(fromBlock, toBlock, (start, end) => client.getLogs({
    address: chain.v4.poolManager, event: initializeEvent, strict: true, fromBlock: start, toBlock: end,
  }), INDEX_BLOCK_CHUNK_SIZE);
  for (const log of v4Logs) {
    if (log.removed) throw new Error('REORG_DURING_V4_INDEX');
    const k = log.args;
    add(poolSchema.parse({ chainId, protocol: 'v4', dex: 'uniswap', poolId: k.id,
      poolKey: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks } }));
  }
  return pools;
}

export class ProtocolPoolIndex {
  private orderedPools: PoolRef[] = [];
  private poolIdentities = new Set<string>();
  private indexedBlock: bigint | null = null;
  private indexedBlockHash: `0x${string}` | null = null;
  private loaded = false;
  private syncing: Promise<void> | null = null;
  constructor(readonly chainId: ChainId, readonly startBlock: bigint, readonly checkpointFile?: string) {}
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.checkpointFile) return;
    await this.cleanupTemporaryFiles();
    let raw: string;
    try { raw = await readFile(this.checkpointFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const saved = z.object({ version: z.literal(1), chainId: chainIdSchema, startBlock: z.string().regex(/^\d+$/),
      indexedBlock: z.string().regex(/^\d+$/), indexedBlockHash: hex32Schema, pools: z.unknown() }).strict().parse(JSON.parse(raw));
    raw = '';
    if (saved.chainId !== this.chainId || BigInt(saved.startBlock) !== this.startBlock) throw new Error('INDEX_CHECKPOINT_CONFIG_MISMATCH');
    if (!Array.isArray(saved.pools)) throw new Error('INDEX_CHECKPOINT_POOLS_INVALID');
    this.indexedBlock = BigInt(saved.indexedBlock); this.indexedBlockHash = saved.indexedBlockHash;
    // Compact in place so loading a large checkpoint does not allocate a second pool array.
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < saved.pools.length; readIndex++) {
      const pool = poolSchema.parse(saved.pools[readIndex]);
      const identity = poolIdentity(pool);
      if (this.poolIdentities.has(identity)) continue;
      this.poolIdentities.add(identity);
      saved.pools[writeIndex++] = pool;
    }
    saved.pools.length = writeIndex;
    this.orderedPools = saved.pools as PoolRef[];
  }
  async sync(client: PublicClient, targetBlock: bigint) {
    await this.load();
    if (this.syncing) return this.syncing;
    this.syncing = this.syncInner(client, targetBlock).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async syncInner(client: PublicClient, targetBlock: bigint) {
    if (this.indexedBlock !== null) {
      const checkpoint = await client.getBlock({ blockNumber: this.indexedBlock });
      if (checkpoint.hash !== this.indexedBlockHash) throw new Error('INDEX_CHECKPOINT_REORG');
      if (targetBlock <= this.indexedBlock) return;
    }
    const first = this.indexedBlock === null ? this.startBlock : this.indexedBlock + 1n;
    let chunksSinceSave = 0;
    for (let from = first; from <= targetBlock; from += INDEX_BLOCK_CHUNK_SIZE) {
      const end = from + INDEX_BLOCK_CHUNK_SIZE - 1n > targetBlock ? targetBlock : from + INDEX_BLOCK_CHUNK_SIZE - 1n;
      for (const pool of await scanProtocolPools(client, this.chainId, from, end)) {
        const identity = poolIdentity(pool);
        if (this.poolIdentities.has(identity)) continue;
        this.poolIdentities.add(identity);
        this.orderedPools.push(pool);
      }
      const block = await client.getBlock({ blockNumber: end });
      if (!block.hash) throw new Error('INDEX_TARGET_HASH_MISSING');
      this.indexedBlock = end; this.indexedBlockHash = block.hash;
      chunksSinceSave++;
      // Keep the prior roughly one-million-block persistence cadence so
      // smaller RPC ranges do not multiply full checkpoint rewrites.
      if (chunksSinceSave >= CHECKPOINT_PERSIST_CHUNKS || end === targetBlock) {
        await this.save();
        chunksSinceSave = 0;
      }
      const memory = process.memoryUsage();
      console.error(`[viero.indexer.memory] chain=${this.chainId} from=${from} to=${end} rss=${memory.rss} heapUsed=${memory.heapUsed} heapTotal=${memory.heapTotal} pools=${this.orderedPools.length}`);
    }
  }
  private async cleanupTemporaryFiles() {
    if (!this.checkpointFile) return;
    const directory = dirname(this.checkpointFile), prefix = `${basename(this.checkpointFile)}.`;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await Promise.all(entries.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && /^\d+\.tmp$/.test(entry.name.slice(prefix.length)))
      .map(entry => unlink(`${directory}/${entry.name}`)));
  }
  private async save() {
    if (!this.checkpointFile || this.indexedBlock === null || this.indexedBlockHash === null) return;
    await mkdir(dirname(this.checkpointFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.checkpointFile}.${process.pid}.tmp`;
    await writeFile(temporary, json({ version: 1, chainId: this.chainId, startBlock: this.startBlock,
      indexedBlock: this.indexedBlock, indexedBlockHash: this.indexedBlockHash, pools: this.orderedPools }), { mode: 0o600 });
    await rename(temporary, this.checkpointFile);
  }
  snapshot() { return { indexedBlock: this.indexedBlock, indexedBlockHash: this.indexedBlockHash, pools: this.orderedPools }; }
}
