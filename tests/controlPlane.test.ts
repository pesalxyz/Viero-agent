import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramBot, validateStartSettings } from '../src/viero/telegram.js';
import { Agent } from '../src/viero/workers/screeningWorker.js';
import { DEFAULT_POLICY } from '../src/viero/config/policy.js';
import { FileRepository, type AgentRun, type Controls, type Repository } from '../src/viero/storage/repositories.js';

function run(): AgentRun {
  return {
    id: '00000000-0000-4000-8000-000000000001', mode: 'live-execution', startedAt: 1, finishedAt: 1,
    configVersion: 'test', deploymentVersion: 'test', policy: {}, observations: [], candidates: [], discoveries: [],
    decisions: [], tokenDecisions: [], positions: [], health: [], providerObservations: [], errors: [], status: 'ok',
  };
}

function memoryRepo(initial: Controls) {
  let controls = initial;
  let saved: AgentRun | null = null;
  const repo = {
    async initialize() {}, async saveRun(value: AgentRun) { saved = value; }, async latest() { return saved; }, async history() { return []; },
    async controls() { return controls; }, async setControls(value: Controls) { controls = value; }, async close() {}, async findRunById() { return null; },
    async strategyState() { return { version: 1 as const, positions: [], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {} }; },
    async setStrategyState() {},
  } as Repository;
  return { repo, get controls() { return controls; }, get saved() { return saved; } };
}

function botFor(repo: Repository, signer?: unknown) {
  const sent: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    payloads.push(payload);
    if (typeof payload.text === 'string') sent.push(payload.text);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const bot = new TelegramBot({ token: '12345678901234567890', allowedUserIds: new Set([7]), agent: { signer } as never,
    repo, chains: [8453], tokenLimit: 1, poolLimit: 1, intervalSeconds: 300, fetch: fetchImpl });
  return { bot, sent, payloads };
}

const configuredControls = (): Controls => ({ globalPaused: false, pausedChains: [], botState: 'STOPPED',
  sizeMode: 'FIXED', fixedSizeUsd: 25, rangeMode: 'FIXED', fixedRangePct: 15,
  enabledChains: [8453], takeProfitPct: 20, stopLossPct: -10 });

async function callback(bot: TelegramBot, data: string) {
  await bot.handleCallbackQuery({ id: `cb-${data}`, from: { id: 7 }, message: { chat: { id: 7 } }, data });
}

test('persistent bot state defaults STOPPED and survives repository restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'viero-control-'));
  try {
    const first = new FileRepository(directory);
    await first.initialize();
    assert.equal((await first.controls()).botState, 'STOPPED');
    await first.setControls({ ...configuredControls(), botState: 'RUNNING' });
    const restored = await new FileRepository(directory).controls();
    assert.equal(restored.botState, 'RUNNING');
    assert.deepEqual({ sizeMode: restored.sizeMode, fixedSizeUsd: restored.fixedSizeUsd, rangeMode: restored.rangeMode,
      fixedRangePct: restored.fixedRangePct, enabledChains: restored.enabledChains, takeProfitPct: restored.takeProfitPct,
      stopLossPct: restored.stopLossPct }, { sizeMode: 'FIXED', fixedSizeUsd: 25, rangeMode: 'FIXED',
      fixedRangePct: 15, enabledChains: [8453], takeProfitPct: 20, stopLossPct: -10 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy controls safely receive Phase 2 defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'viero-control-'));
  try {
    const repo = new FileRepository(directory);
    await repo.initialize();
    await writeFile(join(directory, 'controls.json'), JSON.stringify({ globalPaused: false, pausedChains: [] }));
    const controls = await repo.controls();
    assert.deepEqual({ botState: controls.botState, sizeMode: controls.sizeMode, rangeMode: controls.rangeMode,
      fixedSizeUsd: controls.fixedSizeUsd, fixedRangePct: controls.fixedRangePct, enabledChains: controls.enabledChains,
      takeProfitPct: controls.takeProfitPct, stopLossPct: controls.stopLossPct },
    { botState: 'STOPPED', sizeMode: null, rangeMode: null, fixedSizeUsd: null, fixedRangePct: null, enabledChains: [], takeProfitPct: null, stopLossPct: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('/start and /stop persist operating state', async () => {
  const state = memoryRepo(configuredControls());
  const { bot } = botFor(state.repo);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/start' });
  assert.equal(state.controls.botState, 'RUNNING');
  await bot.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: 7 }, text: '/stop' });
  assert.equal(state.controls.botState, 'STOPPED');
});

test('/settings is allowed only while STOPPED', async () => {
  const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'STOPPED' });
  const { bot, sent } = botFor(state.repo);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/settings' });
  assert.match(sent.at(-1)!, /Viero settings/);
  await state.repo.setControls({ ...state.controls, botState: 'RUNNING' });
  await bot.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: 7 }, text: '/settings' });
  assert.equal(sent.at(-1), 'Stop Viero first with /stop before changing settings.');
});

test('Fixed Size and Fixed Range validate input and persist FIXED modes', async () => {
  const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'STOPPED' });
  const { bot, sent } = botFor(state.repo);
  await callback(bot, 'settings:fixed_size');
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: 'NaN' });
  assert.match(sent.at(-1)!, /Invalid value/);
  await bot.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: 7 }, text: '25' });
  assert.equal(state.controls.sizeMode, 'FIXED'); assert.equal(state.controls.fixedSizeUsd, 25);
  await callback(bot, 'settings:fixed_range');
  await bot.handleMessage({ message_id: 3, from: { id: 7 }, chat: { id: 7 }, text: '0' });
  assert.match(sent.at(-1)!, /1 to 99/);
  await bot.handleMessage({ message_id: 4, from: { id: 7 }, chat: { id: 7 }, text: '99' });
  assert.equal(state.controls.rangeMode, 'FIXED'); assert.equal(state.controls.fixedRangePct, 99);
});

test('AUTO modes persist and are accepted by Phase 2 start validation', async () => {
  const state = memoryRepo({ ...configuredControls(), sizeMode: null, rangeMode: null, fixedSizeUsd: null, fixedRangePct: null });
  const { bot, sent } = botFor(state.repo);
  await callback(bot, 'settings:auto_size'); await callback(bot, 'settings:auto_range');
  assert.equal(state.controls.sizeMode, 'AUTO'); assert.equal(state.controls.rangeMode, 'AUTO');
  assert.deepEqual(validateStartSettings(state.controls), []);
  assert.match(sent.join('\n'), /Deterministic market-cap\/volatility rules/);
});

test('chain menu supports multi-select and /start rejects zero enabled chains', async () => {
  const state = memoryRepo({ ...configuredControls(), enabledChains: [56] });
  const { bot } = botFor(state.repo);
  await callback(bot, 'settings:chain:8453');
  assert.deepEqual(state.controls.enabledChains, [56, 8453]);
  await callback(bot, 'settings:chain:56'); await callback(bot, 'settings:chain:8453');
  assert.deepEqual(state.controls.enabledChains, []);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/start' });
  assert.equal(state.controls.botState, 'STOPPED');
});

test('TP and SL enforce signs, persist, and are mandatory for /start', async () => {
  const state = memoryRepo({ ...configuredControls(), takeProfitPct: null, stopLossPct: null });
  const { bot, sent } = botFor(state.repo);
  assert.deepEqual(validateStartSettings(state.controls).filter(error => /Take Profit|Stop Loss/.test(error)),
    ['set Take Profit to a percentage greater than 0', 'set Stop Loss to a negative percentage']);
  await bot.handleMessage({ message_id: 0, from: { id: 7 }, chat: { id: 7 }, text: '/start' });
  assert.equal(state.controls.botState, 'STOPPED');
  await callback(bot, 'settings:tp');
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '-2' });
  assert.match(sent.at(-1)!, /greater than 0/);
  await bot.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: 7 }, text: '20' });
  await callback(bot, 'settings:sl');
  await bot.handleMessage({ message_id: 3, from: { id: 7 }, chat: { id: 7 }, text: '10' });
  assert.match(sent.at(-1)!, /negative percentage/);
  await bot.handleMessage({ message_id: 4, from: { id: 7 }, chat: { id: 7 }, text: '-10' });
  assert.equal(state.controls.takeProfitPct, 20); assert.equal(state.controls.stopLossPct, -10);
  assert.deepEqual(validateStartSettings(state.controls), []);
});

test('/start reports missing FIXED values and remains STOPPED', async () => {
  const state = memoryRepo({ ...configuredControls(), fixedSizeUsd: null, fixedRangePct: null });
  const { bot, sent } = botFor(state.repo);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/start' });
  assert.equal(state.controls.botState, 'STOPPED');
  assert.match(sent.at(-1)!, /Fixed Size/); assert.match(sent.at(-1)!, /Fixed Range/);
});

test('Wallet is read-only, shortens address, and never exposes signer secrets', async () => {
  const state = memoryRepo(configuredControls());
  const secret = 'never-display-this-private-key';
  const signer = { secret, async health() { return { ok: true as const, address: '0x1234567890123456789012345678901234567890' }; } };
  const { bot, sent } = botFor(state.repo, signer);
  await callback(bot, 'settings:wallet');
  assert.match(sent.at(-1)!, /0x1234…7890/);
  assert.doesNotMatch(sent.at(-1)!, new RegExp(secret));
  assert.match(sent.at(-1)!, /never accepted/);
});

test('/status reports bot, live execution, and signer state', async () => {
  const prior = process.env.VIERO_EXECUTION_ENABLED;
  process.env.VIERO_EXECUTION_ENABLED = 'false';
  try {
    const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'RUNNING' });
    const { bot, sent } = botFor(state.repo);
    await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/status' });
    assert.match(sent.at(-1)!, /Bot state: RUNNING/);
    assert.match(sent.at(-1)!, /Live execution: disabled/);
    assert.match(sent.at(-1)!, /Signer: not configured/);
  } finally {
    if (prior === undefined) delete process.env.VIERO_EXECUTION_ENABLED; else process.env.VIERO_EXECUTION_ENABLED = prior;
  }
});

test('/status reports signer configured only when signer health succeeds', async () => {
  const prior = process.env.VIERO_EXECUTION_ENABLED;
  process.env.VIERO_EXECUTION_ENABLED = 'true';
  try {
    const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'STOPPED' });
    const signer = { health: async () => ({ ok: true as const, address: '0x1111111111111111111111111111111111111111' }) };
    const { bot, sent } = botFor(state.repo, signer);
    await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/status' });
    assert.match(sent.at(-1)!, /Signer: configured/);
  } finally {
    if (prior === undefined) delete process.env.VIERO_EXECUTION_ENABLED; else process.env.VIERO_EXECUTION_ENABLED = prior;
  }
});

test('/status reports signer unavailable when health check fails', async () => {
  const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'STOPPED' });
  const signer = { health: async () => { throw new Error('SIGNER_UNAVAILABLE'); } };
  const { bot, sent } = botFor(state.repo, signer);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/status' });
  assert.match(sent.at(-1)!, /Signer: not configured/);
});

test('STOPPED rejects new-entry execution before pool work but leaves management callable', async () => {
  const state = memoryRepo({ globalPaused: false, pausedChains: [], botState: 'STOPPED' });
  const agent = new Agent(DEFAULT_POLICY, state.repo, undefined, {} as never);
  let poolCalls = 0;
  agent.gmgn.poolInfo = async () => { poolCalls++; return null; };
  const result = await agent.executeCandidateToken({ chainId: 8453, tokenAddress: '0x1111111111111111111111111111111111111111', mode: 'live-execution', run: run() });
  assert.equal(poolCalls, 0);
  assert.match(result.errors[0]?.error ?? '', /BOT_STOPPED_NEW_ENTRIES_DISABLED/);
  assert.deepEqual(await agent.manageLive(), []);
});
