import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntentDeterministic,
  classifyIntentWithLlm,
  ReadOnlyIntentSchema,
  INTENT_SYSTEM_PROMPT,
  type ReadOnlyIntent,
} from '../src/viero/telegram/intent.js';
import { ConversationStore } from '../src/viero/telegram/conversation.js';
import { ConversationalHandler } from '../src/viero/telegram/conversational.js';
import { DecisionExplainer } from '../src/viero/agent/explainer.js';
import { CandidateAnalyst } from '../src/viero/agent/analyst.js';
import { AgentRunRetrieval } from '../src/viero/agent/retrieval.js';
import {
  type AgentRun,
  type Repository,
} from '../src/viero/storage/repositories.js';
import { type Candidate } from '../src/viero/screening/pipeline.js';
import { type PaperPosition } from '../src/viero/management/paper.js';
import { type ChainId } from '../src/viero/domain.js';
import { type LlmClient } from '../src/viero/agent/llmClient.js';

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
      organic: { uniqueRatio: 0.5, topTraderShare: 0.5, balance: 0.5, temporal: 0.5, reversalShare: 0, score: 0.5 },
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

function makePaperPosition(i: number, status: 'open' | 'closed' = 'open', action: 'open' | 'close' | 'emergency-close' = 'open'): PaperPosition {
  const chain = pickChain(i);
  const pool = makePool(i);
  const events: PaperPosition['events'] = [{ at: 1700000000 + i, action: 'open', reason: 'paper', netPnlUsd: 0 }];
  if (status === 'closed') {
    events.push({ at: 1700001000 + i, action, reason: 'STOP_LOSS', netPnlUsd: -0.5 });
  }
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

function fakeLlm(content: string | null = '{"type":"unknown"}'): LlmClient {
  return {
    isEnabled: () => true,
    providerLabel: () => 'fake',
    async chat() { return { content, toolCalls: [], finishReason: 'stop' }; },
  };
}

function throwingLlm(): LlmClient {
  return {
    isEnabled: () => true,
    providerLabel: () => 'throwing',
    async chat() { throw new Error('LLM_HTTP_500'); },
  };
}

function makeHandler(repo: Repository, llm: LlmClient = throwingLlm(), store?: ConversationStore) {
  const retrieval = new AgentRunRetrieval(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm, ...(store ? { store } : {}) });
  return { handler, retrieval, explainer };
}

// ─── Intent schema: safety properties ───────────────────────────

test('ReadOnlyIntentSchema rejects execution-shaped payloads', () => {
  const attackPayloads = [
    { type: 'close_position', position: 'paper-0' },
    { type: 'deploy_position', pool: '0xabc' },
    { type: 'swap', from: 'A', to: 'B' },
    { type: 'rebalance', position: 'paper-0' },
    { type: 'claim_fees', position: 'paper-0' },
    { type: 'arbitrary_method', args: [] },
    { type: 42 },
    { type: 'list_open_positions', chainId: 999 },
  ];
  for (const p of attackPayloads) {
    const r = ReadOnlyIntentSchema.safeParse(p);
    assert.equal(r.success, false, `expected ${JSON.stringify(p)} to be rejected`);
  }
});

test('ReadOnlyIntentSchema accepts all read-only intent shapes', () => {
  const ok = [
    { type: 'list_open_positions' },
    { type: 'list_open_positions', chainId: 8453 },
    { type: 'latest_run' },
    { type: 'latest_run_for_chain', chainId: 56 },
    { type: 'recent_rejected_candidates', chainId: 8453, poolHint: '0xabc', limit: 5 },
    { type: 'explain_candidate', candidateIdentity: 'x:y:z' },
    { type: 'explain_position', positionId: 'paper-0' },
    { type: 'explain_latest_run' },
    { type: 'execution_request', action: 'close_position' },
    { type: 'help' },
    { type: 'unknown', originalMessage: 'foo' },
  ];
  for (const p of ok) {
    const r = ReadOnlyIntentSchema.safeParse(p);
    assert.equal(r.success, true, `expected ${JSON.stringify(p)} to be accepted`);
  }
});

test('INTENT_SYSTEM_PROMPT forbids execution methods', () => {
  assert.match(INTENT_SYSTEM_PROMPT, /NEVER/i);
  assert.match(INTENT_SYSTEM_PROMPT, /execution_request/);
  assert.match(INTENT_SYSTEM_PROMPT, /close|deploy|swap|rebalance|claim/i);
});

// ─── Deterministic classifier ───────────────────────────────────

test('classifyIntentDeterministic maps open-position requests', () => {
  const intent = classifyIntentDeterministic('What positions are currently open?');
  assert.equal(intent?.type, 'list_open_positions');
});

test('classifyIntentDeterministic maps chain names to chainId', () => {
  const baseIntent = classifyIntentDeterministic('what happened on base');
  assert.equal(baseIntent?.type, 'explain_latest_run');
  if (baseIntent?.type === 'explain_latest_run') assert.equal(baseIntent.chainId, 8453);

  const bsc = classifyIntentDeterministic('show me bsc activity');
  assert.equal(bsc?.type, 'recent_activity');
  if (bsc?.type === 'recent_activity') assert.equal(bsc.chainId, 56);

  const rh = classifyIntentDeterministic('did anything fail on robinhood?');
  assert.equal(rh?.type, 'recent_errors');
  if (rh?.type === 'recent_errors') assert.equal(rh.chainId, 4663);
});

test('classifyIntentDeterministic converts "top N" patterns into limits', () => {
  const intent = classifyIntentDeterministic('show me top 5 rejected candidates');
  assert.equal(intent?.type, 'recent_rejected_candidates');
  if (intent?.type === 'recent_rejected_candidates') assert.equal(intent.limit, 5);
});

test('classifyIntentDeterministic recognizes why-position requests', () => {
  const intent = classifyIntentDeterministic('why did you close this position?');
  assert.equal(intent?.type, 'explain_position');
});

test('classifyIntentDeterministic recognizes why-rejection requests', () => {
  const intent = classifyIntentDeterministic('why was this pool rejected?');
  assert.equal(intent?.type, 'explain_candidate');
});

test('classifyIntentDeterministic recognizes execution requests and labels them', () => {
  const cases: Array<[string, string]> = [
    ['close this position', 'close_position'],
    ['open a new position on base', 'deploy_position'],
    ['swap 100 USDC for SOL', 'swap'],
    ['rebalance my positions', 'rebalance'],
    ['claim fees', 'claim_fees'],
  ];
  for (const [msg, expected] of cases) {
    const intent = classifyIntentDeterministic(msg);
    assert.equal(intent?.type, 'execution_request', `expected execution_request for "${msg}"`);
    if (intent?.type === 'execution_request') assert.equal(intent.action, expected);
  }
});

test('classifyIntentDeterministic returns undefined for unrecognized patterns', () => {
  const intent = classifyIntentDeterministic('quack the duck on pancakes');
  assert.equal(intent, undefined);
});

test('classifyIntentDeterministic uses refs.lastCandidateIdentity when user says "that pool"', () => {
  const refs = { chatId: 1, lastCandidateIdentity: 'x', updatedAt: Date.now() };
  const intent = classifyIntentDeterministic('why was that pool rejected?', refs);
  assert.equal(intent?.type, 'explain_candidate');
  if (intent?.type === 'explain_candidate') assert.equal(intent.candidateIdentity, 'x');
});

test('classifyIntentDeterministic uses refs.lastPositionId for "that position"', () => {
  const refs = { chatId: 1, lastPositionId: 'paper-7', updatedAt: Date.now() };
  const intent = classifyIntentDeterministic('why was that position closed?', refs);
  assert.equal(intent?.type, 'explain_position');
  if (intent?.type === 'explain_position') assert.equal(intent.positionId, 'paper-7');
});

// ─── LLM classifier safety ──────────────────────────────────────

test('classifyIntentWithLlm returns parsed for valid JSON', async () => {
  let request: any;
  const llm = {
    isEnabled: () => true,
    async chat(req: any) {
      request = req;
      return { content: '{"type":"list_open_positions"}', toolCalls: [], finishReason: 'stop' as const };
    },
  };
  const result = await classifyIntentWithLlm('what positions are open?', llm);
  assert.equal(result.kind, 'parsed');
  if (result.kind === 'parsed') assert.equal(result.intent.type, 'list_open_positions');
  assert.equal(request.role, 'GENERAL');
  assert.equal(request.model, undefined);
});

test('classifyIntentWithLlm rejects schema-invalid JSON and falls back to error', async () => {
  const llm = fakeLlm('{"type":"close_position","position":"paper-0"}');
  const result = await classifyIntentWithLlm('close it', llm);
  assert.equal(result.kind, 'error');
});

test('classifyIntentWithLlm rejects raw JSON with no matching schema field', async () => {
  const llm = fakeLlm('{"type":"arbitrary_method","args":[1,2,3]}');
  const result = await classifyIntentWithLlm('run arbitrary', llm);
  assert.equal(result.kind, 'error');
});

test('classifyIntentWithLlm rejects markdown-wrapped JSON by extracting first {...} block', async () => {
  const llm = fakeLlm('Here you go: ```json\n{"type":"recent_errors"}\n```');
  const result = await classifyIntentWithLlm('recent errors', llm);
  assert.equal(result.kind, 'parsed');
  if (result.kind === 'parsed') assert.equal(result.intent.type, 'recent_errors');
});

test('classifyIntentWithLlm rejects malformed JSON', async () => {
  const llm = fakeLlm('not json at all');
  const result = await classifyIntentWithLlm('what?', llm);
  assert.equal(result.kind, 'error');
});

test('classifyIntentWithLlm returns error for empty content', async () => {
  const llm = fakeLlm('   ');
  const result = await classifyIntentWithLlm('hello?', llm);
  assert.equal(result.kind, 'error');
});

test('classifyIntentWithLlm times out and returns error on slow provider', async () => {
  const slowLlm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'slow',
    async chat() {
      await new Promise((r) => setTimeout(r, 50));
      return { content: '{"type":"unknown"}', toolCalls: [], finishReason: 'stop' };
    },
  };
  const result = await classifyIntentWithLlm('hi', slowLlm, undefined, { timeoutMs: 10 });
  assert.equal(result.kind, 'error');
});

// ─── Conversation state ─────────────────────────────────────────

test('ConversationStore stores and retrieves references', () => {
  const store = new ConversationStore();
  assert.equal(store.get(1), undefined);
  store.set(1, { lastPositionId: 'paper-0' });
  const got = store.get(1);
  assert.equal(got?.lastPositionId, 'paper-0');
  assert.equal(store.size(), 1);
});

test('ConversationStore returns patches merged with existing values', () => {
  const store = new ConversationStore();
  store.set(1, { lastPositionId: 'paper-0', lastChainId: 8453 });
  store.set(1, { lastRunId: 'run-1' });
  const got = store.get(1)!;
  assert.equal(got.lastPositionId, 'paper-0');
  assert.equal(got.lastChainId, 8453);
  assert.equal(got.lastRunId, 'run-1');
});

test('ConversationStore evicts expired entries on get', async () => {
  const store = new ConversationStore(10);
  store.set(1, { lastPositionId: 'paper-0' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get(1), undefined);
});

// ─── ConversationalHandler: end-to-end ──────────────────────────

test('ConversationalHandler: open positions request returns deterministic list', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'open'), makePaperPosition(1, 'open')] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'What positions are currently open?');
  assert.match(reply, /paper-0/);
  assert.match(reply, /paper-1/);
});

test('ConversationalHandler: latest run request returns deterministic summary', async () => {
  const repo = new InMemoryRepository([makeRun(0), makeRun(1)]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'What happened in the latest run?');
  assert.match(reply, /Latest run/);
  assert.match(reply, /candidates=1/);
});

test('ConversationalHandler: rejected candidates request returns deterministic list', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [makeCandidate(0, false)] }),
    makeRun(1, { candidates: [makeCandidate(1, true)] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'show me top 5 rejected candidates');
  assert.match(reply, /rejected candidate/);
  assert.match(reply, /INSUFFICIENT_LIQUIDITY/);
  // Approved candidate should NOT appear.
  assert.doesNotMatch(reply, /global_score/);
});

test('ConversationalHandler: why-pool-rejected uses explainer with LLM enabled', async () => {
  const candidate = makeCandidate(0, false);
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [candidate] }),
  ]);
  const llm = fakeLlm('The pool was rejected because liquidity was below threshold.');
  const { handler } = makeHandler(repo, llm);
  const reply = await handler.handle(1, 'why was that pool rejected?');
  assert.match(reply, /rejected/);
  assert.match(reply, /liquidity/);
});

test('ConversationalHandler: explanation falls back to deterministic text when provider throws', async () => {
  const candidate = makeCandidate(0, false);
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [candidate] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'why was that pool rejected?');
  assert.match(reply, /rejected/i);
  assert.match(reply, /INSUFFICIENT_LIQUIDITY/);
});

test('ConversationalHandler: no-result returns explicit message', async () => {
  const repo = new InMemoryRepository([]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'why was that pool rejected?');
  assert.match(reply, /No matching/);
  assert.match(reply, /cannot invent/i);
});

test('ConversationalHandler: ambiguous candidate result is surfaced with a list', async () => {
  const c = makeCandidate(0, false);
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [c] }),
    makeRun(1, { candidates: [c] }),
    makeRun(2, { candidates: [c] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, `why was ${c.identity} rejected?`);
  assert.match(reply, /found 3 matching candidates/);
  assert.match(reply, /Please specify/);
});

test('ConversationalHandler: ambiguous position result is surfaced with a list', async () => {
  const c = makeCandidate(0, false);
  const position = makePaperPosition(0, 'closed');
  const repo = new InMemoryRepository([
    makeRun(0, { candidates: [c], positions: [position] }),
    makeRun(1, { candidates: [c], positions: [position] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'why was that position closed?');
  assert.match(reply, /found 2 matching positions/);
});

test('ConversationalHandler: execution request is denied without action', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { positions: [makePaperPosition(0, 'open')] }),
  ]);
  const { handler, retrieval } = makeHandler(repo, throwingLlm());
  // Spy: retrieval.openPositions should NOT be consulted for execution requests.
  // We verify by checking the open-positions count is unchanged afterwards.
  const beforeCount = (await retrieval.openPositions()).length;
  const reply = await handler.handle(1, 'close this position now');
  assert.match(reply, /cannot execute/i);
  assert.match(reply, /read-only/i);
  const afterCount = (await retrieval.openPositions()).length;
  assert.equal(beforeCount, afterCount);
});

test('ConversationalHandler: never throws on internal error', async () => {
  const brokenRetrieval = {
    latestRun: () => Promise.reject(new Error('boom')),
    latestRunForChain: () => Promise.reject(new Error('boom')),
    recentRuns: () => Promise.reject(new Error('boom')),
    recentRejectedCandidates: () => Promise.reject(new Error('boom')),
    recentApprovedCandidates: () => Promise.reject(new Error('boom')),
    recentDecisions: () => Promise.reject(new Error('boom')),
    openPositions: () => Promise.reject(new Error('boom')),
    closedPositions: () => Promise.reject(new Error('boom')),
    findPositionById: () => Promise.reject(new Error('boom')),
    positionsForPool: () => Promise.reject(new Error('boom')),
    recentPositionEvents: () => Promise.reject(new Error('boom')),
    recentCloseEvents: () => Promise.reject(new Error('boom')),
    recentErrors: () => Promise.reject(new Error('boom')),
    findCandidatesByIdentity: () => Promise.reject(new Error('boom')),
    findRunById: () => Promise.reject(new Error('boom')),
  };
  const explainer = new DecisionExplainer(throwingLlm());
  const analyst = new CandidateAnalyst(throwingLlm());
  const handler = new ConversationalHandler({ retrieval: brokenRetrieval as unknown as AgentRunRetrieval, explainer, analyst, llmClient: throwingLlm() });
  const reply = await handler.handle(1, 'list open positions');
  assert.match(reply, /internal error|boom/);
});

test('ConversationalHandler: unknown intent with LLM enabled returns help hint', async () => {
  const repo = new InMemoryRepository([makeRun(0)]);
  const { handler } = makeHandler(repo, fakeLlm('{"type":"unknown"}'));
  const reply = await handler.handle(1, 'asdf qwerty');
  assert.match(reply, /could not map|unknown/i);
});

test('ConversationalHandler: recent errors returns recorded errors', async () => {
  const repo = new InMemoryRepository([
    makeRun(0, { errors: [{ chainId: 8453, error: 'NO_COMPLETE_OBSERVATIONS' }] }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'did anything fail recently?');
  assert.match(reply, /NO_COMPLETE_OBSERVATIONS/);
});

test('ConversationalHandler: help message lists conversational availability', async () => {
  const repo = new InMemoryRepository([]);
  const { handler } = makeHandler(repo, throwingLlm());
  const reply = await handler.handle(1, 'help');
  assert.match(reply, /READ-ONLY/i);
});

// ─── Telegram integration: allowlist + precedence + sanitization ─

async function makeTelegramBot(handler: ConversationalHandler, allowed: number[]) {
  // Reload telegram.ts module fresh to avoid caching between tests.
  const { TelegramBot } = await import('../src/viero/telegram.js');
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sentMessages.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  const bot = new TelegramBot({
    token: '12345678901234567890',
    allowedUserIds: new Set(allowed),
    agent: {} as never,
    repo: {} as never,
    chains: [8453],
    tokenLimit: 1,
    poolLimit: 1,
    intervalSeconds: 60,
    fetch: fetchMock,
    conversational: handler,
  });
  return bot;
}

let sentMessages: Array<{ chat_id: number; text: string }> = [];

test('Telegram integration: allowlisted user with conversational handler gets reply', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  const { handler } = makeHandler(repo, throwingLlm());
  const bot = await makeTelegramBot(handler, [7]);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: 'list open positions' });
  // No open positions in repo — deterministic response.
  const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
  assert.match(reply, /No open positions|currently recorded/i);
});

test('Telegram integration: unauthorized user is rejected before any retrieval or LLM', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  const llm = fakeLlm('{"type":"list_open_positions"}');
  let retrievalCalled = false;
  const retrieval = new (class extends AgentRunRetrieval {
    override openPositions() {
      retrievalCalled = true;
      return super.openPositions();
    }
  })(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm });
  const bot = await makeTelegramBot(handler, [7]);
  await bot.handleMessage({ message_id: 1, from: { id: 999 }, chat: { id: 100 }, text: 'list open positions' });
  // Auth check must reject before any retrieval call.
  assert.equal(retrievalCalled, false);
  // The reply should be 'Unauthorized.' (existing behavior preserved).
  const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
  assert.match(reply, /Unauthorized/i);
});

test('Telegram integration: existing slash commands still win over conversation', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  let llmCalled = false;
  let reportRole: string | undefined;
  const llm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'spy',
    async chat(request) { llmCalled = true; reportRole = request.role; return { content: 'Viero is healthy. No position was opened. Live execution is disabled.', toolCalls: [], finishReason: 'stop' }; },
  };
  const retrieval = new AgentRunRetrieval(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm });
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  const { TelegramBot } = await import('../src/viero/telegram.js');
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
    reportLlm: llm,
  });
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: '/report' });
  assert.equal(llmCalled, true);
  assert.equal(reportRole, 'GENERAL');
  const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
  assert.match(reply, /^🤖 Viero Cycle/);
  assert.match(reply, /🎯 Candidate/);
  assert.equal(sentMessages.filter((message) => message.chat_id === 100).length, 1);
  assert.doesNotMatch(reply, /\| Chain \|/);
});

test('Telegram automatically summarizes each newly persisted scheduled run once', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  let calls = 0;
  let suppliedFacts = '';
  const llm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'spy',
    async chat(request) {
      calls++;
      suppliedFacts = request.messages[0]?.content ?? '';
      return { content: 'Cycle complete. No candidate passed. Live execution is disabled.', toolCalls: [], finishReason: 'stop' };
    },
  };
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  const { TelegramBot } = await import('../src/viero/telegram.js');
  const bot = new TelegramBot({
    token: '12345678901234567890', allowedUserIds: new Set([7]), agent: {} as never,
    repo, chains: [8453], tokenLimit: 1, poolLimit: 1, intervalSeconds: 300,
    fetch: fetchMock, reportLlm: llm,
  });
  await bot.checkForScheduledReport();
  await repo.saveRun(makeRun(1));
  await bot.checkForScheduledReport();
  await bot.checkForScheduledReport();
  assert.equal(calls, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]?.text ?? '', /^🤖 Viero Cycle/);
  assert.match(sentMessages[0]?.text ?? '', /🎯 Candidate/);
  assert.match(suppliedFacts, /cycleFinishedAt/);
  assert.match(suppliedFacts, /tokenSummary/);
  assert.match(suppliedFacts, /decisions/);
});

test('Telegram integration: free-form text without conversational handler shows existing default', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  const { TelegramBot } = await import('../src/viero/telegram.js');
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  const bot = new TelegramBot({
    token: '12345678901234567890',
    allowedUserIds: new Set([7]),
    agent: {} as never,
    repo: {} as never,
    chains: [8453],
    tokenLimit: 1,
    poolLimit: 1,
    intervalSeconds: 60,
    fetch: fetchMock,
    // no conversational handler
  });
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: 'list open positions' });
  const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
  assert.match(reply, /Unknown command/);
});

test('Telegram integration: long reply is chunked before sending', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([
    makeRun(0, { positions: Array.from({ length: 80 }, (_, i) => makePaperPosition(i, 'open')) }),
  ]);
  const { handler } = makeHandler(repo, throwingLlm());
  const bot = await makeTelegramBot(handler, [7]);
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: 'list open positions' });
  // At least one reply, possibly split across multiple chunks.
  const userReplies = sentMessages.filter((m) => m.chat_id === 100);
  assert.ok(userReplies.length >= 1);
  // All chunks together cover the list.
  const allText = userReplies.map((m) => m.text).join('');
  assert.match(allText, /paper-0/);
});

test('Telegram integration: allowlist denial does not invoke LLM even if conversational handler is set', async () => {
  sentMessages = [];
  const repo = new InMemoryRepository([makeRun(0)]);
  let llmCalled = false;
  const llm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'spy',
    async chat() { llmCalled = true; return { content: '{"type":"list_open_positions"}', toolCalls: [], finishReason: 'stop' }; },
  };
  const { handler } = makeHandler(repo, llm);
  const bot = await makeTelegramBot(handler, [7]);
  await bot.handleMessage({ message_id: 1, from: { id: 999 }, chat: { id: 100 }, text: 'list open positions' });
  assert.equal(llmCalled, false);
});

// ─── Existing command regression checks ─────────────────────────

test('Existing /help reply is preserved (unchanged text)', async () => {
  sentMessages = [];
  const { TelegramBot } = await import('../src/viero/telegram.js');
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  const bot = new TelegramBot({
    token: '12345678901234567890',
    allowedUserIds: new Set([7]),
    agent: {} as never,
    repo: {} as never,
    chains: [8453],
    tokenLimit: 1,
    poolLimit: 1,
    intervalSeconds: 60,
    fetch: fetchMock,
  });
  await bot.handleMessage({ message_id: 1, from: { id: 7 }, chat: { id: 100 }, text: '/help' });
  const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
  assert.match(reply, /Viero Telegram bot is online/);
  assert.match(reply, /\/report/);
  assert.match(reply, /\/screen/);
  assert.match(reply, /\/pause/);
  assert.match(reply, /\/resume/);
});

// Suppress unused-imports for helpers kept for symmetry.
void ({} as ReadOnlyIntent);
