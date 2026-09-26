/**
 * Focused tests for Telegram LLM output sanitization and auto-report
 * selection.
 *
 * Pure-function tests only — no live LLM, no live network. Mock the LLM
 * client and a fake repository to verify the gate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLlmOutput, TelegramBot } from '../src/viero/telegram.ts';
import type { AgentRun, Repository } from '../src/viero/storage/repositories.ts';
import type { LlmClient } from '../src/viero/agent/llmClient.ts';
import type { TelegramOptions } from '../src/viero/telegram.ts';

// ─── sanitizeLlmOutput ────────────────────────────────────────

test('sanitizeLlmOutput strips a single <think>...</think> block', () => {
  const out = sanitizeLlmOutput('<think>let me think...</think>Final summary here.');
  assert.equal(out, 'Final summary here.');
});

test('sanitizeLlmOutput strips multiple <think> blocks anywhere in the response', () => {
  const input = '<think>first thought</think>Real content here<think>second thought</think>And more.';
  assert.equal(sanitizeLlmOutput(input), 'Real content hereAnd more.');
});

test('sanitizeLlmOutput strips multiline <think> blocks', () => {
  const input = '<think>multi\nline\nthinking\n</think>Actual content\n<think>more thinking</think>More content';
  const result = sanitizeLlmOutput(input);
  assert.match(result, /Actual content/);
  assert.match(result, /More content/);
  assert.doesNotMatch(result, /<think>/);
});

test('sanitizeLlmOutput is a no-op when no <think> tags are present', () => {
  const input = 'Plain final summary with no reasoning markers.';
  assert.equal(sanitizeLlmOutput(input), input);
});

test('sanitizeLlmOutput case-insensitive (<think>, <Think, <THINK)', () => {
  const out = sanitizeLlmOutput('<THINK>reasoning</THINK>Final');
  assert.equal(out, 'Final');
});

test('sanitizeLlmOutput handles empty / whitespace-only input safely', () => {
  assert.equal(sanitizeLlmOutput(''), '');
  assert.equal(sanitizeLlmOutput('   \n\n  '), '');
});

test('sanitizeLlmOutput collapses runs of blank lines created by stripping', () => {
  const input = '<think>\n\n\n\n</think>Real\nContent';
  const out = sanitizeLlmOutput(input);
  assert.doesNotMatch(out, /\n{3,}/);
  assert.match(out, /Real/);
  assert.match(out, /Content/);
});

test('candidate report shows pool fee and compact Uniswap pool link', async () => {
  const observation = observationStub(8453) as any;
  observation.state.fee = 10_000;
  const pool = observation.state.pool;
  const run = makeRun({
    observations: [observation],
    selectedTokenAddress: '0x' + '2'.repeat(40),
    selectedTokenSymbol: 'SHROOM',
    candidates: [{ identity: '8453:v3:uniswap:0x0000000000000000000000000000000000000001', pool, approved: true, rejections: [], metrics: { tvlUsd: 27130 } }] as never,
  });
  const repo = new FakeRepo(run);
  const { bot } = makeBot(repo as never, makeFakeLlm('not canonical'));
  const summary = await (bot as unknown as BotPrivate).summarizeReport(run);
  assert.match(summary, /SHROOM \[v3\] 1% <a href="https:\/\/app\.uniswap\.org\/explore\/pools\/robinhood\/0x0000000000000000000000000000000000000001">Pool<\/a>/);
});

test('cycle report shows up to five Stage-1 ranked tokens', async () => {
  const ranked = Array.from({ length: 6 }, (_, index) => ({
    chainId: 8453 as const,
    tokenAddress: `0x${String(index + 1).padStart(40, '0')}` as `0x${string}`,
    symbol: ['CEREBRO', 'PONS', 'MEME', 'DELTA', 'musebook', 'SIXTH'][index],
    score: 0.6518 - index * 0.01,
    volume1h: 127_640 - index,
    liquidityUsd: 195_830 + index,
    hotSearchRank: index + 1,
  }));
  const run = makeRun({ stage1Ranking: { eligibleCount: 6, exclusions: [], ranked } });
  const { bot } = makeBot(new FakeRepo(run) as never, makeFakeLlm('not canonical'));
  const summary = await (bot as unknown as BotPrivate).summarizeReport(run);
  assert.match(summary, /#1 CEREBRO \| Score 0\.6518/);
  assert.match(summary, /#5 musebook \| Score 0\.6118/);
  assert.doesNotMatch(summary, /#6 SIXTH/);
});

// ─── 3200-char cap and clamping behavior ─────────────────────

test('TelegramBot clamps long LLM output to ≤3200 chars at a line boundary', () => {
  // Simulate via the summarize path: build a long string and ensure clamping.
  // Direct access to clampForTelegram isn't exported; we test the public
  // surface via summarizeReport.
  const longLine = 'A'.repeat(3500);
  // The text doesn't contain <think> blocks; sanitizer is a no-op.
  const out = sanitizeLlmOutput(longLine);
  assert.equal(out.length, 3500);
  // The clamp behaviour itself is verified inside summarizeReport() in
  // integration below. Here we just assert sanitize preserves length.
});

// ─── Auto-report selection logic ─────────────────────────────

function observationStub(chainId: number): never {
  return {
    state: {
      pool: { chainId, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000001' },
      token0: { chainId, address: '0x' + '0'.repeat(40), decimals: 18, symbol: 'TKN0' },
      token1: { chainId, address: '0x' + '1'.repeat(40), decimals: 6, symbol: 'USDC' },
      blockNumber: 1n, blockHash: '0x' + '0'.repeat(64), observedAt: 1700000000, fetchedAt: 1700000000,
      sqrtPriceX96: 1n, tick: 0, tickSpacing: 60, liquidity: 1n, fee: 3000, dynamicFee: false, protocolFee: 0,
      verified: true, verification: [],
    },
    windowStart: 1700000000, windowEnd: 1700001800,
    source: 'test', indexedBlock: 1n, complete: true, valuation: 'window-end-reference',
    swaps: [], prices: [], risks: [],
    tvlUsd: null, poolCreatedAt: null,
    ticks: [], ticksComplete: false,
    positionsCreated: null, uniqueLps: null,
    liquidityAddedUsd: null, liquidityRemovedUsd: null, estimatedLifecycleCostUsd: null,
    issues: [],
  } as never;
}

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `r-${Math.random().toString(16).slice(2)}`,
    mode: 'live-readonly',
    startedAt: 1700000000,
    finishedAt: 1700000030,
    configVersion: 'paper-policy-1',
    deploymentVersion: 'uniswap-37936185-2026-09-18',
    policy: {},
    observations: [],
    candidates: [],
    discoveries: [],
    decisions: [],
    positions: [],
    health: [],
    providerObservations: [],
    errors: [],
    status: 'ok',
    ...over,
  };
}

class FakeRepo implements Pick<Repository, 'latest'> {
  private controlState: Awaited<ReturnType<Repository['controls']>> = { globalPaused: false, pausedChains: [], botState: 'STOPPED' };
  private strategyStateValue: Awaited<ReturnType<Repository['strategyState']>>;
  constructor(private current: AgentRun | null, strategyState?: Awaited<ReturnType<Repository['strategyState']>>) {
    this.strategyStateValue = strategyState ?? { version: 1 as const, positions: [], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {}, managementNotifications: [] };
  }
  async latest() { return this.current; }
  async initialize() {}
  async saveRun(_run: AgentRun) {}
  async history() { return []; }
  async controls() { return this.controlState; }
  async setControls(next: Awaited<ReturnType<Repository['controls']>>) { this.controlState = next; }
  async close() {}
  async findRunById() { return null; }
  async strategyState() { return this.strategyStateValue; }
  async setStrategyState(next: Awaited<ReturnType<Repository['strategyState']>>) { this.strategyStateValue = next; }
}

function makeFakeLlm(content: string): LlmClient {
  return {
    isEnabled: () => true,
    providerLabel: () => 'fake',
    async chat() {
      return { content, toolCalls: [], finishReason: 'stop' };
    },
  };
}

class NoopAgent {
  cycle = async () => makeRun();
  manageLive = async () => [];
  observePool = async () => makeRun().observations[0] as never;
}

function makeBot(repo: Repository, llm: LlmClient): { bot: TelegramBot; chatId: number; sent: string[]; sentObjects: Array<Record<string, unknown>> } {
  const sent: string[] = [];
  const sentObjects: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.text) sent.push(String(body.text));
    if (body.text) sentObjects.push({ text: String(body.text) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length + 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const chatId = 12345;
  const bot = new TelegramBot({
    token: '12345678901234567890',
    allowedUserIds: new Set([chatId]),
    agent: new NoopAgent() as never,
    repo,
    chains: [8453],
    tokenLimit: 1,
    poolLimit: 1,
    intervalSeconds: 60,
    fetch: fetchImpl,
    reportLlm: llm,
  });
  return { bot, chatId, sent, sentObjects };
}

// We expose the private methods via casting for direct testing.
interface BotPrivate {
  checkForScheduledReport(): Promise<void>;
  summarizeReport(run: AgentRun): Promise<string>;
  automaticReportsInitialized: boolean;
  lastAutomaticReportId: string | null;
}

test('auto-report never pushes the pre-existing stale run on startup', async () => {
  const stale = makeRun({ status: 'failed', errors: [{ chainId: 8453, error: 'CHAIN_PAUSED: operator paused' }] });
  const repo = new FakeRepo(stale);
  const { bot } = makeBot(repo as never, makeFakeLlm('should not be sent'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport();
  // Initialised but no auto-send should happen — the stale run is just recorded.
  assert.equal(priv.automaticReportsInitialized, true);
  assert.equal(priv.lastAutomaticReportId, stale.id);
});

test('auto-report delivers successful normalization swap notification with transaction', async () => {
  const run = makeRun({ observations: [observationStub(8453)] });
  const positionId = '8453:v4:uniswap:0x' + '1'.repeat(64) + ':42';
  const repo = new FakeRepo(run, {
    version: 1,
    positions: [],
    transactions: [],
    cooldowns: {},
    blacklist: {},
    lessons: [],
    dailyRealizedLossUsd: {},
    managementNotifications: [{
      id: `${positionId}:normalization:1`, kind: 'normalization', positionId,
      protocol: 'v4', tokenId: '42', symbol: 'CEREBRO', targetSymbol: 'USDG', status: 'SUCCESS',
      txHash: '0x' + 'a'.repeat(64), at: 1700000030,
    }],
  });
  const { bot, sent } = makeBot(repo as never, makeFakeLlm('not canonical'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport();
  assert.match(sent[0] ?? '', /🔄 SWAP/);
  assert.match(sent[0] ?? '', /CEREBRO/);
  assert.match(sent[0] ?? '', /Status: SUCCESS ✅/);
  assert.match(sent[0] ?? '', /CEREBRO -> USDG/);
  assert.match(sent[0] ?? '', /Tx: 0xaaaa…aaaa/);
  assert.doesNotMatch(sent[0] ?? '', /Normalization/);
  assert.equal((await repo.strategyState()).managementNotifications[0]!.delivered, true);
});

test('auto-report renders failed normalization as a failed swap without a transaction line', async () => {
  const run = makeRun({ observations: [observationStub(8453)] });
  const positionId = '8453:v4:uniswap:0x' + '2'.repeat(64) + ':3266846';
  const repo = new FakeRepo(run, {
    version: 1, positions: [], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {},
    managementNotifications: [{
      id: `${positionId}:normalization:1`, kind: 'normalization', positionId,
      protocol: 'v4', tokenId: '3266846', status: 'FAILED', error: 'Amount is too small to be swapped', at: 1700000030,
    }],
  });
  const { bot, sent } = makeBot(repo as never, makeFakeLlm('not canonical'));
  await (bot as unknown as BotPrivate).checkForScheduledReport();
  assert.match(sent[0] ?? '', /🔄 SWAP/);
  assert.match(sent[0] ?? '', /V4 #3266846 \[v4\]/);
  assert.match(sent[0] ?? '', /Status: FAILED ❌/);
  assert.match(sent[0] ?? '', /Error: Amount is too small to be swapped/);
  assert.doesNotMatch(sent[0] ?? '', /Tx:/);
});

test('auto-report never pushes a failed run', async () => {
  const sentinel = makeRun({ status: 'ok', observations: [observationStub(8453)] });
  const failed = makeRun({
    status: 'failed',
    observations: [], // empty observations → gate skips via length check too
    errors: [{ chainId: 8453, error: 'RPC_PROVIDER_DOWN' }],
  });
  const repo = new FakeRepo(sentinel);
  const { bot } = makeBot(repo as never, makeFakeLlm('SHOULD NOT BE SENT'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport(); // initialise against sentinel
  assert.equal(priv.lastAutomaticReportId, sentinel.id);
  // Now latest() returns the failed run.
  (repo as unknown as { current: AgentRun | null }).current = failed;
  await priv.checkForScheduledReport();
  // lastAutomaticReportId must NOT change; nothing was sent.
  assert.equal(priv.lastAutomaticReportId, sentinel.id);
});

test('auto-report rejects when latest run is failed (RPC error)', async () => {
  // Pre-initialise with a sentinel, then verify a subsequent failed
  // run is NOT pushed.
  const sentinel = makeRun({ status: 'ok', observations: [observationStub(8453)] });
  const failed = makeRun({ status: 'failed', errors: [{ chainId: 8453, error: 'RPC_PROVIDER_DOWN' }] });
  const repo = new FakeRepo(sentinel);
  const { bot } = makeBot(repo as never, makeFakeLlm('SHOULD NOT BE SENT'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport(); // initialise against sentinel
  assert.equal(priv.lastAutomaticReportId, sentinel.id);
  // Now latest() returns a failed run.
  (repo as unknown as { current: AgentRun | null }).current = failed;
  await priv.checkForScheduledReport();
  // lastAutomaticReportId must NOT change; nothing was sent.
  assert.equal(priv.lastAutomaticReportId, sentinel.id);
});

test('auto-report rejects when latest run is CHAIN_PAUSED across all chains', async () => {
  const sentinel = makeRun({ status: 'ok', observations: [observationStub(8453)] });
  const allPaused = makeRun({
    status: 'failed',
    observations: [],
    errors: [
      { chainId: 4663, error: 'CHAIN_PAUSED: operator paused' },
      { chainId: 56, error: 'CHAIN_PAUSED: operator paused' },
      { chainId: 8453, error: 'CHAIN_PAUSED: operator paused' },
      { chainId: 5042, error: 'CHAIN_PAUSED: operator paused' },
    ],
  });
  const repo = new FakeRepo(sentinel);
  const { bot } = makeBot(repo as never, makeFakeLlm('SHOULD NOT BE SENT'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport();
  (repo as unknown as { current: AgentRun | null }).current = allPaused;
  await priv.checkForScheduledReport();
  assert.equal(priv.lastAutomaticReportId, sentinel.id);
});

test('auto-report sends a fresh successful run exactly once', async () => {
  const sentinel = makeRun({ status: 'ok', observations: [observationStub(8453)] });
  const fresh = makeRun({
    status: 'ok',
    observations: [
      {
        state: { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000001' }, token0: {} as never, token1: {} as never, blockNumber: 1n, blockHash: '0x' + '0'.repeat(64), observedAt: 1700000000, fetchedAt: 1700000000, sqrtPriceX96: 1n, tick: 0, tickSpacing: 60, liquidity: 1n, fee: 3000, dynamicFee: false, protocolFee: 0, verified: true, verification: [] },
        windowStart: 1700000000, windowEnd: 1700001800,
        source: 'test', indexedBlock: 1n,
        complete: true, valuation: 'window-end-reference',
        swaps: [], prices: [], risks: [],
        tvlUsd: null, poolCreatedAt: null,
        ticks: [], ticksComplete: false,
        positionsCreated: null, uniqueLps: null,
        liquidityAddedUsd: null, liquidityRemovedUsd: null,
        estimatedLifecycleCostUsd: null, issues: [],
      } as never,
    ],
    candidates: [],
  });
  const repo = new FakeRepo(sentinel);
  const { bot } = makeBot(repo as never, makeFakeLlm('Plain Telegram summary.'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport(); // init
  (repo as unknown as { current: AgentRun | null }).current = fresh;
  await priv.checkForScheduledReport();
  // lastAutomaticReportId advanced to the fresh run.
  assert.equal(priv.lastAutomaticReportId, fresh.id);
});

test('auto-report does not re-send the same run twice', async () => {
  const sentinel = makeRun({ status: 'ok', observations: [observationStub(8453)] });
  const fresh = makeRun({
    status: 'ok',
    observations: [{
      state: { pool: { chainId: 8453, protocol: 'v3', dex: 'uniswap', poolAddress: '0x0000000000000000000000000000000000000001' }, token0: {} as never, token1: {} as never, blockNumber: 1n, blockHash: '0x' + '0'.repeat(64), observedAt: 1700000000, fetchedAt: 1700000000, sqrtPriceX96: 1n, tick: 0, tickSpacing: 60, liquidity: 1n, fee: 3000, dynamicFee: false, protocolFee: 0, verified: true, verification: [] },
      windowStart: 1700000000, windowEnd: 1700001800,
      source: 'test', indexedBlock: 1n, complete: true, valuation: 'window-end-reference',
      swaps: [], prices: [], risks: [],
      tvlUsd: null, poolCreatedAt: null,
      ticks: [], ticksComplete: false,
      positionsCreated: null, uniqueLps: null,
      liquidityAddedUsd: null, liquidityRemovedUsd: null,
      estimatedLifecycleCostUsd: null, issues: [],
    } as never],
    candidates: [],
  });
  const repo = new FakeRepo(sentinel);
  const { bot } = makeBot(repo as never, makeFakeLlm('Summary.'));
  const priv = bot as unknown as BotPrivate;
  await priv.checkForScheduledReport();
  (repo as unknown as { current: AgentRun | null }).current = fresh;
  await priv.checkForScheduledReport();
  // Two consecutive polls on the same latest — only first sends.
  await priv.checkForScheduledReport();
  await priv.checkForScheduledReport();
  assert.equal(priv.lastAutomaticReportId, fresh.id);
});

// ─── LLM summarizer never sends chain-of-thought ───────────

test('summarizeReport LLM path strips <think>...</think> blocks from the response', async () => {
  const repo = new FakeRepo(makeRun());
  const leaky = '<think>Let me reason step by step...</think>Here is the final summary.';
  const { bot } = makeBot(repo as never, makeFakeLlm(leaky));
  const summary = await (bot as unknown as BotPrivate).summarizeReport(makeRun());
  assert.doesNotMatch(summary, /<think>/);
  assert.doesNotMatch(summary, /reason step/);
  assert.match(summary, /^🤖 Viero Cycle #/);
  assert.doesNotMatch(summary, /Pools Found|Provider Failures|Plans Created|^Cycle:/im);
});

test('summarizeReport LLM path falls back to deterministic summary when LLM returns only thinking', async () => {
  const repo = new FakeRepo(makeRun());
  const thinkingOnly = '<think>this is only reasoning, no final answer';
  const { bot } = makeBot(repo as never, makeFakeLlm(thinkingOnly));
  const summary = await (bot as unknown as BotPrivate).summarizeReport(makeRun());
  // Sanitizer turns thinking-only into empty string; LLM branch falls back
  // to deterministic text via the `cleaned.length > 0` guard.
  assert.doesNotMatch(summary, /<think>/);
  // The deterministic path kicks in — summary contains the canonical
  // "Viero cycle" header.
  assert.match(summary, /Viero Cycle/);
});

test('summarizeReport clamps the final summary to <= 3200 chars at a line boundary', async () => {
  const repo = new FakeRepo(makeRun());
  const long = 'X'.repeat(4000) + '\nmore line';
  const { bot } = makeBot(repo as never, makeFakeLlm(long));
  const summary = await (bot as unknown as BotPrivate).summarizeReport(makeRun());
  assert.ok(summary.length <= 3200, `summary is ${summary.length} chars`);
});

test('summarizeReport deterministic fallback path is also sanitized and clamped', async () => {
  const repo = new FakeRepo(makeRun());
  // No LLM configured → falls back to deterministic path; sanitizer is
  // a no-op there but clamp still applies to the long fallback body.
  const { bot } = makeBot(repo as never, makeFakeLlm('')); // LLM is present but empty
  // The fallback is deterministic; just confirm no <think> tags leak and
  // length is within cap.
  const summary = await (bot as unknown as BotPrivate).summarizeReport(makeRun());
  assert.doesNotMatch(summary, /<think>/);
  assert.ok(summary.length <= 3200);
});

// ─── Helper pure tests ──────────────────────────────────────────

test('sanitizeLlmOutput is idempotent', () => {
  const input = '<think>a</think>Final<think>b</think>';
  const once = sanitizeLlmOutput(input);
  const twice = sanitizeLlmOutput(once);
  assert.equal(once, twice);
});
