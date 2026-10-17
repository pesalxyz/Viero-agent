#!/usr/bin/env node
/** Deterministic fake-RPC comparison. No endpoint, signer, or network import is used. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { demoObservations } from '../../src/viero/fixtures/demo.js';
import { readDepthTicks, readToken } from '../../src/viero/adapters/pools.js';
import { BlockBoundaryCache, ObservationRpcMemo, exactPoolCreatedEvidence, firstBlockAt, pagedLogs } from '../../src/viero/adapters/events.js';
import { EvidenceCache } from '../../src/viero/storage/evidenceCache.js';
import { RpcTelemetry } from '../../src/viero/observability/rpcTelemetry.js';
import { screen } from '../../src/viero/screening/pipeline.js';
import { DEFAULT_POLICY } from '../../src/viero/config/policy.js';
import { poolIdentity } from '../../src/viero/domain.js';

const CU: Record<string, number> = { eth_call: 26, eth_getBlockByNumber: 20, eth_getCode: 20,
  eth_getLogs: 60, eth_getTransactionByHash: 20 };
const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const robinhoodV4 = demoObservations().find(item => item.state.pool.chainId === 4663 && item.state.pool.protocol === 'v4')!.state;
const bnbV3 = demoObservations().find(item => item.state.pool.chainId === 56 && item.state.pool.protocol === 'v3')!.state;

async function run(optimized: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'viero-rpc-final-'));
  const counts: Record<string, number> = {}, telemetry = new RpcTelemetry('autonomous-offline');
  const start = performance.now(); let resultKey = '', boundaryEntries = 0, memoEntries = 0, evidenceBytes = 0;
  const cache = optimized ? new EvidenceCache(join(root, 'evidence.json'), telemetry) : undefined;
  const count = (method: string) => { counts[method] = (counts[method] ?? 0) + 1; };
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      count('eth_getBlockByNumber'); return { timestamp: blockNumber * 10n, hash: hash(blockNumber) };
    },
    getBytecode: async ({ blockNumber }: { blockNumber: bigint }) => {
      count('eth_getCode'); return blockNumber >= 90n ? '0x6001' : '0x';
    },
    readContract: async (args: any) => {
      count('eth_call');
      if (args.functionName === 'decimals') return 6;
      if (args.functionName === 'symbol') return 'TEST';
      if (args.functionName === 'getSlot0') return [args.blockNumber >= 90n ? 1n : 0n, 0, 0, 3000];
      if (args.functionName === 'getTickBitmap' || args.functionName === 'tickBitmap') return args.args.at(-1) === 0 ? 1n : 0n;
      if (args.functionName === 'getTickLiquidity' || args.functionName === 'ticks') return [1n, 5n];
      throw new Error(`BENCHMARK_UNEXPECTED_CALL:${args.functionName}`);
    },
    getTransaction: async ({ hash: txHash }: { hash: Hex }) => {
      count('eth_getTransactionByHash'); return { hash: txHash, from: bnbV3.token0.address, blockHash: hash(100n) };
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      count('eth_getLogs');
      if (toBlock - fromBlock > 1n) throw new Error('block range too large');
      return Array.from({ length: Number(toBlock - fromBlock + 1n) }, (_, i) => Number(fromBlock) + i);
    },
  } as never;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const boundaryCache = optimized ? new BlockBoundaryCache(8) : undefined;
      for (const source of [bnbV3, robinhoodV4]) {
        const state = { ...source, blockNumber: 128n, blockHash: hash(128n) };
        const chain = state.pool.chainId, bytecodeHash = keccak256('0x6001');
        // Fresh code identity is checked in both paths; only verified decimals/symbol are reusable.
        const tokens = await Promise.all([state.token0, state.token1].map(async token => {
          await (client as any).getBytecode({ blockNumber: 128n, address: token.address });
          return readToken(client, chain, token.address, 128n, optimized ? bytecodeHash : undefined,
            cache ?? new EvidenceCache(join(root, `uncached-${cycle}-${chain}-${token.address}.json`), telemetry), state.blockHash);
        }));
        const created = await exactPoolCreatedEvidence(client, state, cache);
        const boundaryA = boundaryCache ? await boundaryCache.get(client, chain, 128n, state.blockHash, 500)
          : await firstBlockAt(client, 128n, 500);
        const boundaryB = boundaryCache ? await boundaryCache.get(client, chain, 128n, state.blockHash, 500)
          : await firstBlockAt(client, 128n, 500);
        const memo = optimized ? new ObservationRpcMemo(telemetry, 8) : undefined;
        const readHistorical = async (kind: 'block' | 'state' | 'transaction', key: string, read: () => Promise<any>) =>
          memo ? memo.read(kind, key, read) : read();
        const eventBlock = await readHistorical('block', `block:${chain}:100:${hash(100n)}`, () => (client as any).getBlock({ blockNumber: 100n }));
        const repeatedBlock = await readHistorical('block', `block:${chain}:100:${hash(100n)}`, () => (client as any).getBlock({ blockNumber: 100n }));
        const historicalState = await readHistorical('state', `state:${chain}:${state.pool.protocol}:100:${hash(100n)}`,
          () => (client as any).readContract({ functionName: 'getSlot0', blockNumber: 100n }));
        const repeatedState = await readHistorical('state', `state:${chain}:${state.pool.protocol}:100:${hash(100n)}`,
          () => (client as any).readContract({ functionName: 'getSlot0', blockNumber: 100n }));
        const transaction = await readHistorical('transaction', `tx:${chain}:${hash(7n)}:${hash(100n)}`,
          () => (client as any).getTransaction({ hash: hash(7n) }));
        const repeatedTransaction = await readHistorical('transaction', `tx:${chain}:${hash(7n)}:${hash(100n)}`,
          () => (client as any).getTransaction({ hash: hash(7n) }));
        const logs = await pagedLogs(0n, 7n, (fromBlock, toBlock) => (client as any).getLogs({ fromBlock, toBlock }), 8n, 100,
          { chainId: chain, telemetry });
        const depth = await readDepthTicks(client, state);
        const screeningObservation = demoObservations().find(item => poolIdentity(item.state.pool) === poolIdentity(state.pool))!;
        const candidate = screen(screeningObservation, DEFAULT_POLICY, screeningObservation.state.observedAt);
        resultKey += JSON.stringify({ chain, tokens, created: created?.blockNumber.toString(), boundaryA: boundaryA.toString(),
          boundaryB: boundaryB.toString(), eventBlock, repeatedBlock, historicalState: historicalState.map(String),
          repeatedState: repeatedState.map(String), transaction, repeatedTransaction, logs, depth, approved: candidate.approved,
          rejections: candidate.rejections.map(item => item.code) }, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
        boundaryEntries = Math.max(boundaryEntries, boundaryCache?.size() ?? 0);
        memoEntries = Math.max(memoEntries, memo?.size() ?? 0);
      }
    }
    if (cache) evidenceBytes = (await readFile(cache.file)).byteLength;
    const logical = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return { logical, simulatedPhysical: logical, methods: counts, estimatedCU: Object.entries(counts).reduce((sum, [method, n]) => sum + (CU[method] ?? 0) * n, 0),
      retryAttempts: 0, elapsedMs: Math.round((performance.now() - start) * 100) / 100,
      cache: telemetry.snapshot().cache, memo: telemetry.snapshot().historicalMemo, pagination: telemetry.snapshot().pagination,
      boundaryEntries, memoEntries, evidenceBytes, resultDigest: keccak256(new TextEncoder().encode(resultKey)) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const baseline = await run(false), optimized = await run(true);
if (baseline.resultDigest !== optimized.resultDigest) throw new Error('RPC_BENCHMARK_CORRECTNESS_MISMATCH');
console.log(JSON.stringify({ fixture: 'two synthetic pinned pools, two cycles, repeated equivalent historical reads',
  baseline, optimized, avoidedLogical: baseline.logical - optimized.logical,
  avoidedEstimatedCU: baseline.estimatedCU - optimized.estimatedCU,
  correctnessDifferences: 0, caveat: 'Simulated transport counts and method-weighted CU only; not Alchemy billing or full autonomous runtime.' }, null, 2));
