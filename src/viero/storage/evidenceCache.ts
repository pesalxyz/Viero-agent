import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RpcTelemetry, defaultRpcTelemetry } from '../observability/rpcTelemetry.js';

export type CachedTokenMetadata = { chainId: number; address: string; bytecodeHash: string; decimals: number; symbol: string; verifiedAtBlock: string; verifiedAtBlockHash: string };
export type CachedPoolCreation = { chainId: number; identity: string; creationBlock: string; timestamp: number; creationBlockHash: string; verifiedAtBlock: string; verifiedAtBlockHash: string };
type EvidenceFile = { version: 1; tokens: Record<string, CachedTokenMetadata>; pools: Record<string, CachedPoolCreation> };

const empty = (): EvidenceFile => ({ version: 1, tokens: {}, pools: {} });

/** Small persistent cache for immutable, independently verifiable evidence. */
export class EvidenceCache {
  private data: EvidenceFile | null = null;
  private lock: Promise<void> = Promise.resolve();
  constructor(readonly file = process.env.VIERO_EVIDENCE_CACHE_FILE ?? join(process.cwd(), 'data/viero/evidence-cache.json'), readonly telemetry: RpcTelemetry = defaultRpcTelemetry) {}

  async token(chainId: number, address: string, bytecodeHash: string, atBlock: bigint, atBlockHash: string): Promise<CachedTokenMetadata | null> {
    return this.serial(async () => {
      const data = await this.load();
      const key = `${chainId}:${address.toLowerCase()}`;
      const item = data.tokens[key];
      if (!item) { this.telemetry.cache('token', 'miss'); return null; }
      if (item.bytecodeHash.toLowerCase() !== bytecodeHash.toLowerCase()) {
        delete data.tokens[key]; await this.persist(data); this.telemetry.cache('token', 'invalidation'); return null;
      }
      // The code identity is the validity key. The block hash is retained as
      // provenance; a changed verification block does not make immutable token
      // metadata unsafe as long as bytecode identity is unchanged.
      void atBlock; void atBlockHash;
      this.telemetry.cache('token', 'hit');
      return { ...item };
    });
  }
  async putToken(item: CachedTokenMetadata): Promise<void> {
    await this.serial(async () => { const data = await this.load(); data.tokens[`${item.chainId}:${item.address.toLowerCase()}`] = item; await this.persist(data); });
  }
  async creation(chainId: number, identity: string, client: { getBlock(args: { blockNumber: bigint }): Promise<{ hash?: string | null }> }): Promise<CachedPoolCreation | null> {
    return this.serial(async () => {
      const data = await this.load();
      const key = `${chainId}:${identity.toLowerCase()}`, item = data.pools[key];
      if (!item) { this.telemetry.cache('creation', 'miss'); return null; }
      try {
        const [creationBlock, verifiedBlock] = await Promise.all([
          client.getBlock({ blockNumber: BigInt(item.creationBlock) }),
          client.getBlock({ blockNumber: BigInt(item.verifiedAtBlock) }),
        ]);
        if (!creationBlock.hash || creationBlock.hash.toLowerCase() !== item.creationBlockHash.toLowerCase()
          || !verifiedBlock.hash || verifiedBlock.hash.toLowerCase() !== item.verifiedAtBlockHash.toLowerCase()) {
          delete data.pools[key]; await this.persist(data); this.telemetry.cache('creation', 'invalidation'); return null;
        }
      } catch {
        delete data.pools[key]; await this.persist(data); this.telemetry.cache('creation', 'invalidation'); return null;
      }
      this.telemetry.cache('creation', 'hit');
      return { ...item };
    });
  }
  async putCreation(item: CachedPoolCreation): Promise<void> {
    await this.serial(async () => { const data = await this.load(); data.pools[`${item.chainId}:${item.identity.toLowerCase()}`] = item; await this.persist(data); });
  }
  async clear(): Promise<void> { await this.serial(async () => { this.data = empty(); await this.persist(this.data); }); }
  private async load(): Promise<EvidenceFile> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as EvidenceFile;
      if (parsed?.version !== 1 || !parsed.tokens || !parsed.pools) throw new Error('INVALID_EVIDENCE_CACHE');
      this.data = parsed; return parsed;
    } catch {
      this.data = empty(); return this.data;
    }
  }
  private async persist(data: EvidenceFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, this.file);
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

export const defaultEvidenceCache = new EvidenceCache();
