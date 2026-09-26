import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { type PublicClient } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_POLICY as policy } from '../src/viero/config/policy.js';
import { CHAINS } from '../src/viero/config/chains.js';
import { errorMessage, json, poolIdentity, type ChainId } from '../src/viero/domain.js';
import { demoObservations, DEMO_TIME as now } from '../src/viero/fixtures/demo.js';
import { verifyPool } from '../src/viero/adapters/pools.js';
import { pagedLogs, firstBlockAt } from '../src/viero/adapters/events.js';
import { PublicClients } from '../src/viero/clients/publicClients.js';
import { Providers, Gmgn, normalizeGmgnPrice, normalizeGmgnRisk } from '../src/viero/adapters/providers.js';
import { Indexer } from '../src/viero/adapters/indexer.js';
import { FileRepository, PostgresRepository } from '../src/viero/storage/repositories.js';
import { Agent } from '../src/viero/workers/screeningWorker.js';
import { deploymentPreflight } from '../src/viero/operations/preflight.js';
import { INDEX_BLOCK_CHUNK_SIZE, ProtocolPoolIndex } from '../src/viero/indexer/protocol.js';
import { TelegramBot, chunkTelegramText, telegramConfigFromEnv } from '../src/viero/telegram.js';

function mockRpc(index: number, overrides: Record<string, unknown> = {}) {
  const o = demoObservations()[index]!, state = o.state;
  const calls: Array<{ address: string; functionName: string; blockNumber: bigint }> = [];
  const rpc = {
    getChainId: async () => state.pool.chainId,
    getBlockNumber: async () => state.blockNumber,
    getBlock: async () => ({ hash: state.blockHash, timestamp: BigInt(now) }),
    getBytecode: async () => '0x60016000',
    readContract: async (args: { address: string; functionName: string; blockNumber: bigint }) => {
      calls.push(args);
      switch (args.functionName) {
        case 'token0': return state.token0.address;
        case 'token1': return state.token1.address;
        case 'fee': return state.fee;
        case 'tickSpacing': return state.tickSpacing;
        case 'getPool': return state.pool.protocol === 'v3' ? state.pool.poolAddress : null;
        case 'slot0': return [state.sqrtPriceX96, state.tick, 0, 0, 0, 0, true];
        case 'getSlot0': return [state.sqrtPriceX96, state.tick, 0, state.fee];
        case 'liquidity': case 'getLiquidity': return state.liquidity;
        case 'decimals': return state.token0.decimals;
        case 'symbol': return 'SYMBOL';
        default: throw new Error(`Unexpected read ${args.functionName}`);
      }
    }, ...overrides,
  } as unknown as PublicClient;
  return { rpc, calls, state };
}
test('verifier checks every supported venue against its own pinned contracts', async () => {
  for (let i = 0; i < 9; i++) {
    const { rpc, calls, state } = mockRpc(i);
    const verified = await verifyPool(rpc, state.pool, state.blockNumber);
    assert.equal(verified.verified, true);
    assert.ok(calls.every(c => c.blockNumber === state.blockNumber));
    if (state.pool.protocol === 'v3') assert.equal(calls.find(c => c.functionName === 'getPool')!.address, CHAINS[state.pool.chainId].v3[state.pool.dex]!.factory);
    else assert.equal(calls.find(c => c.functionName === 'getSlot0')!.address, CHAINS[state.pool.chainId].v4.stateView);
  }
});
test('wrong RPC chain and missing deployment bytecode fail verification', async () => {
  const wrong = mockRpc(0, { getChainId: async () => 1 });
  await assert.rejects(verifyPool(wrong.rpc, wrong.state.pool), /CHAIN_MISMATCH/);
  const empty = mockRpc(0, { getBytecode: async () => '0x' });
  await assert.rejects(verifyPool(empty.rpc, empty.state.pool), /BYTECODE/);
});
test('factory impersonation and v4 PoolId mismatches fail verification', async () => {
  const mock = mockRpc(0), read = mock.rpc.readContract;
  const rpc = { ...mock.rpc, readContract: (args: { functionName: string }) => args.functionName === 'getPool' ? Promise.resolve('0x0000000000000000000000000000000000000999') : read(args as never) } as PublicClient;
  await assert.rejects(verifyPool(rpc, mock.state.pool), /FACTORY_POOL_MISMATCH/);
  const v4 = mockRpc(1);
  if (v4.state.pool.protocol !== 'v4') throw new Error('fixture');
  v4.state.pool.poolId = `0x${'11'.repeat(32)}`;
  await assert.rejects(verifyPool(v4.rpc, v4.state.pool), /POOL_ID_MISMATCH/);
});
test('public client caches are isolated by chain and endpoint', () => {
  const env: NodeJS.ProcessEnv = { VIERO_RPC_56: 'http://localhost:45678', VIERO_RPC_8453: 'http://localhost:45680' }, clients = new PublicClients(env);
  assert.equal(clients.get(56), clients.get(56)); assert.notEqual(clients.get(56), clients.get(8453));
  const old = clients.get(56); env.VIERO_RPC_56 = 'http://localhost:45678, http://localhost:45679'; assert.notEqual(old, clients.get(56));
  assert.equal(clients.get(56), clients.get(56));
  env.VIERO_RPC_56 = ' , ';
  assert.throws(() => clients.get(56), /NO_RPC_ENDPOINTS/);
});
test('log pagination handles capped pages without gaps or duplicate boundary blocks', async () => {
  const read = async (from: bigint, to: bigint) => Array.from({ length: Number(to - from + 1n) }, (_, i) => Number(from) + i).slice(0, 4);
  assert.deepEqual(await pagedLogs(0n, 20n, read, 10n, 4), Array.from({ length: 21 }, (_, i) => i));
  await assert.rejects(pagedLogs(0n, 0n, async () => [1, 2], 1n, 2), /ROW_CAP/);
});
test('block search handles repeated sub-second chain timestamps', async () => {
  const rpc = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber / 3n }) } as unknown as PublicClient;
  assert.equal(await firstBlockAt(rpc, 300n, 20), 60n);
});
test('provider failure backoff and concurrent deduplication preserve chain isolation', async () => {
  const providers = new Providers(); let calls = 0;
  const fn = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return 7; };
  assert.deepEqual(await Promise.all([providers.run(56, 'test', 'key', fn), providers.run(56, 'test', 'key', fn)]), [7, 7]);
  assert.equal(calls, 1); await providers.run(8453, 'test', 'key', fn); assert.equal(calls, 2);
  await assert.rejects(providers.run(56, 'test', 'bad', async () => { throw new Error('rate limited'); }));
  await assert.rejects(providers.run(56, 'test', 'next', fn), /backoff/);
  assert.equal(providers.health.get('8453:test')!.consecutiveFailures, 0);
});

test('provider observation retention can be bounded or disabled', async () => {
  const bounded = new Providers(2);
  await bounded.run(56, 'fixture', '1', async () => ({ value: 1 }));
  await bounded.run(56, 'fixture', '2', async () => ({ value: 2 }));
  await bounded.run(56, 'fixture', '3', async () => ({ value: 3 }));
  assert.equal(bounded.observations.length, 2);
  assert.deepEqual(bounded.observations.map(o => o.payload), [{ value: 2 }, { value: 3 }]);

  const disabled = new Providers(0);
  await disabled.run(56, 'fixture', '1', async () => ({ value: 1 }));
  assert.equal(disabled.observations.length, 0);
});
test('GMGN normalizes every chain and rejects shell-shaped addresses', async () => {
  class FixtureProvider extends Providers {
    calls: Array<{ chainId: ChainId; key: string }> = [];
    override async run<T>(chainId: ChainId, _provider: string, key: string): Promise<T> {
      this.calls.push({ chainId, key });
      return { data: { rank: [{ address: '0x0000000000000000000000000000000000000001' }] } } as T;
    }
  }
  const providers = new FixtureProvider(), gmgn = new Gmgn(providers);
  for (const chainId of [4663, 56, 8453, 5042] as const) {
    assert.equal((await gmgn.trending(chainId)).length, 1);
    assert.ok(providers.calls.at(-1)!.key.includes(`--chain:${CHAINS[chainId].sources.gmgn}:`));
  }
  await assert.rejects(gmgn.query(56, 'info', { token: '0x;$(touch /tmp/no)' as never }));
  assert.equal(providers.calls.length, 4);
});
test('GMGN security normalization preserves unknown simulation evidence', () => {
  const token = '0x0000000000000000000000000000000000000001';
  const risk = normalizeGmgnRisk({ address: token, is_honeypot: null, honeypot: -1, sell_tax: '0.01', top_10_holder_rate: '0.2859',
    is_open_source: true, flags: [], privileges: [] }, 8453, token, now);
  assert.equal(risk.honeypot, null); assert.equal(risk.sellTaxBps, 100); assert.equal(risk.top10HolderPct, 28.59);
  assert.equal(risk.criticalAdmin, false); assert.equal(risk.buySimulation, null); assert.equal(risk.sellSimulation, null);
  assert.throws(() => normalizeGmgnRisk({ address: '0x0000000000000000000000000000000000000002' }, 8453, token, now), /MISMATCH/);
});
test('GMGN token info normalization reads the nested canonical price', () => {
  const token = '0x0000000000000000000000000000000000000001';
  const price = normalizeGmgnPrice({ data: { address: token, price: { price: '1.2345' } } }, 8453, token, now);
  assert.equal(price.usd, 1.2345); assert.equal(price.source, 'gmgn');
  assert.throws(() => normalizeGmgnPrice({ data: { address: token, price: { price: '0' } } }, 8453, token, now));
});
test('validation errors retain a useful issue without leaking raw payloads', () => {
  let error: unknown;
  try { normalizeGmgnRisk([], 5042, '0x0000000000000000000000000000000000000001', now); } catch (caught) { error = caught; }
  assert.match(errorMessage(error), /^Validation failed: Expected object, received array/);
  assert.doesNotMatch(errorMessage(error), /^\[$/);
});
test('deployment preflight enforces read-only secrets and all selected providers', async () => {
  const smokeCalls: ChainId[] = [], gmgnCalls: ChainId[] = [];
  const result = await deploymentPreflight({ chains: [56, 8453], env: { GMGN_API_KEY: 'configured' }, nodeVersion: '22.18.0',
    smoke: async chainId => { smokeCalls.push(chainId); return { ok: true, blockNumber: 123n, checks: [{ ok: true }] }; },
    gmgn: async chainId => { gmgnCalls.push(chainId); return ['token']; } });
  assert.equal(result.ok, true); assert.equal(result.readOnly, true);
  assert.deepEqual(smokeCalls, [56, 8453]); assert.deepEqual(gmgnCalls, [56, 8453]);

  const unsafe = await deploymentPreflight({ chains: [56], env: { GMGN_API_KEY: 'configured', EVM_PRIVATE_KEY: 'must-not-be-loaded' }, nodeVersion: '18.0.0',
    smoke: async () => ({ ok: true, checks: [{ ok: true }] }), gmgn: async () => ['token'] });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.checks.find(check => check.name === 'read-only-environment')!.detail, /EVM_PRIVATE_KEY/);
  assert.equal(JSON.stringify(unsafe).includes('must-not-be-loaded'), false);
});

test('deployment preflight skips GMGN entirely when VIERO_SKIP_GMGN_PREFLIGHT=1 (Telegram path)', async () => {
  // The Telegram unit sets VIERO_SKIP_GMGN_PREFLIGHT=1 unconditionally so
  // the operator/report surface never triggers GMGN discovery or
  // authenticated GMGN calls at startup.
  const smokeCalls: ChainId[] = [], gmgnCalls: ChainId[] = [];
  const result = await deploymentPreflight({
    chains: [56, 8453, 5042],
    env: { GMGN_API_KEY: 'should-not-be-used', VIERO_SKIP_GMGN_PREFLIGHT: '1' },
    nodeVersion: '22.18.0',
    smoke: async chainId => { smokeCalls.push(chainId); return { ok: true, blockNumber: 123n, checks: [{ ok: true }] }; },
    gmgn: async chainId => { gmgnCalls.push(chainId); return ['token']; },
  });
  // Smoke (RPC) checks still run.
  assert.deepEqual(smokeCalls, [56, 8453, 5042]);
  // GMGN trending calls do NOT run.
  assert.equal(gmgnCalls.length, 0);
  // The preflight result still succeeds because every check that DID run is ok.
  assert.equal(result.ok, true);
  // A single explicit skip entry is recorded.
  const skip = result.checks.find(c => c.name === 'gmgn-discovery-skipped');
  assert.ok(skip);
  assert.equal(skip.ok, true);
  assert.match(skip.detail, /VIERO_SKIP_GMGN_PREFLIGHT/);
  // No GMGN_API_KEY check or per-chain gmgn-* entries when skip is set.
  // (The skip entry itself starts with 'gmgn-' by design — exclude it.)
  assert.equal(result.checks.find(c => c.name === 'gmgn-credential'), undefined);
  assert.equal(
    result.checks.filter(c => c.name.startsWith('gmgn-') && c.name !== 'gmgn-discovery-skipped').length,
    0,
  );
});

test('deployment preflight still runs GMGN when VIERO_SKIP_GMGN_PREFLIGHT is unset or anything other than "1"', async () => {
  const gmgnCalls: ChainId[] = [];
  // Unset
  await deploymentPreflight({
    chains: [8453],
    env: { GMGN_API_KEY: 'configured' },
    nodeVersion: '22.18.0',
    smoke: async () => ({ ok: true, blockNumber: 123n, checks: [{ ok: true }] }),
    gmgn: async chainId => { gmgnCalls.push(chainId); return ['token']; },
  });
  assert.deepEqual(gmgnCalls, [8453]);
  // Wrong value (not '1')
  gmgnCalls.length = 0;
  await deploymentPreflight({
    chains: [8453],
    env: { GMGN_API_KEY: 'configured', VIERO_SKIP_GMGN_PREFLIGHT: 'true' }, // wrong value, must equal '1'
    nodeVersion: '22.18.0',
    smoke: async () => ({ ok: true, blockNumber: 123n, checks: [{ ok: true }] }),
    gmgn: async chainId => { gmgnCalls.push(chainId); return ['token']; },
  });
  assert.deepEqual(gmgnCalls, [8453]);
});
test('telegram bot enforces allowlist and updates pause controls', async () => {
  const sent: string[] = [];
  const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.text) sent.push(body.text);
    return { ok: true, json: async () => ({ ok: true, result: true }) } as Response;
  };
  const controls = { globalPaused: false, pausedChains: [] as ChainId[] };
  const repo = {
    latest: async () => null,
    controls: async () => controls,
    setControls: async (next: typeof controls) => { controls.globalPaused = next.globalPaused; controls.pausedChains = next.pausedChains; },
  } as unknown as FileRepository;
  const bot = new TelegramBot({ token: '12345678901234567890', allowedUserIds: new Set([7]), agent: {} as Agent,
    repo, chains: [56], tokenLimit: 1, poolLimit: 1, intervalSeconds: 60, fetch: fetchMock });
  await bot.handleMessage({ message_id: 1, from: { id: 8 }, chat: { id: 100 }, text: '/report' });
  await bot.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: 100 }, text: '/pause 56,8453' });
  assert.equal(sent[0], 'Unauthorized.');
  assert.equal(controls.globalPaused, false);
  assert.deepEqual(controls.pausedChains, [56, 8453]);
  assert.match(sent.at(-1)!, /pausedChains=56,8453/);
  assert.deepEqual(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: '12345678901234567890', TELEGRAM_USER_IDS: '7,8' }).allowedUserIds, new Set([7, 8]));
  assert.equal(chunkTelegramText('a'.repeat(8000)).length, 3);
});
test('indexer paginates and rejects a stuck cursor via a real HTTP fixture', async () => {
  const observations = demoObservations().filter(o => o.state.pool.chainId === 56);
  let stuck = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const page = Number(url.searchParams.get('cursor') ?? 0);
    res.setHeader('content-type', 'application/json');
    res.end(json({ chainId: 56, pools: [observations[Math.min(page, 2)]!.state.pool], complete: true, nextCursor: stuck ? '1' : page < 2 ? String(page + 1) : null }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listener');
  try {
    const indexer = new Indexer(new Providers(), { VIERO_INDEXER_56: `http://127.0.0.1:${address.port}` });
    assert.equal((await indexer.discover(56)).length, 3); stuck = true;
    await assert.rejects(indexer.discover(56), /CURSOR/);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('protocol index checkpoints survive restart and reject a changed block hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-index-')), file = join(dir, '8453.json');
  const hash = `0x${'1'.padStart(64, '0')}` as const;
  const rpc = { getLogs: async (args: { fromBlock: bigint }) => {
    if (args.fromBlock >= 1_000_005n) throw new Error('fixture interruption');
    return [];
  }, getBlock: async () => ({ hash }) } as unknown as PublicClient;
  try {
    const first = new ProtocolPoolIndex(8453, 5n, file);
    await assert.rejects(first.sync(rpc, 2_000_010n), /fixture interruption/);
    const restored = new ProtocolPoolIndex(8453, 5n, file);
    await restored.load();
    const snapshot = restored.snapshot();
    assert.equal(snapshot.indexedBlock, 1_000_004n);
    assert.equal(restored.snapshot().pools, snapshot.pools);
    const changed = { getLogs: async () => [], getBlock: async () => ({ hash: `0x${'2'.padStart(64, '0')}` }) } as unknown as PublicClient;
    await assert.rejects(new ProtocolPoolIndex(8453, 5n, file).sync(changed, 2_000_010n), /CHECKPOINT_REORG/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('protocol index load globally deduplicates pools and removes abandoned temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-index-dedup-')), file = join(dir, '8453.json');
  const hash = `0x${'1'.padStart(64, '0')}` as const;
  const pool = demoObservations().find(o => o.state.pool.chainId === 8453)!.state.pool;
  const temporary = `${file}.12345.tmp`;
  try {
    await writeFile(file, json({ version: 1, chainId: 8453, startBlock: '5', indexedBlock: '10', indexedBlockHash: hash, pools: [pool, pool] }));
    await writeFile(temporary, 'abandoned');
    const index = new ProtocolPoolIndex(8453, 5n, file);
    await index.load();
    assert.equal(index.snapshot().pools.length, 1);
    await assert.rejects(access(temporary), /ENOENT/);
    assert.equal(INDEX_BLOCK_CHUNK_SIZE, 50_000n);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('replay persists supplied observations without creating live execution state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-test-')), repo = new FileRepository(dir);
  try {
    await repo.initialize();
    await repo.setControls({ globalPaused: false, pausedChains: [], botState: 'RUNNING' });
    const agent = new Agent(policy, repo);
    Object.defineProperty(agent.tokenMemory, 'path', { value: join(dir, 'token-memory.json') });
    const replay = await agent.replay([demoObservations(), demoObservations(now + 1800)]);
    assert.equal(replay.positions.length, 0); assert.equal(replay.netPnlUsd, 0);
    const saved = await repo.latest(); assert.ok(saved); assert.equal(saved.observations.length, 9);
    assert.equal(saved.positions.length, 0); assert.equal(saved.decisions.length, 0);
    await repo.setControls({ globalPaused: false, pausedChains: [56] });
    const run = await agent.cycle({ mode: 'replay', observations: demoObservations(now + 3600), now: now + 3600 });
    assert.equal(run.candidates.length, 0);
    assert.equal(run.observations.length, 9);
    assert.deepEqual((await repo.controls()).pausedChains, [56]);
    const historical = await agent.cycle({ mode: 'replay', observations: demoObservations(now - 3600), now: now - 3600 });
    assert.equal((await repo.latest())!.id, historical.id);
    assert.equal(typeof (await repo.latest())!.observations[0]!.state.liquidity, 'bigint');
  } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
});
test('separate MCP server exposes read-only agent tools, never upstream transaction tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viero-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/viero/mcp.ts'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), VIERO_DATA_DIR: dir, VIERO_ROLE: 'screener', DATABASE_URL: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'preview_position'));
    assert.ok(!tools.tools.some(t => /transfer|approve_token|mint_|swap_token|write_contract/.test(t.name)));
    const chains = await client.callTool({ name: 'list_supported_chains', arguments: {} });
    assert.equal(chains.isError, undefined);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
test('PostgreSQL persists a complete run transactionally', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const repo = new PostgresRepository(process.env.TEST_DATABASE_URL!);
  try {
    await repo.initialize(); const run = await new Agent(policy, repo).cycle({ mode: 'replay', observations: demoObservations(), now });
    assert.ok((await repo.history()).some(r => r.id === run.id));
    assert.equal(run.candidates.length, 9);
  } finally { await repo.close(); }
});
