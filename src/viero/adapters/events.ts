import { type Address, type Hex, type PublicClient, erc20Abi } from 'viem';
import { poolIdentity, observationSchema, type PoolState, type Observation, type Price, type Swap } from '../domain.js';
import { getChain } from '../config/chains.js';
import { pancakeV3SwapEvent, stateViewAbi, v3Abi, v3ProtocolFeeEvent, v3SwapEvent, v4ProtocolFeeEvent, v4SwapEvent } from './abi.js';
import { readDepthTicks } from './pools.js';
import { spotPrice, tokenValue } from '../screening/math.js';
import { swapFeeUsd } from '../indexer/fees.js';
import { defaultEvidenceCache, type EvidenceCache } from '../storage/evidenceCache.js';
import { defaultRpcTelemetry, type RpcTelemetry } from '../observability/rpcTelemetry.js';

// Subdivide capped responses as well as RPC errors. A capped single block is an error, never a partial success.
export type PagedLogsOptions = { chainId?: number; telemetry?: RpcTelemetry };
export async function pagedLogs<T>(from: bigint, to: bigint, read: (from: bigint, to: bigint) => Promise<T[]>, pageSize = 1000n, rowCap = 1000, options: PagedLogsOptions = {}): Promise<T[]> {
  if (from < 0n || to < from || pageSize < 1n || rowCap < 1) throw new Error('Invalid log range');
  const result: T[] = [];
  const pending: Array<{ start: bigint; end: bigint }> = [];
  let pages = 0, splits = 0, errors = 0, started = Date.now();
  for (let start = to - ((to - from) % pageSize); start >= from; start -= pageSize) {
    pending.push({ start, end: start + pageSize - 1n > to ? to : start + pageSize - 1n });
    if (start === from) break;
  }
  while (pending.length) {
    const { start, end } = pending.pop()!;
    let rows: T[] | null = null;
    try {
      pages += 1;
      rows = await read(start, end);
      if (rows.length < rowCap) {
        result.push(...rows);
        continue;
      }
      if (start === end) { options.telemetry?.pagination(options.chainId ?? 0, from, to, pages, splits, result.length, Date.now() - started, true); throw new Error('LOG_ROW_CAP_AT_SINGLE_BLOCK'); }
    } catch (e) {
      errors += 1;
      if (start === end || !/block range|too many|more than|limit exceeded|exceeds defined limit|response.*size|query.*limit|-32005/i.test(e instanceof Error ? e.message : String(e))) { options.telemetry?.pagination(options.chainId ?? 0, from, to, pages, splits, result.length, Date.now() - started, true); throw e; }
    }
    const mid = (start + end) / 2n;
    splits += 1;
    // Stack is LIFO: push the right half first to preserve ascending order.
    pending.push({ start: mid + 1n, end });
    pending.push({ start, end: mid });
  }
  if (options.chainId !== undefined) options.telemetry?.pagination(options.chainId, from, to, pages, splits, result.length, Date.now() - started, errors > 0);
  return result;
}
export async function firstBlockAt(client: PublicClient, head: bigint, timestamp: number): Promise<bigint> {
  let low = 0n, high = head;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (Number((await client.getBlock({ blockNumber: mid })).timestamp) < timestamp) low = mid + 1n;
    else high = mid;
  }
  return low;
}

/** Cycle-scoped exact timestamp-to-block boundary cache. The caller supplies
 * the already pinned head hash; a changed head/hash therefore cannot hit. */
export class BlockBoundaryCache {
  private readonly entries = new Map<string, bigint>();
  constructor(private readonly capacity = 128) {}
  async get(client: PublicClient, chainId: number, head: bigint, headHash: string, timestamp: number): Promise<bigint> {
    const key = `${chainId}:${head.toString()}:${headHash.toLowerCase()}:${timestamp}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
    const value = await firstBlockAt(client, head, timestamp);
    this.entries.set(key, value);
    while (this.entries.size > Math.max(1, this.capacity)) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  clear(): void { this.entries.clear(); }
  size(): number { return this.entries.size; }
}

type HistoricalMemoKind = 'block' | 'state' | 'transaction';

/**
 * Observation-local memo for equivalent historical reads.  It is deliberately
 * not exported as a process cache: an observation owns its instance and drops
 * it at completion (or on any reorg/error).  Entries are only keyed when the
 * caller has a block identity; unknown identities are read directly.
 */
export class ObservationRpcMemo {
  private readonly entries = new Map<string, Promise<unknown>>();
  constructor(private readonly telemetry: RpcTelemetry = defaultRpcTelemetry, private readonly capacity = 128) {}

  async read<T>(kind: HistoricalMemoKind, key: string | null, read: () => Promise<T>): Promise<T> {
    if (key === null) return read();
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.telemetry.historicalMemo(kind, 'hit');
      this.telemetry.historicalMemoAvoided();
      return existing as Promise<T>;
    }
    this.telemetry.historicalMemo(kind, 'miss');
    const pending = read().then(value => {
      // Nullish/incomplete historical evidence is never memoized.
      if (value === null || value === undefined) this.entries.delete(key);
      return value;
    }, error => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    while (this.entries.size > Math.max(1, this.capacity)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.telemetry.historicalMemoEviction();
    }
    return pending as Promise<T>;
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
    this.telemetry.historicalMemoInvalidation();
  }

  size(): number { return this.entries.size; }
}

/**
 * Find the first block at which one exact pool was initialized. This is
 * O(log(head)) pinned RPC reads and never enumerates the pool universe.
 */
export type PoolCreationEvidence = { blockNumber: bigint; timestamp: number; blockHash: Hex | null };
export async function exactPoolCreatedEvidence(client: PublicClient, state: PoolState, cache?: EvidenceCache): Promise<PoolCreationEvidence | null> {
  const identity = poolIdentity(state.pool);
  if (cache) {
    const cached = await cache.creation(state.pool.chainId, identity, client);
    if (cached && BigInt(cached.creationBlock) <= state.blockNumber) return { blockNumber: BigInt(cached.creationBlock), timestamp: cached.timestamp, blockHash: cached.creationBlockHash as Hex };
  }
  const existsAt = async (blockNumber: bigint) => {
    try {
      if (state.pool.protocol === 'v3') {
        const code = await client.getBytecode({ address: state.pool.poolAddress, blockNumber });
        return Boolean(code && code !== '0x');
      }
      const slot = await client.readContract({
        address: getChain(state.pool.chainId).v4.stateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [state.pool.poolId],
        blockNumber,
      });
      return slot[0] > 0n;
    } catch {
      return false;
    }
  };
  if (!await existsAt(state.blockNumber)) return null;
  let low = 0n, high = state.blockNumber;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (await existsAt(mid)) high = mid;
    else low = mid + 1n;
  }
  const block = await client.getBlock({ blockNumber: low });
  const evidence = { blockNumber: low, timestamp: Number(block.timestamp), blockHash: block.hash ? block.hash as Hex : null };
  if (cache && evidence.blockHash) await cache.putCreation({ chainId: state.pool.chainId, identity, creationBlock: low.toString(), timestamp: evidence.timestamp, creationBlockHash: evidence.blockHash, verifiedAtBlock: state.blockNumber.toString(), verifiedAtBlockHash: state.blockHash });
  return evidence;
}
export async function exactPoolCreatedAt(client: PublicClient, state: PoolState): Promise<number | null> {
  const evidence = await exactPoolCreatedEvidence(client, state);
  return evidence?.timestamp ?? null;
}

// Conservative whole-position envelopes: open, one claim/rebalance, close.
// They bound request volume and are intentionally independent of execution.
export const LIFECYCLE_GAS_UNITS = { v3: 1_200_000n, v4: 1_600_000n } as const;
export async function estimatedLifecycleCostUsd(client: PublicClient, state: PoolState, nativeUsd: number | null): Promise<number | null> {
  if (nativeUsd === null || !Number.isFinite(nativeUsd) || nativeUsd <= 0) return null;
  try {
    const gasPrice = await client.getGasPrice();
    const gasUnits = LIFECYCLE_GAS_UNITS[state.pool.protocol];
    // 25% headroom prevents a momentary low gas quote from overstating net yield.
    return Number(gasPrice * gasUnits) / 1e18 * nativeUsd * 1.25;
  } catch {
    return null;
  }
}

export async function targetedRpcObservation(
  client: PublicClient,
  state: PoolState,
  prices: Price[],
  windowMinutes: number,
  nativeUsd: number | null,
  cache: EvidenceCache = defaultEvidenceCache,
  boundaries?: BlockBoundaryCache,
): Promise<Observation> {
  const [poolCreated, lifecycleCost] = await Promise.all([
    exactPoolCreatedEvidence(client, state, cache),
    estimatedLifecycleCostUsd(client, state, nativeUsd),
  ]);
  const observation = await rpcObservation(client, state, prices, windowMinutes, poolCreated?.timestamp ?? null, boundaries);
  return observationSchema.parse({
    ...observation,
    estimatedLifecycleCostUsd: lifecycleCost,
    issues: [
      ...observation.issues.filter(issue => !issue.includes('lifecycle costs still require enrichment')),
      ...(poolCreated === null ? ['Exact pool creation block unavailable from bounded RPC history'] : []),
      ...(lifecycleCost === null ? ['Lifecycle gas cost unavailable from RPC gas price/native USD reference'] : ['Lifecycle gas cost uses a conservative protocol gas-unit envelope']),
      ...(state.pool.protocol === 'v4' ? ['V4 exact per-pool TVL unavailable from shared PoolManager balances'] : []),
    ],
  });
}

/** Minimal current-state observation for live position management. Never reads historical logs. */
export function lightweightManagementObservation(state: import('../domain.js').PoolState, prices: Price[]): Observation {
  return observationSchema.parse({ state, windowStart: state.observedAt, windowEnd: state.observedAt, source: 'lightweight-management', indexedBlock: state.blockNumber, complete: true, valuation: 'window-end-reference', swaps: [], prices, risks: [], tvlUsd: null, poolCreatedAt: null, ticks: [], ticksComplete: false, positionsCreated: null, uniqueLps: null, liquidityAddedUsd: null, liquidityRemovedUsd: null, estimatedLifecycleCostUsd: null, issues: [] });
}
export async function rpcObservation(client: PublicClient, state: PoolState, prices: Price[], windowMinutes: number, poolCreatedAt: number | null = null, boundaries?: BlockBoundaryCache, memo = new ObservationRpcMemo()): Promise<Observation> {
  const { pool, blockNumber } = state, windowEnd = state.observedAt, windowStart = windowEnd - windowMinutes * 60;
  const from = boundaries ? await boundaries.get(client, pool.chainId, blockNumber, state.blockHash, windowStart) : await firstBlockAt(client, blockNumber, windowStart);
  const telemetry = defaultRpcTelemetry;
  const p0 = prices.find(p => p.token === state.token0.address)?.usd, p1 = prices.find(p => p.token === state.token1.address)?.usd;
  if (!p0 || !p1) throw new Error('PRICE_UNAVAILABLE_FOR_RPC_METRICS');
  const swaps: Swap[] = [];
  const times = new Map<bigint, number>();
  const traders = new Map<Hex, Address>();
  const logs = pool.protocol === 'v4'
    ? await pagedLogs(from, blockNumber, (fromBlock, toBlock) => client.getLogs({ address: getChain(pool.chainId).v4.poolManager, event: v4SwapEvent, args: { id: pool.poolId }, strict: true, fromBlock, toBlock }), 1000n, 1000, { chainId: pool.chainId, telemetry })
    : pool.dex === 'pancakeswap'
      ? await pagedLogs(from, blockNumber, (fromBlock, toBlock) => client.getLogs({ address: pool.poolAddress, event: pancakeV3SwapEvent, strict: true, fromBlock, toBlock }), 1000n, 1000, { chainId: pool.chainId, telemetry })
      : await pagedLogs(from, blockNumber, (fromBlock, toBlock) => client.getLogs({ address: pool.poolAddress, event: v3SwapEvent, strict: true, fromBlock, toBlock }), 1000n, 1000, { chainId: pool.chainId, telemetry });
  const protocolUpdates = pool.protocol === 'v4'
    ? await pagedLogs(from, blockNumber, (fromBlock, toBlock) => client.getLogs({ address: getChain(pool.chainId).v4.poolManager, event: v4ProtocolFeeEvent, args: { id: pool.poolId }, strict: true, fromBlock, toBlock }), 1000n, 1000, { chainId: pool.chainId, telemetry })
    : pool.dex === 'uniswap'
      ? await pagedLogs(from, blockNumber, (fromBlock, toBlock) => client.getLogs({ address: pool.poolAddress, event: v3ProtocolFeeEvent, strict: true, fromBlock, toBlock }), 1000n, 1000, { chainId: pool.chainId, telemetry })
      : [];
  const protocolFees = new Map<bigint, number>();
  const eventBlockHashes = new Map<bigint, Hex>();
  for (const log of logs) {
    if (log.blockNumber !== null && log.blockHash) {
      const previous = eventBlockHashes.get(log.blockNumber);
      if (previous && previous.toLowerCase() !== log.blockHash.toLowerCase()) throw new Error('REORG_DURING_OBSERVATION');
      eventBlockHashes.set(log.blockNumber, log.blockHash);
    }
  }
  const eventBlocks = [...new Set(logs.map(log => log.blockNumber))].filter((n): n is bigint => n !== null);
  const reads: Array<() => Promise<void>> = [
    ...eventBlocks.map(n => async () => {
      const expectedHash = eventBlockHashes.get(n) ?? null;
      const block = await memo.read('block', expectedHash ? `block:${pool.chainId}:${n}:${expectedHash.toLowerCase()}` : null, () => client.getBlock({ blockNumber: n }));
      if (expectedHash && block.hash && block.hash.toLowerCase() !== expectedHash.toLowerCase()) { memo.invalidate(); throw new Error('REORG_DURING_OBSERVATION'); }
      times.set(n, Number(block.timestamp));
    }),
    ...eventBlocks.map(n => async () => {
      const before = n > 0n ? n - 1n : n;
      const expectedHash = eventBlockHashes.get(n) ?? null;
      const stateKey = expectedHash ? `state:${pool.chainId}:${pool.protocol === 'v3' ? pool.poolAddress : getChain(pool.chainId).v4.stateView}:${pool.protocol === 'v3' ? 'slot0' : `getSlot0:${pool.poolId}`}:${before}:${expectedHash.toLowerCase()}` : null;
      const slot = await memo.read<any>('state', stateKey, () => pool.protocol === 'v3'
        ? client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'slot0', blockNumber: before })
        : client.readContract({ address: getChain(pool.chainId).v4.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [pool.poolId], blockNumber: before }));
      protocolFees.set(n, pool.protocol === 'v3' ? slot[5]! : slot[2]!);
    }),
    ...[...new Set(logs.map(log => log.transactionHash))].filter((hash): hash is Hex => hash !== null).map(hash => async () => {
      const event = logs.find(log => log.transactionHash === hash);
      const expectedHash = event?.blockNumber === null || event?.blockNumber === undefined ? null : eventBlockHashes.get(event.blockNumber) ?? null;
      const tx = await memo.read('transaction', expectedHash ? `tx:${pool.chainId}:${hash.toLowerCase()}:${expectedHash.toLowerCase()}` : null, () => client.getTransaction({ hash }));
      if (expectedHash && tx.blockHash && tx.blockHash.toLowerCase() !== expectedHash.toLowerCase()) { memo.invalidate(); throw new Error('REORG_DURING_OBSERVATION'); }
      traders.set(hash, tx.from.toLowerCase() as Address);
    }),
  ];
  for (let offset = 0; offset < reads.length; offset += 20) await Promise.all(reads.slice(offset, offset + 20).map(read => read()));
  for (const log of logs) {
    if (log.removed || log.blockNumber === null || !log.transactionHash || log.logIndex === null) throw new Error('UNCONFIRMED_EVENT');
    const n = log.blockNumber, hash = log.transactionHash;
    // Normalize v4 caller deltas into v3-style pool deltas: positive means input to the pool.
    const sign = pool.protocol === 'v4' ? -1n : 1n;
    const amount0 = log.args.amount0! * sign, amount1 = log.args.amount1! * sign;
    const volumeUsd = amount0 > 0n ? tokenValue(amount0, state.token0.decimals, p0) : tokenValue(amount1, state.token1.decimals, p1);
    const effectiveFee = 'fee' in log.args ? log.args.fee! : state.fee;
    let protocolFee = protocolFees.get(n) ?? state.protocolFee;
    for (const update of protocolUpdates.filter(update => update.blockNumber === n && update.logIndex !== null && update.logIndex < log.logIndex).sort((a, b) => a.logIndex! - b.logIndex!)) {
      if ('protocolFee' in update.args) protocolFee = update.args.protocolFee!;
      else protocolFee = update.args.feeProtocol0New! + (update.args.feeProtocol1New! << 4);
    }
    const stateAtSwap = { ...state, protocolFee };
    const zeroForOne = amount0 > 0n;
    const calculated = swapFeeUsd(stateAtSwap, zeroForOne, volumeUsd, effectiveFee);
    const pancakeArgs = log.args as typeof log.args & { protocolFeesToken0?: bigint; protocolFeesToken1?: bigint };
    const exactPancakeProtocolFee = pool.protocol === 'v3' && pool.dex === 'pancakeswap'
      ? tokenValue(zeroForOne ? pancakeArgs.protocolFeesToken0! : pancakeArgs.protocolFeesToken1!, zeroForOne ? state.token0.decimals : state.token1.decimals, zeroForOne ? p0 : p1)
      : null;
    swaps.push({ pool, blockNumber: n, transactionHash: hash, logIndex: log.logIndex, timestamp: times.get(n)!, trader: traders.get(hash)!,
      amount0, amount1, price1Per0: spotPrice({ ...state, sqrtPriceX96: log.args.sqrtPriceX96! }), volumeUsd,
      grossFeeUsd: calculated.grossFeeUsd,
      lpFeeUsd: exactPancakeProtocolFee === null ? calculated.lpFeeUsd : Math.max(0, calculated.grossFeeUsd - exactPancakeProtocolFee) });
  }
  const ticks = await readDepthTicks(client, state);
  let tvlUsd: number | null = null;
  if (pool.protocol === 'v3') {
    const balances = await Promise.all([state.token0, state.token1].map(t => client.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [pool.poolAddress], blockNumber })));
    tvlUsd = tokenValue(balances[0]!, state.token0.decimals, p0) + tokenValue(balances[1]!, state.token1.decimals, p1);
  }
  const finalBlock = await client.getBlock({ blockNumber });
  if (finalBlock.hash !== state.blockHash) throw new Error('REORG_DURING_OBSERVATION');
  return observationSchema.parse({ state, windowStart, windowEnd, source: `rpc:${poolIdentity(pool)}`, indexedBlock: blockNumber,
    complete: true, valuation: 'window-end-reference', swaps, prices, risks: [], tvlUsd, poolCreatedAt, ticks, ticksComplete: true,
    positionsCreated: null, uniqueLps: null, liquidityAddedUsd: null, liquidityRemovedUsd: null, estimatedLifecycleCostUsd: null,
    issues: ['RPC valuation uses captured window-end prices', 'LP-net fees are normalized from block-pinned protocol state; token risk, simulations, and lifecycle costs still require enrichment'] });
}
