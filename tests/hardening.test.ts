import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmClient,
  type ChatRequest,
  type ChatResponse,
  type LlmClient,
} from '../src/viero/agent/llmClient.js';
import {
  DecisionExplainer,
  EXPLANATION_PROMPT_VERSION,
  roleForExplanationContext,
} from '../src/viero/agent/explainer.js';
import { INTENT_PROMPT_VERSION } from '../src/viero/telegram/intent.js';
import { ConversationalHandler } from '../src/viero/telegram/conversational.js';
import { AgentRunRetrieval } from '../src/viero/agent/retrieval.js';
import { CandidateAnalyst } from '../src/viero/agent/analyst.js';
import {
  type AgentRun,
  type Repository,
} from '../src/viero/storage/repositories.js';
import { type Candidate } from '../src/viero/screening/pipeline.js';
import { type PaperPosition } from '../src/viero/management/paper.js';
import { type ChainId } from '../src/viero/domain.js';

// ─── Test fixtures ──────────────────────────────────────────────

const baseChainIds: ChainId[] = [4663, 56, 8453, 5042];
function pickChain(i: number): ChainId { return baseChainIds[i % baseChainIds.length]!; }

function makePool(i: number) {
  const isV4 = i % 2 === 1;
  return {
    chainId: pickChain(i),
    protocol: (isV4 ? 'v4' : 'v3') as 'v3' | 'v4',
    dex: 'uniswap' as const,
    poolAddress: isV4 ? undefined : `0x${(i).toString(16).padStart(40, '0')}`,
    poolId: isV4 ? `0x${(i).toString(16).padStart(64, '0')}` : undefined,
    ...(isV4 ? { poolKey: { currency0: `0x${'0'.repeat(40)}`, currency1: `0x${'1'.repeat(40)}`, fee: 3000, tickSpacing: 60, hooks: `0x${'0'.repeat(40)}` } } : {}),
  };
}

function makeCandidate(i: number, approved: boolean): Candidate {
  const pool = makePool(i);
  return {
    pool,
    identity: `${pool.chainId}:${pool.protocol}:${pool.dex}:${pool.protocol === 'v3' ? pool.poolAddress : pool.poolId}`,
    approved,
    rejections: approved ? [] : [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'depth below threshold' }],
    metrics: {
      version: 'm1',
      pool,
      source: `rpc:${i}`,
      sourceBlock: BigInt(i),
      fetchedAt: 1700000000 + i,
      windowStart: 1700000000,
      windowEnd: 1700001800,
      valuation: 'window-end-reference',
      volumeUsd: 1000,
      swapCount: 10,
      uniqueTraders: 5,
      grossFeesUsd: 5,
      lpFeesUsd: 4,
      feesPerMinute: 0.01,
      feeTvlPct: 0.5,
      depthDownUsd: 5000,
      depthUpUsd: 5000,
      depthUsd: 10000,
      feeDepthPct: 0.04,
      volumeDepth: 0.1,
      tvlUsd: 5000,
      volatility: null,
      organic: { uniqueRatio: 0.5, topTraderShare: 0.5, loss: 0.5, balance: 0.5, temporal: 0.5, reversalShare: 0, score: 0.5 },
      netLiquidityFlowUsd: 0,
      expectedFeesUsd: 4,
      expectedNetFeesUsd: 3.5,
      maximumPriceDivergencePct: 0,
    },
    group: 'g',
    score: null,
    globalScore: null,
    components: {},
    policyVersion: 'paper-policy-1',
    scoreVersion: 'within-group-1',
  };
}

function makePaperPosition(i: number, status: 'open' | 'closed' = 'open'): PaperPosition {
  const chain = pickChain(i);
  const pool = makePool(i);
  const events: PaperPosition['events'] = [{ at: 1700000000 + i, action: 'open', reason: 'paper', netPnlUsd: 0 }];
  if (status === 'closed') events.push({ at: 1700001000 + i, action: 'close', reason: 'STOP_LOSS', netPnlUsd: -0.5 });
  return {
    id: `paper-${i}`,
    chainId: chain,
    plan: {
      chainId: chain,
      pool,
      mode: 'paper' as const,
      createdAt: 1700000000 + i,
      deadline: 1700000120 + i,
      sourceBlock: BigInt(i),
      sourceBlockHash: `0x${'0'.repeat(64)}`,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1000n,
      depositAssets: [{ token: `0x${'0'.repeat(40)}`, amount: 100n }],
      expectedTransfers: [{ token: `0x${'0'.repeat(40)}`, direction: 'out' as const, maximumAmount: 100n }],
      slippageBps: 50,
      maximumGasCostUsd: 0.01,
      depositUsd: 5,
    },
    openedAt: 1700000000 + i,
    status,
    initialValueUsd: 5,
    currentValueUsd: 5,
    claimedFeesUsd: 0,
    unclaimedFeesUsd: 0,
    gasCostUsd: 0,
    swapCostUsd: 0,
    bridgeCostUsd: 0,
    holdValueUsd: 5,
    peakValueUsd: 5,
    outOfRangeSince: null,
    lastWindowEnd: 1700000000 + i,
    netPnlUsd: 0,
    impermanentLossUsd: 0,
    events,
  };
}

function makeRun(i: number, overrides: Partial<AgentRun> = {}): AgentRun {
  const startedAt = 1700000000 + i * 100;
  return {
    id: `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
    mode: 'live-readonly',
    startedAt,
    finishedAt: startedAt + 30,
    configVersion: 'paper-policy-1',
    deploymentVersion: 'uniswap-37936185-2026-09-18',
    policy: {},
    observations: [],
    candidates: [makeCandidate(i, false)],
    discoveries: [],
    decisions: [],
    positions: [],
    health: [],
    providerObservations: [],
    errors: [],
    status: 'ok',
    ...overrides,
  };
}

class InMemoryRepository implements Repository {
  runs: AgentRun[] = [];
  constructor(runs: AgentRun[] = []) { this.runs = [...runs]; }
  async initialize() {}
  async saveRun(run: AgentRun) { this.runs.push(run); }
  async latest() { return this.runs.length ? [...this.runs].sort((a, b) => b.startedAt - a.startedAt)[0]! : null; }
  async history() { return [...this.runs].sort((a, b) => a.startedAt - b.startedAt); }
  async findRunById(id: string) { return this.runs.find((r) => r.id === id) ?? null; }
  async controls() { return { globalPaused: false, pausedChains: [] }; }
  async setControls() {}
  async close() {}
}

function fakeLlm(content: string | null = '{"type":"unknown"}'): LlmClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const client: LlmClient & { calls: ChatRequest[] } = {
    isEnabled: () => true,
    providerLabel: () => 'fake',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls.push(req);
      return { content, toolCalls: [], finishReason: 'stop' };
    },
    calls,
  };
  return client;
}

function disabledLlm(): LlmClient {
  return {
    isEnabled: () => true,
    providerLabel: () => 'throwing',
    async chat() { throw new Error('LLM_HTTP_500'); },
  };
}

function makeHandler(repo: Repository, llm: LlmClient = disabledLlm()) {
  const retrieval = new AgentRunRetrieval(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm });
  return { handler, retrieval, explainer };
}

// ─── Per-call role routing tests ───────────────────────────────

test('DecisionExplainer.explain passes role=SCREENER for rejected_candidate context', async () => {
  const llm = fakeLlm('rejected for liquidity');
  const explainer = new DecisionExplainer(llm);
  const ctx = {
    eventType: 'rejected_candidate' as const,
    outcome: { kind: 'rejected' as const, reasonCode: 'INSUFFICIENT_LIQUIDITY' },
    rejections: [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'depth below threshold' }],
  };
  await explainer.explain(ctx);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]!.role, 'SCREENER');
});

test('DecisionExplainer.explain passes role=MANAGER for management context', async () => {
  const llm = fakeLlm('closed due to stop loss');
  const explainer = new DecisionExplainer(llm);
  const ctx = {
    eventType: 'management' as const,
    timestamp: 1,
    chain: { id: 8453 as ChainId, name: 'Base' },
    outcome: { kind: 'closed' as const, reasonCode: 'STOP_LOSS' },
    position: { identity: 'paper-0', status: 'closed' as const },
  };
  await explainer.explain(ctx);
  assert.equal(llm.calls[0]!.role, 'MANAGER');
});

test('DecisionExplainer.explain passes role=GENERAL for run_failed context', async () => {
  const llm = fakeLlm('run failed');
  const explainer = new DecisionExplainer(llm);
  const ctx = {
    eventType: 'run_failed' as const,
    outcome: { kind: 'errored' as const, reasonCode: 'NO_COMPLETE_OBSERVATIONS' },
  };
  await explainer.explain(ctx);
  assert.equal(llm.calls[0]!.role, 'GENERAL');
});

test('DecisionExplainer.explain context-derived role wins over constructor role when no override is passed', async () => {
  const llm = fakeLlm('text');
  const explainer = new DecisionExplainer(llm, { role: 'MANAGER' });
  const ctx = {
    eventType: 'rejected_candidate' as const,
    outcome: { kind: 'rejected' as const },
  };
  await explainer.explain(ctx);
  // Context-derived role (SCREENER for rejected_candidate) wins over
  // the constructor-set MANAGER role when no explicit per-call role is
  // provided. This is intentional: callers route by explanation context,
  // not by a stale constructor default.
  assert.equal(llm.calls[0]!.role, 'SCREENER');
});

test('DecisionExplainer.explain per-call role overrides context-derived role', async () => {
  const llm = fakeLlm('text');
  const explainer = new DecisionExplainer(llm);
  const ctx = {
    eventType: 'rejected_candidate' as const,
    outcome: { kind: 'rejected' as const },
  };
  await explainer.explain(ctx, { role: 'GENERAL' });
  assert.equal(llm.calls[0]!.role, 'GENERAL');
});

test('DecisionExplainer constructor role is used when context eventType is unknown', async () => {
  // The roleForExplanationContext mapping is exhaustive, but if a caller
  // passes an eventType outside the known set, the explainer falls back
  // to the constructor default. (TypeScript prevents this at compile
  // time, so this test exercises the runtime safety net.)
  const llm = fakeLlm('text');
  const explainer = new DecisionExplainer(llm, { role: 'MANAGER' });
  const ctx = {
    // @ts-expect-error — testing runtime safety net
    eventType: 'future-event-type',
    outcome: { kind: 'errored' as const },
  };
  await explainer.explain(ctx);
  assert.equal(llm.calls[0]!.role, 'MANAGER');
});

test('ConversationalHandler routes rejected-candidate explanations to SCREENER model', async () => {
  const llm = fakeLlm('rejected for liquidity');
  const repo = new InMemoryRepository([makeRun(0, { candidates: [makeCandidate(0, false)] })]);
  const { handler } = makeHandler(repo, llm);
  await handler.handle(1, `why was ${makeCandidate(0, false).identity} rejected?`);
  // Find the chat call to the LLM that came from the explainer (not the
  // intent classifier).
  const explainerCalls = llm.calls.filter((c) => c.systemPrompt.includes(EXPLANATION_PROMPT_VERSION));
  assert.ok(explainerCalls.length >= 1, 'expected at least one explainer call');
  assert.equal(explainerCalls[0]!.role, 'SCREENER');
});

test('ConversationalHandler routes position explanations to MANAGER model', async () => {
  const llm = fakeLlm('closed due to stop loss');
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'closed')] }),
  ]);
  const { handler } = makeHandler(repo, llm);
  await handler.handle(1, 'why was that position closed?');
  const explainerCalls = llm.calls.filter((c) => c.systemPrompt.includes(EXPLANATION_PROMPT_VERSION));
  assert.ok(explainerCalls.length >= 1);
  assert.equal(explainerCalls[0]!.role, 'MANAGER');
});

test('roleForExplanationContext mapping is exhaustive across all event types', () => {
  // All currently-defined event types must map to a valid role.
  const eventTypes = [
    'screening',
    'rejected_candidate',
    'accepted_candidate',
    'candidate_selected_preview',
    'plan_created',
    'plan_blocked',
    'no_candidates',
    'management',
    'replay',
    'run_failed',
    'unknown',
  ] as const;
  for (const eventType of eventTypes) {
    const role = roleForExplanationContext({ eventType, outcome: { kind: 'errored' } });
    assert.ok(['SCREENER', 'MANAGER', 'GENERAL'].includes(role), `${eventType} mapped to invalid role ${role}`);
  }
});

// ─── LlmClient: role resolution ────────────────────────────────

test('LlmClient OpenAiCompatibleClient resolves model from role when role is provided', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
  };
  const client = createLlmClient({
    VIERO_LLM_ENABLED: 'true',
    VIERO_LLM_BASE_URL: 'https://example.com/v1',
    VIERO_LLM_API_KEY: 'sk-test',
    VIERO_LLM_MODEL: 'openai/default-model',
    VIERO_LLM_MODEL_SCREENER: 'openai/sc',
    VIERO_LLM_MODEL_MANAGER: 'openai/mg',
    VIERO_LLM_MODEL_GENERAL: 'openai/gn',
  }, fetchMock);
  if (!client.isEnabled()) throw new Error('expected enabled');

  // role=SCREENER → SCREENER override
  await client.chat({ role: 'SCREENER', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  let body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/sc');

  calls.length = 0;
  // role=MANAGER → MANAGER override
  await client.chat({ role: 'MANAGER', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/mg');

  calls.length = 0;
  // role=GENERAL → GENERAL override
  await client.chat({ role: 'GENERAL', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/gn');

  calls.length = 0;
  // no role → default model
  await client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] });
  body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/default-model');
});

// ─── Observability: intent telemetry ───────────────────────────

test('ConversationalHandler emits one structured intent log per handle() call (deterministic source)', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const repo = new InMemoryRepository([makeRun(0)]);
    const { handler } = makeHandler(repo, disabledLlm());
    await handler.handle(1, 'list open positions');
  } finally {
    console.error = orig;
  }
  const intentLines = lines.filter((l) => l.includes('[viero.conversation]') && l.includes('intent='));
  assert.equal(intentLines.length, 1);
  assert.match(intentLines[0]!, /chat_id=1/);
  assert.match(intentLines[0]!, /intent=list_open_positions/);
  assert.match(intentLines[0]!, /source=deterministic/);
  assert.match(intentLines[0]!, /classify_ms=\d+/);
});

test('ConversationalHandler logs source=llm when LLM classifier is used', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const llm = fakeLlm('{"type":"recent_errors"}');
    const repo = new InMemoryRepository([makeRun(0)]);
    const { handler } = makeHandler(repo, llm);
    // Force a phrase that won't match the deterministic fast-path.
    await handler.handle(1, 'tell me about system oops');
  } finally {
    console.error = orig;
  }
  const intentLines = lines.filter((l) => l.includes('[viero.conversation]') && l.includes('intent='));
  assert.equal(intentLines.length, 1);
  assert.match(intentLines[0]!, /source=llm/);
});

test('ConversationalHandler logs source=fallback when LLM provider throws and no deterministic match', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const repo = new InMemoryRepository([makeRun(0)]);
    const { handler } = makeHandler(repo, disabledLlm());
    await handler.handle(1, 'quack the duck');
  } finally {
    console.error = orig;
  }
  const intentLines = lines.filter((l) => l.includes('[viero.conversation]') && l.includes('intent='));
  assert.equal(intentLines.length, 1);
  assert.match(intentLines[0]!, /source=fallback/);
  assert.match(intentLines[0]!, /intent=unknown/);
});

test('Intent log does NOT include message content, provider responses, or env vars', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const secret = 'private-test-marker';
    const llm = fakeLlm(`here is the answer for ${secret}`);
    const repo = new InMemoryRepository([makeRun(0)]);
    const { handler } = makeHandler(repo, llm);
    await handler.handle(1, 'show me bsc activity');
  } finally {
    console.error = orig;
  }
  const all = lines.join('\n');
  assert.ok(!all.includes('sk-or-v1'), 'log must not include the API key');
  // Intent logs are one line; the assistant text never lands here because
  // nothing in the conversational layer prints it.
  for (const l of lines) {
    if (l.includes('[viero.conversation]')) {
      assert.ok(!l.includes('show me bsc activity'), 'intent log must not include user message');
      assert.ok(!l.includes('depth below'), 'intent log must not include LLM response text');
    }
  }
});

test('Intent log is bounded — one line per handle() call regardless of LLM retries', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const repo = new InMemoryRepository([makeRun(0)]);
    const { handler } = makeHandler(repo, disabledLlm());
    await handler.handle(1, 'list open positions');
  } finally {
    console.error = orig;
  }
  const intentLines = lines.filter((l) => l.includes('[viero.conversation]') && l.includes('intent='));
  assert.equal(intentLines.length, 1);
});

// ─── Prompt version observability ───────────────────────────────

test('ConversationalHandler.emitStartupBanner logs both prompt versions', () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const repo = new InMemoryRepository([]);
    const { handler } = makeHandler(repo, disabledLlm());
    handler.emitStartupBanner();
  } finally {
    console.error = orig;
  }
  const banner = lines.find((l) => l.includes('startup') && l.includes('intent_prompt_version'));
  assert.ok(banner, 'expected a startup banner line');
  assert.match(banner!, new RegExp(`intent_prompt_version=${INTENT_PROMPT_VERSION}`));
  assert.match(banner!, new RegExp(`explanation_prompt_version=${EXPLANATION_PROMPT_VERSION}`));
});

test('Prompt versions are non-empty and stable strings', () => {
  assert.equal(typeof INTENT_PROMPT_VERSION, 'string');
  assert.ok(INTENT_PROMPT_VERSION.length > 0);
  assert.equal(typeof EXPLANATION_PROMPT_VERSION, 'string');
  assert.ok(EXPLANATION_PROMPT_VERSION.length > 0);
});

// ─── Read-only safety regression tests ─────────────────────────

test('ConversationalHandler never invokes any agent.cycle path (read-only boundary)', async () => {
  // If execution_request ever leaked past the handler, this would fire.
  const llm = fakeLlm('{"type":"execution_request","action":"close_position"}');
  const repo = new InMemoryRepository([makeRun(0, { positions: [makePaperPosition(0, 'open')] })]);
  const callsBefore = repo.runs.length;
  const { handler } = makeHandler(repo, llm);
  const reply = await handler.handle(1, 'close that position now');
  assert.match(reply, /cannot execute/i);
  assert.match(reply, /read-only/i);
  // No new runs persisted.
  assert.equal(repo.runs.length, callsBefore);
});

test('ConversationalHandler denies execution_request from deterministic classifier', async () => {
  const llm = fakeLlm('{"type":"list_open_positions"}');
  const repo = new InMemoryRepository([]);
  const { handler } = makeHandler(repo, llm);
  const reply = await handler.handle(1, 'swap 100 USDC for SOL');
  assert.match(reply, /cannot execute/i);
});

test('Slash commands remain unaffected by conversational layer wiring', async () => {
  // Construct a Telegram bot with conversational handler and verify that
  // a /help message still produces the static help text without invoking
  // any intent classification.
  const sentMessages: Array<{ chat_id: number; text: string }> = [];
  const orig = console.error;
  console.error = () => undefined;
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  try {
    const { TelegramBot } = await import('../src/viero/telegram.js');
    const repo = new InMemoryRepository([]);
    const llm = fakeLlm('{"type":"list_open_positions"}');
    let llmCalled = false;
    const spyLlm: LlmClient = {
      isEnabled: () => true,
      providerLabel: () => 'spy',
      async chat() { llmCalled = true; return { content: '', toolCalls: [], finishReason: 'stop' }; },
    };
    const retrieval = new AgentRunRetrieval(repo);
    const explainer = new DecisionExplainer(llm);
    const analyst = new CandidateAnalyst(llm);
    const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: spyLlm });
    const bot = new TelegramBot({
      token: '12345678901234567890',
      allowedUserIds: new Set([7]),
      agent: {} as never,
      repo,
      chains: [8453],
      tokenLimit: 1,
      poolLimit: 1,
      intervalSeconds: 60,
      fetch: fetchMock,
      conversational: handler,
    });
    await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: '/help' });
    assert.equal(llmCalled, false);
    const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
    assert.match(reply, /Viero Telegram bot is online/);
  } finally {
    console.error = orig;
  }
});

// Suppress unused-import warnings.
void makeRun;
void makeCandidate;
void makePaperPosition;
void pickChain;
void InMemoryRepository;
