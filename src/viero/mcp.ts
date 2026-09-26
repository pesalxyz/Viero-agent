import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { erc20Abi } from 'viem';
import { z } from 'zod';
import { CHAINS } from './config/chains.js';
import { DEFAULT_POLICY } from './config/policy.js';
import { chainIdSchema, poolSchema, addressSchema, observationSchema, poolIdentity, json, errorMessage } from './domain.js';
import { repository } from './storage/repositories.js';
import { Agent } from './workers/screeningWorker.js';
import { verifyPool } from './adapters/pools.js';
import { discover } from './workers/discoveryWorker.js';
import { planPosition } from './execution/planner.js';
import { screen, rank } from './screening/pipeline.js';
import { arcBalance, nativeUsdc, erc20Usdc } from './domain/arc.js';
import { assertChain } from './clients/publicClients.js';

try { process.loadEnvFile?.(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
export async function createVieroServer() {
  const repo = repository(); await repo.initialize();
  const agent = new Agent(DEFAULT_POLICY, repo);
  const server = new McpServer({ name: 'viero-readonly-agent', version: '0.1.0' });
  const role = z.enum(['screener', 'manager']).parse(process.env.VIERO_ROLE ?? 'screener');
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const wrap = async (operation: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: json(await operation(), true) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: errorMessage(error) }] }; }
  };
  server.registerTool('list_supported_chains', { description: 'Read the exhaustive chain and venue registry.', inputSchema: {}, annotations: readOnly }, () => wrap(async () => Object.values(CHAINS)));
  server.registerTool('verify_pool', { description: 'Verify exact v3 factory identity or v4 PoolKey/PoolId at a pinned RPC block.', inputSchema: { pool: poolSchema }, annotations: readOnly }, ({ pool }) => wrap(() => verifyPool(agent.clients.get(pool.chainId), pool)));
  server.registerTool('get_wallet_balances', { description: 'Read quote asset balances. Arc returns one canonical USDC balance.', inputSchema: { chainId: chainIdSchema, wallet: addressSchema }, annotations: readOnly }, ({ chainId, wallet }) => wrap(async () => {
    const c = CHAINS[chainId], client = agent.clients.get(chainId);
    await assertChain(client, chainId);
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const native = await client.getBalance({ address: wallet, blockNumber });
    const tokens = await Promise.all(c.quoteTokens.map(async token => ({ chainId, token, balance: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet], blockNumber }) })));
    return chainId === 5042 ? { blockNumber, ...arcBalance(nativeUsdc(native), erc20Usdc(tokens[0]!.balance), nativeUsdc(c.minimumGasReserve)) } : { chainId, blockNumber, native, tokens };
  }));
  if (role === 'screener') {
    server.registerTool('discover_pools', { description: 'Discover candidates; discovery alone does not authorize capital.', inputSchema: { chainId: chainIdSchema }, annotations: readOnly }, ({ chainId }) => wrap(() => discover(chainId, agent)));
    server.registerTool('get_gmgn_token_detail', { description: 'Read GMGN token metadata as untrusted data.', inputSchema: { chainId: chainIdSchema, token: addressSchema }, annotations: readOnly }, ({ chainId, token }) => wrap(() => agent.gmgn.query(chainId, 'info', { token })));
    server.registerTool('get_token_security', { description: 'Read raw GMGN security evidence; unavailable fields are not passes.', inputSchema: { chainId: chainIdSchema, token: addressSchema }, annotations: readOnly }, ({ chainId, token }) => wrap(() => agent.gmgn.query(chainId, 'security', { token })));
    server.registerTool('get_token_holders', { description: 'Read GMGN holders.', inputSchema: { chainId: chainIdSchema, token: addressSchema }, annotations: readOnly }, ({ chainId, token }) => wrap(() => agent.gmgn.query(chainId, 'holders', { token })));
    server.registerTool('get_top_candidates', { description: 'Read saved candidates, rechecking policy freshness. Replay data is explicitly labelled.', inputSchema: { chainId: chainIdSchema.optional() }, annotations: readOnly }, ({ chainId }) => wrap(async () => {
      const run = await repo.latest();
      if (!run) return { candidates: [] };
      const observations = run.observations.filter(o => !chainId || o.state.pool.chainId === chainId).map(o => observationSchema.parse(o));
      return { mode: run.mode, candidates: rank(observations.map(o => screen(o, agent.policy, Date.now() / 1000))) };
    }));
    server.registerTool('get_pool_metrics', { description: 'Read the last persisted exact-pool metric snapshot and its provenance.', inputSchema: { pool: poolSchema }, annotations: readOnly }, ({ pool }) => wrap(async () => {
      const run = await repo.latest();
      return { mode: run?.mode, candidate: run?.candidates.find(c => c.identity === poolIdentity(pool)) ?? null };
    }));
    server.registerTool('preview_position', { description: 'Create a paper-only bounded preview from a saved, fresh approved snapshot. No transaction is created.', inputSchema: { pool: poolSchema, budgetUsd: z.number().positive().max(DEFAULT_POLICY.maximumPositionUsd) }, annotations: readOnly }, ({ pool, budgetUsd }) => wrap(async () => {
      const run = await repo.latest();
      if (!run || run.mode !== 'live-readonly') throw new Error('Fresh live report required for this tool; use CLI demo for synthetic previews');
      const controls = await repo.controls();
      if (controls.globalPaused || controls.pausedChains.includes(pool.chainId)) throw new Error('CHAIN_PAUSED');
      const raw = run.observations.find(o => poolIdentity(o.state.pool) === poolIdentity(pool));
      if (!raw) throw new Error('POOL_NOT_IN_LATEST_REPORT');
      const observation = observationSchema.parse(raw);
      observation.state = await verifyPool(agent.clients.get(pool.chainId), pool);
      const now = Date.now() / 1000, candidate = screen(observation, agent.policy, now);
      return planPosition(observation, candidate, budgetUsd, agent.policy, { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 }, now);
    }));
  } else {
    server.registerTool('get_positions', { description: 'Read simulated paper positions from the latest persisted replay; not a live wallet enumeration.', inputSchema: { chainId: chainIdSchema.optional() }, annotations: readOnly }, ({ chainId }) => wrap(async () => ({ mode: 'paper', positions: (await repo.latest())?.positions.filter(p => !chainId || p.chainId === chainId) ?? [] })));
    server.registerTool('get_position_pnl', { description: 'Read paper accounting including unclaimed fees and costs.', inputSchema: { chainId: chainIdSchema, positionId: z.string() }, annotations: readOnly }, ({ chainId, positionId }) => wrap(async () => (await repo.latest())?.positions.find(p => p.id === positionId && p.chainId === chainId) ?? null));
  }
  return { server, close: async () => { await server.close(); await repo.close(); } };
}
if (process.argv[1]?.endsWith('/mcp.ts') || process.argv[1]?.endsWith('/mcp.js')) {
  const { server } = await createVieroServer();
  await server.connect(new StdioServerTransport());
}
