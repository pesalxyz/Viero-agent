import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EvidenceCache } from '../src/viero/storage/evidenceCache.js';
import { RpcTelemetry } from '../src/viero/observability/rpcTelemetry.js';
import { exactPoolCreatedEvidence } from '../src/viero/adapters/events.js';
import { BlockBoundaryCache, firstBlockAt, ObservationRpcMemo, pagedLogs } from '../src/viero/adapters/events.js';
import { dexScreenerShortlist } from '../src/viero/adapters/targetedPoolDiscovery.js';
import { demoObservations } from '../src/viero/fixtures/demo.js';
import { PublicClients } from '../src/viero/clients/publicClients.js';

const HASH_A = `0x${'aa'.repeat(32)}`;
const HASH_B = `0x${'bb'.repeat(32)}`;

async function tempCache() {
  const dir = await mkdtemp(join(tmpdir(), 'viero-rpc-phase1-'));
  return { dir, file: join(dir, 'evidence.json') };
}

test('token metadata cache persists, hits, and invalidates on bytecode identity mismatch', async () => {
  const { dir, file } = await tempCache();
  try {
    const telemetry = new RpcTelemetry('test');
    const cache = new EvidenceCache(file, telemetry);
    const item = { chainId: 4663, address: '0x0000000000000000000000000000000000000001', bytecodeHash: HASH_A, decimals: 6, symbol: 'USDG', verifiedAtBlock: '10', verifiedAtBlockHash: HASH_A };
    assert.equal(await cache.token(item.chainId, item.address, HASH_A, 10n, HASH_A), null);
    await cache.putToken(item);
    assert.deepEqual(await cache.token(item.chainId, item.address, HASH_A, 11n, HASH_B), item);
    const reopened = new EvidenceCache(file, telemetry);
    assert.deepEqual(await reopened.token(item.chainId, item.address, HASH_A, 11n, HASH_B), item);
    assert.equal(await reopened.token(item.chainId, item.address, HASH_B, 11n, HASH_B), null);
    assert.equal(telemetry.snapshot().cache.tokenMisses, 1);
    assert.equal(telemetry.snapshot().cache.tokenHits, 2);
    assert.equal(telemetry.snapshot().cache.tokenInvalidations, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pool creation evidence is reused only while the canonical creation hash matches', async () => {
  const { dir, file } = await tempCache();
  try {
    const state = demoObservations()[0]!.state;
    let bytecodeReads = 0;
    const rpc = {
      getBytecode: async ({ blockNumber }: { blockNumber: bigint }) => { bytecodeReads++; return blockNumber >= 90n ? '0x6001' : '0x'; },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_000n + blockNumber, hash: HASH_A }),
    } as never;
    const telemetry = new RpcTelemetry('test');
    const cache = new EvidenceCache(file, telemetry);
    const pinnedState = { ...state, blockNumber: 100n, blockHash: HASH_A as `0x${string}` };
    const first = await exactPoolCreatedEvidence(rpc, pinnedState, cache);
    assert.equal(first?.blockNumber, 90n);
    const readsAfterMiss = bytecodeReads;
    const second = await exactPoolCreatedEvidence(rpc, pinnedState, cache);
    assert.equal(second?.blockNumber, 90n);
    assert.equal(bytecodeReads, readsAfterMiss);
    const reorgRpc = { ...rpc, getBlock: async () => ({ timestamp: 1_090n, hash: HASH_B }) } as never;
    const recomputed = await exactPoolCreatedEvidence(reorgRpc, pinnedState, cache);
    assert.equal(recomputed?.blockNumber, 90n);
    assert.equal(telemetry.snapshot().cache.creationHits, 1);
    assert.equal(telemetry.snapshot().cache.creationInvalidations, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt or missing evidence cache fails closed and concurrent writes remain readable', async () => {
  const { dir, file } = await tempCache();
  try {
    await writeFile(file, '{not-json', 'utf8');
    const cache = new EvidenceCache(file);
    const items = Array.from({ length: 8 }, (_, i) => ({ chainId: 4663, address: `0x${(i + 10).toString(16).padStart(40, '0')}`, bytecodeHash: HASH_A, decimals: 6, symbol: `T${i}`, verifiedAtBlock: '1', verifiedAtBlockHash: HASH_A }));
    await Promise.all(items.map(item => cache.putToken(item)));
    for (const item of items) assert.equal((await cache.token(item.chainId, item.address, HASH_A, 1n, HASH_A))?.symbol, item.symbol);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('production evidence cache uses the explicit writable state path, never release cwd', async () => {
  const { dir, file } = await tempCache();
  const prior = process.env.VIERO_EVIDENCE_CACHE_FILE;
  try {
    process.env.VIERO_EVIDENCE_CACHE_FILE = file;
    const cache = new EvidenceCache();
    assert.equal(cache.file, file);
    await cache.putToken({ chainId: 4663, address: '0x0000000000000000000000000000000000000002', bytecodeHash: HASH_A, decimals: 18, symbol: 'PONS', verifiedAtBlock: '1', verifiedAtBlockHash: HASH_A });
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(file, 'utf8'), /PONS/);
  } finally {
    if (prior === undefined) delete process.env.VIERO_EVIDENCE_CACHE_FILE;
    else process.env.VIERO_EVIDENCE_CACHE_FILE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test('production evidence cache fails closed when its path is not configured', () => {
  const priorNode = process.env.NODE_ENV;
  const priorCache = process.env.VIERO_EVIDENCE_CACHE_FILE;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.VIERO_EVIDENCE_CACHE_FILE;
    assert.throws(() => new EvidenceCache(), /VIERO_EVIDENCE_CACHE_FILE_REQUIRED/);
  } finally {
    if (priorNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNode;
    if (priorCache === undefined) delete process.env.VIERO_EVIDENCE_CACHE_FILE;
    else process.env.VIERO_EVIDENCE_CACHE_FILE = priorCache;
  }
});

test('RPC telemetry is bounded, records workflow/caches, and never changes caller behavior', async () => {
  const telemetry = new RpcTelemetry('autonomous-test', 64);
  await telemetry.run('candidate-observation', async () => {
    telemetry.logical(4663, 'eth_call');
    telemetry.physical(4663, undefined, true, 12, 'eth_call');
    telemetry.retry(4663, 'eth_call');
    telemetry.physicalResult(4663, undefined, false, 4, 'eth_call');
  });
  telemetry.candidateObserved();
  telemetry.managementTick(2);
  telemetry.cache('token', 'hit');
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.observations.candidateObservations, 1);
  assert.equal(snapshot.observations.managementTicks, 1);
  assert.equal(snapshot.observations.openPositionsLast, 2);
  assert.deepEqual(snapshot.operations[0], { role: 'autonomous-test', workflow: 'candidate-observation', chainId: 4663, method: 'eth_call', logical: 1, physical: 1, retries: 1, fallbackAttempts: 1, latencyMs: 16, errors: 1 });
  assert.equal(snapshot.cache.tokenHits, 1);
});

test('concurrent per-pool scopes remain isolated for 28 verification attempts', async () => {
  const telemetry = new RpcTelemetry('agent-test');
  await Promise.all(Array.from({ length: 28 }, (_, i) => telemetry.scope({ workflow: 'multi-pool-verification', cycleId: 'cycle-28', candidateToken: '0x' + '11'.repeat(20), poolIdentity: `pool-${i}` }, async () => {
    await new Promise(resolve => setTimeout(resolve, i % 3));
    telemetry.logical(4663, 'eth_call'); telemetry.physical(4663, undefined, true, 1, 'eth_call');
  })));
  const rows = telemetry.snapshot().scopes.filter(row => row.workflow === 'multi-pool-verification');
  assert.equal(rows.length, 28);
  assert.equal(new Set(rows.map(row => row.poolIdentity)).size, 28);
  assert.ok(rows.every(row => row.logical === 1 && row.physical === 1 && row.cycleId === 'cycle-28'));
});

test('physical HTTP envelopes distinguish batches without changing RPC results', async () => {
  const telemetry = new RpcTelemetry('agent-test');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Array<{ id: number; method: string }> | { id: number; method: string };
    const items = Array.isArray(body) ? body : [body];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(items.map(item => ({ jsonrpc: '2.0', id: item.id, result: item.method === 'eth_blockNumber' ? '0x2' : '0x1' }))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const clients = new PublicClients({ VIERO_RPC_4663: `http://127.0.0.1:${address.port}` }, telemetry);
    await telemetry.run('selected-pool-fresh-verification', async () => {
      const client = clients.get(4663);
      await Promise.all([client.getBlockNumber(), client.getGasPrice()]);
    }, { cycleId: 'batch-cycle', candidateToken: '0x' + '22'.repeat(20), poolIdentity: 'pool-batch' });
    const snapshot = telemetry.snapshot();
    assert.ok(snapshot.transport.httpAttempts >= 1);
    assert.ok(snapshot.transport.methodAttempts >= 2);
    assert.ok(snapshot.operations.some(row => row.method === 'eth_blockNumber' && row.logical === 1));
    assert.ok(snapshot.operations.some(row => row.method === 'eth_gasPrice' && row.logical === 1));
    assert.ok(snapshot.scopes.some(row => row.poolIdentity === 'pool-batch' && row.method === 'eth_blockNumber'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('telemetry persists bounded daily aggregates and redacts payloads', async () => {
  const { dir, file } = await tempCache();
  try {
    const telemetry = new RpcTelemetry('agent-test', 64, { file, flushMs: 100 });
    await telemetry.run('v4-pool-key-recovery', async () => { telemetry.logical(4663, 'eth_call'); telemetry.physical(4663, undefined, true, 2, 'eth_call'); }, { cycleId: 'persist-cycle', candidateToken: '0x' + '33'.repeat(20), poolIdentity: 'pool-persist' });
    await telemetry.flush();
    const persisted = await RpcTelemetry.readPersisted(file);
    assert.ok(persisted);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(persisted?.days[today]?.scopes[0]?.poolIdentity, 'pool-persist');
    const raw = JSON.stringify(persisted);
    assert.doesNotMatch(raw, /Authorization|api[_-]?key|private[_-]?key|0x[0-9a-f]{64}/i);
    const reopened = new RpcTelemetry('agent-test', 64, { file });
    await reopened.ready();
    assert.equal(reopened.snapshot().persistence?.restored, true);
    assert.equal(reopened.snapshot().scopes[0]?.physical, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cycle block-boundary cache hits only for the same pinned head identity and window', async () => {
  let calls = 0;
  const rpc = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { calls++; return { timestamp: blockNumber / 3n }; } } as never;
  const cache = new BlockBoundaryCache();
  assert.equal(await cache.get(rpc, 56, 300n, HASH_A, 20), await firstBlockAt(rpc, 300n, 20));
  const afterFirst = calls;
  assert.equal(await cache.get(rpc, 56, 300n, HASH_A, 20), 60n);
  assert.equal(calls, afterFirst);
  assert.equal(await cache.get(rpc, 56, 300n, HASH_B, 20), 60n);
  assert.ok(calls > afterFirst);
  assert.equal(cache.size(), 2);
});

test('paged log telemetry records splits while preserving complete recovery', async () => {
  const telemetry = new RpcTelemetry('test');
  const rows = await pagedLogs(0n, 7n, async (from, to) => {
    if (to - from > 1n) throw new Error('block range too large');
    return Array.from({ length: Number(to - from + 1n) }, (_, i) => Number(from) + i);
  }, 8n, 100, { chainId: 4663, telemetry });
  assert.deepEqual(rows, [0, 1, 2, 3, 4, 5, 6, 7]);
  const stats = telemetry.snapshot().pagination;
  assert.equal(stats.ranges.length, 1);
  assert.equal(stats.logsReturned, 8);
  assert.ok(stats.splits > 0);
  assert.ok(stats.errors > 0);
});

test('missing advisory DEX fields are retained for canonical RPC verification', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'],
    baseToken: { address: '0x1111111111111111111111111111111111111111' },
    quoteToken: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
    pairAddress: '0x0000000000000000000000000000000000000002',
  }]))) as typeof fetch;
  try {
    const result = await dexScreenerShortlist(4663, '0x1111111111111111111111111111111111111111');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.hints.length, 1);
    assert.ok(result.hints[0]!.advisoryIssues?.includes('LIQUIDITY_UNAVAILABLE'));
    assert.ok(result.hints[0]!.advisoryIssues?.includes('CREATION_TIME_UNAVAILABLE'));
  } finally { globalThis.fetch = originalFetch; }
});

test('observation-local historical memo deduplicates equivalent concurrent reads and preserves distinct identities', async () => {
  const telemetry = new RpcTelemetry('phase3a');
  const memo = new ObservationRpcMemo(telemetry, 8);
  let blockReads = 0, stateReads = 0, txReads = 0;
  const blockKey = `block:4663:100:${HASH_A}`;
  const stateKey = `state:4663:0x0000000000000000000000000000000000000001:slot0:99:${HASH_A}`;
  const txKey = `tx:4663:0x${'11'.repeat(32)}:${HASH_A}`;
  const [a, b] = await Promise.all([
    memo.read('block', blockKey, async () => { blockReads++; await new Promise(resolve => setTimeout(resolve, 1)); return { timestamp: 100n, hash: HASH_A }; }),
    memo.read('block', blockKey, async () => { blockReads++; return { timestamp: 100n, hash: HASH_A }; }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(blockReads, 1);
  await memo.read('state', stateKey, async () => { stateReads++; return [1n, 2n]; });
  await memo.read('state', `${stateKey}:different`, async () => { stateReads++; return [3n, 4n]; });
  await memo.read('transaction', txKey, async () => { txReads++; return { from: '0x0000000000000000000000000000000000000002', blockHash: HASH_A }; });
  await memo.read('transaction', txKey, async () => { txReads++; return { from: '0x0000000000000000000000000000000000000002', blockHash: HASH_A }; });
  const stats = telemetry.snapshot().historicalMemo;
  assert.equal(stateReads, 2);
  assert.equal(txReads, 1);
  assert.equal(stats.blockHits, 1);
  assert.equal(stats.stateHits, 0);
  assert.equal(stats.transactionHits, 1);
  assert.equal(stats.logicalReadsAvoided, 2);
});

test('historical memo does not cache failures, evicts at capacity, and invalidates on reorg evidence', async () => {
  const telemetry = new RpcTelemetry('phase3a');
  const memo = new ObservationRpcMemo(telemetry, 2);
  let failures = 0;
  await assert.rejects(memo.read('block', 'block:1', async () => { failures++; throw new Error('provider timeout'); }), /provider timeout/);
  await assert.rejects(memo.read('block', 'block:1', async () => { failures++; throw new Error('provider timeout'); }), /provider timeout/);
  assert.equal(failures, 2);
  await memo.read('block', 'block:2', async () => 2);
  await memo.read('state', 'state:3', async () => 3);
  await memo.read('transaction', 'tx:4', async () => 4);
  assert.equal(memo.size(), 2);
  memo.invalidate('state:3');
  assert.equal(telemetry.snapshot().historicalMemo.invalidations, 1);
  assert.ok(telemetry.snapshot().historicalMemo.evictions >= 1);
});
