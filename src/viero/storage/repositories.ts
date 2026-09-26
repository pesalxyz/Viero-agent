import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Address } from 'viem';
import pg from 'pg';
import { z } from 'zod';
import { json, type ChainId, type Mode, type Observation, chainIdSchema, observationSchema } from '../domain.js';
import { type Candidate } from '../screening/pipeline.js';
import { type Selection } from '../agent/runtime.js';
import { type PositionPlan } from '../execution/planner.js';
import { type PaperPosition } from '../management/paper.js';
import { type ProviderHealth, type ProviderObservation } from '../adapters/providers.js';
import { type DiscoveryResult } from '../workers/discoveryWorker.js';
import { emptyStrategyState, strategyStateSchema, type StrategyState } from '../execution/liveState.js';
import { type PoolDiscoveryEvidence } from '../adapters/targetedPoolDiscovery.js';

export type AgentRun = {
  id: string; mode: Mode; startedAt: number; finishedAt: number; configVersion: string; deploymentVersion: string;
  policy: unknown; observations: Observation[]; candidates: Candidate[]; discoveries: DiscoveryResult[];
  decisions: Array<{ chainId: ChainId; promptVersion: string; model: string; selection: Selection; plan?: PositionPlan; transactionHashes?: string[]; opened?: { positionId: string; tokenId: string; protocol: 'v3' | 'v4'; txHash: string; sizeUsd: number } }>;
  selectedTokenAddress?: Address;
  selectedTokenSymbol?: string;
  selectedTokenVolume1h?: number | null;
  candidateHandoff?: { selectedTokenAddress: Address; selectedTokenSymbol?: string; status: 'NOT_ATTEMPTED' | 'SKIPPED' | 'POOL_LOOKUP' | 'READY' | 'EXECUTED'; reason: 'BOT_STOPPED' | 'NO_SUPPORTED_POOL' | 'PROVIDER_FAILURE' | null; controlsBotState: 'RUNNING' | 'STOPPED'; initialBotState?: 'RUNNING' | 'STOPPED'; preEnrichmentBotState?: 'RUNNING' | 'STOPPED'; preExecutionBotState?: 'RUNNING' | 'STOPPED'; timestamp: number };
  poolDiscovery?: PoolDiscoveryEvidence;
  stage1Ranking?: { eligibleCount: number; exclusions: Array<{ reason: string; count: number }>; ranked: Array<{ chainId: ChainId; tokenAddress: Address; symbol?: string; score: number; volume1h: number; liquidityUsd: number; hotSearchRank: number }> };
  discoverySnapshot?: { rawFetched: number; blockedFiltered: number; discovered: number; economicFiltered: number; securityScreened: number; pass: number; reject: number; eligible: number; securityDecisions: Array<{ symbol?: string; address: Address; hotSearchRank?: number; criticalAdmin?: boolean | null; honeypot?: boolean | null; sellTaxBps?: number | null; top10HolderPct?: number | null; verdict: string; rejectionCode?: string; rejectionDetail?: string }> };
  /**
   * Routine 5-minute screening output — one record per passed GMGN-Hot-Search
   * token that survived the token screening step. The cycle() populates this
   * field; pool-level decisions stay on `decisions[]` and are emitted by the
   * execution-candidate path only.
   */
  tokenDecisions: Array<{ chainId: ChainId; tokenAddress: Address; symbol?: string; name?: string;
    verdict: 'PASS' | 'REJECT' | 'RETRY_LATER'; rejectReason?: string;
    holdersTop10Pct?: number | null; sellTaxBps?: number | null;
    volume1h?: number | null; liquidityUsd?: number | null;
    buySimulation?: boolean | null; sellSimulation?: boolean | null;
    honeypot?: boolean | null; criticalAdmin?: boolean | null;
    smartMoneyScore?: number | null; hotSearchRank?: number | null;
    tokenAgeSeconds?: number | null; rank: number;
  }>;
  positions: PaperPosition[];
  livePositions?: Array<{ id: string; tokenId: string; protocol: 'v3' | 'v4'; status: 'open' | 'closing'; symbol?: string; poolAddress?: string; openedAt: number; closeReason?: string | null; valueUsd?: number | null; feeUsd?: number | null; feeDetails?: string | null; pnlPct?: number | null; inRange?: boolean; currentPrice?: number | null; lowerPrice?: number | null; upperPrice?: number | null; peakPnlPct?: number | null; trailingTakeProfitArmed?: boolean; outOfRangeSince?: number | null; baseSymbol?: string; quoteSymbol?: string }>;
  health: ProviderHealth[]; providerObservations: ProviderObservation[];
  errors: Array<{ chainId: ChainId; pool?: string; error: string; code?: string; details?: { quoteAddress?: string; quoteSymbol?: string; quoteDecimals?: number; requiredRaw?: string; availableRaw?: string; requiredHuman?: string; availableHuman?: string; requiredUsd?: number } }>; status: 'ok' | 'degraded' | 'failed';
};
export const botOperatingStateSchema = z.enum(['RUNNING', 'STOPPED']);
export type BotOperatingState = z.infer<typeof botOperatingStateSchema>;
export const strategyModeSchema = z.enum(['AUTO', 'FIXED']);
export type StrategyMode = z.infer<typeof strategyModeSchema>;
export const controlsSchema = z.object({
  globalPaused: z.boolean(),
  pausedChains: z.array(chainIdSchema),
  botState: botOperatingStateSchema.default('STOPPED'),
  rangeMode: strategyModeSchema.nullable().default(null),
  fixedRangePct: z.number().finite().min(1).max(99).nullable().default(null),
  sizeMode: strategyModeSchema.nullable().default(null),
  fixedSizeUsd: z.number().finite().positive().nullable().default(null),
  enabledChains: z.array(chainIdSchema).default([]),
  takeProfitPct: z.number().finite().positive().nullable().default(null),
  stopLossPct: z.number().finite().negative().nullable().default(null),
  minAutoSizeUsd: z.number().finite().positive().default(5),
  maxAutoSizeUsd: z.number().finite().positive().default(25),
  maxWalletExposurePct: z.number().finite().positive().max(100).default(5),
  minAutoRangePct: z.number().finite().min(1).max(99).default(5),
  maxAutoRangePct: z.number().finite().min(1).max(99).default(30),
  lastAutoReportRunId: z.string().uuid().nullable().default(null),
}).strict();
export type Controls = {
  globalPaused: boolean; pausedChains: ChainId[]; botState?: BotOperatingState;
  rangeMode?: StrategyMode | null; fixedRangePct?: number | null;
  sizeMode?: StrategyMode | null; fixedSizeUsd?: number | null;
  enabledChains?: ChainId[]; takeProfitPct?: number | null; stopLossPct?: number | null;
  minAutoSizeUsd?: number; maxAutoSizeUsd?: number; maxWalletExposurePct?: number;
  minAutoRangePct?: number; maxAutoRangePct?: number;
  lastAutoReportRunId?: string | null;
};
export interface Repository {
  initialize(): Promise<void>; saveRun(run: AgentRun): Promise<void>; latest(): Promise<AgentRun | null>;
  history(): Promise<AgentRun[]>; controls(): Promise<Controls>; setControls(controls: Controls): Promise<void>; close(): Promise<void>;
  findRunById(id: string): Promise<AgentRun | null>;
  strategyState(): Promise<StrategyState>; setStrategyState(state: StrategyState): Promise<void>;
}
async function atomicWrite(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, json(value, true), { mode: 0o600 });
  await rename(temp, path);
}
function hydratePlan(plan: PositionPlan): PositionPlan {
  return { ...plan, liquidity: BigInt(plan.liquidity), sourceBlock: BigInt(plan.sourceBlock),
    depositAssets: plan.depositAssets.map(a => ({ ...a, amount: BigInt(a.amount) })),
    expectedTransfers: plan.expectedTransfers.map(a => ({ ...a, maximumAmount: BigInt(a.maximumAmount) })) };
}
function hydrateRun(run: AgentRun): AgentRun {
  return { ...run, observations: run.observations.map(o => observationSchema.parse(o)),
    candidates: run.candidates.map(c => ({ ...c, metrics: { ...c.metrics, sourceBlock: BigInt(c.metrics.sourceBlock) } })),
    decisions: run.decisions.map(d => ({ ...d, plan: d.plan ? hydratePlan(d.plan) : undefined })),
    positions: run.positions.map(p => ({ ...p, plan: hydratePlan(p.plan) })) };
}
export class FileRepository implements Repository {
  readonly directory: string;
  constructor(directory = process.env.VIERO_DATA_DIR || 'data/viero') { this.directory = resolve(directory); }
  async initialize() { await mkdir(join(this.directory, 'runs'), { recursive: true, mode: 0o700 }); }
  async saveRun(run: AgentRun) {
    if (!/^[0-9a-f-]{36}$/.test(run.id)) throw new Error('Invalid run ID');
    const filename = `${run.startedAt}-${run.id}.json`;
    await atomicWrite(join(this.directory, 'runs', filename), run);
    // Latest means most recently persisted, not the largest simulated market timestamp.
    await atomicWrite(join(this.directory, 'latest.json'), { filename });
  }
  async history(): Promise<AgentRun[]> {
    const names = (await readdir(join(this.directory, 'runs'))).filter(n => n.endsWith('.json')).sort();
    return Promise.all(names.map(async n => hydrateRun(JSON.parse(await readFile(join(this.directory, 'runs', n), 'utf8')) as AgentRun)));
  }
  async latest(): Promise<AgentRun | null> {
    try {
      const pointer = z.object({ filename: z.string().regex(/^[0-9.]+-[0-9a-f-]{36}\.json$/) }).parse(JSON.parse(await readFile(join(this.directory, 'latest.json'), 'utf8')));
      return hydrateRun(JSON.parse(await readFile(join(this.directory, 'runs', pointer.filename), 'utf8')) as AgentRun);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const names = (await readdir(join(this.directory, 'runs'))).filter(n => n.endsWith('.json')).sort();
    return names.length ? hydrateRun(JSON.parse(await readFile(join(this.directory, 'runs', names.at(-1)!), 'utf8')) as AgentRun) : null;
  }
  async findRunById(id: string): Promise<AgentRun | null> {
    const safe = z.string().regex(/^[0-9a-f-]{36}$/).parse(id);
    const names = (await readdir(join(this.directory, 'runs'))).filter(n => n.endsWith('.json'));
    for (const n of names) {
      if (!n.endsWith(`-${safe}.json`)) continue;
      return hydrateRun(JSON.parse(await readFile(join(this.directory, 'runs', n), 'utf8')) as AgentRun);
    }
    return null;
  }
  async controls(): Promise<Controls> {
    try { return controlsSchema.parse(JSON.parse(await readFile(join(this.directory, 'controls.json'), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return controlsSchema.parse({ globalPaused: false, pausedChains: [] }); throw e; }
  }
  async setControls(controls: Controls) { await atomicWrite(join(this.directory, 'controls.json'), controlsSchema.parse(controls)); }
  async strategyState() {
    try { return strategyStateSchema.parse(JSON.parse(await readFile(join(this.directory, 'strategy-state.json'), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyStrategyState(); throw e; }
  }
  async setStrategyState(state: StrategyState) { await atomicWrite(join(this.directory, 'strategy-state.json'), strategyStateSchema.parse(state)); }
  async close() {}
}
export class PostgresRepository implements Repository {
  private pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 4 }); }
  async initialize() {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.pool.query(schema);
  }
  async saveRun(run: AgentRun) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO viero_agent_runs (id, started_at, mode, status, payload) VALUES ($1,to_timestamp($2),$3,$4,$5::jsonb)', [run.id, run.startedAt, run.mode, run.status, json(run)]);
      for (const o of run.observations) {
        const p = o.state.pool;
        const poolId = p.protocol === 'v3' ? p.poolAddress : p.poolId;
        await db.query('INSERT INTO viero_observations (run_id,chain_id,protocol,dex_id,pool_id,source_block,window_end,payload) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8::jsonb)', [run.id, p.chainId, p.protocol, p.dex, poolId, String(o.state.blockNumber), o.windowEnd, json(o)]);
      }
      for (const c of run.candidates) await db.query('INSERT INTO viero_decisions (run_id,chain_id,pool_identity,approved,payload) VALUES ($1,$2,$3,$4,$5::jsonb)', [run.id, c.pool.chainId, c.identity, c.approved, json(c)]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async latest() { const { rows } = await this.pool.query('SELECT payload FROM viero_agent_runs ORDER BY recorded_at DESC LIMIT 1'); return rows[0] ? hydrateRun(rows[0].payload as AgentRun) : null; }
  async history() { const { rows } = await this.pool.query('SELECT payload FROM viero_agent_runs ORDER BY started_at'); return rows.map(r => hydrateRun(r.payload as AgentRun)); }
  async findRunById(id: string) {
    const safe = z.string().regex(/^[0-9a-f-]{36}$/).parse(id);
    const { rows } = await this.pool.query('SELECT payload FROM viero_agent_runs WHERE id = $1 LIMIT 1', [safe]);
    return rows[0] ? hydrateRun(rows[0].payload as AgentRun) : null;
  }
  async controls() { const { rows } = await this.pool.query('SELECT payload FROM viero_controls WHERE id = 1'); return controlsSchema.parse(rows[0]?.payload ?? { globalPaused: false, pausedChains: [] }); }
  async setControls(controls: Controls) { await this.pool.query('INSERT INTO viero_controls (id,payload) VALUES (1,$1::jsonb) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload', [json(controlsSchema.parse(controls))]); }
  async strategyState() { const { rows } = await this.pool.query('SELECT payload FROM viero_strategy_state WHERE id = 1'); return strategyStateSchema.parse(rows[0]?.payload ?? emptyStrategyState()); }
  async setStrategyState(state: StrategyState) { await this.pool.query('INSERT INTO viero_strategy_state (id,payload) VALUES (1,$1::jsonb) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload', [json(strategyStateSchema.parse(state))]); }
  async close() { await this.pool.end(); }
}
export function repository(): Repository { return process.env.DATABASE_URL ? new PostgresRepository(process.env.DATABASE_URL) : new FileRepository(); }
