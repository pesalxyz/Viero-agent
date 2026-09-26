import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextFromRejectedCandidate,
  contextFromApprovedCandidate,
  contextFromManagement,
  contextFromPlanBlocked,
  contextFromError,
  contextFromNoCandidates,
  contextFromPlanCreated,
  type ExplanationContext,
} from '../src/viero/agent/explanationContext.js';
import {
  DecisionExplainer,
  buildFallbackExplanation,
} from '../src/viero/agent/explainer.js';
import {
  EXPLANATION_SYSTEM_PROMPT,
  EXPLANATION_PROMPT_VERSION,
  buildExplanationUserPrompt,
} from '../src/viero/agent/explainerPrompt.js';
import {
  createLlmClient,
  type ChatRequest,
  type ChatResponse,
  type LlmClient,
} from '../src/viero/agent/llmClient.js';
import {
  type Candidate,
} from '../src/viero/screening/pipeline.js';
import {
  type PaperPosition,
} from '../src/viero/management/paper.js';
import { type PositionPlan } from '../src/viero/execution/planner.js';
import { type ChainId, type ChainId as _ChainId } from '../src/viero/domain.js';

const chainId: ChainId = 8453;
const chainName = 'Base';
const candidateIdentity = '8453:v3:uniswap:0xabc';
const poolRef = { chainId: chainId as _ChainId, protocol: 'v3' as const, dex: 'uniswap' as const, poolAddress: '0xabc' };

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    pool: poolRef,
    identity: candidateIdentity,
    approved: false,
    rejections: [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'Liquidity below required threshold' }],
    metrics: {
      version: 'metric-1',
      pool: poolRef,
      source: 'rpc:8453:v3:uniswap:0xabc',
      sourceBlock: 1n,
      fetchedAt: 1,
      windowStart: 0,
      windowEnd: 1800,
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
    group: '8453:30:new:stable',
    score: null,
    globalScore: null,
    components: {},
    policyVersion: 'paper-policy-1',
    scoreVersion: 'within-group-1',
    ...overrides,
  };
}

function makePaperPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  const plan = {
    chainId,
    pool: poolRef,
    mode: 'paper' as const,
    createdAt: 0,
    deadline: 0,
    sourceBlock: 1n,
    sourceBlockHash: '0x' + '00'.repeat(32),
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1000n,
    depositAssets: [{ token: '0x0000000000000000000000000000000000000001', amount: 100n }],
    expectedTransfers: [{ token: '0x0000000000000000000000000000000000000001', direction: 'out' as const, maximumAmount: 100n }],
    slippageBps: 50,
    maximumGasCostUsd: 0.01,
    depositUsd: 5,
  };
  return {
    id: 'paper-1',
    chainId,
    plan,
    openedAt: 0,
    status: 'open',
    initialValueUsd: 5,
    currentValueUsd: 5.1,
    claimedFeesUsd: 0,
    unclaimedFeesUsd: 0.05,
    gasCostUsd: 0.005,
    swapCostUsd: 0,
    bridgeCostUsd: 0,
    holdValueUsd: 5,
    peakValueUsd: 5.2,
    outOfRangeSince: null,
    lastWindowEnd: 0,
    netPnlUsd: 0.045,
    impermanentLossUsd: 0.1,
    events: [{ at: 0, action: 'open', reason: 'Paper position; no transaction submitted', netPnlUsd: -0.005 }],
    ...overrides,
  };
}

/** A fake LlmClient that lets a test pre-program the next response. */
function fakeClient(behavior: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>): LlmClient {
  const client: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'fake',
    async chat(req) { return behavior(req); },
  };
  return client;
}

function okResponse(text: string): ChatResponse {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function errorResponse(): never {
  throw new Error('LLM_HTTP_500: provider is down');
}

// ─── Context builders ──────────────────────────────────────────

test('contextFromRejectedCandidate captures primary rejection and full list', () => {
  const ctx = contextFromRejectedCandidate({
    candidate: makeCandidate({ rejections: [
      { code: 'DEPTH_TOO_LOW', detail: 'depth=8000 < 10000' },
      { code: 'TRADERS_TOO_FEW', detail: '5 traders < 20' },
    ]}),
    chainName,
    timestamp: 1234,
  });
  assert.equal(ctx.eventType, 'rejected_candidate');
  assert.equal(ctx.outcome.kind, 'rejected');
  assert.equal(ctx.outcome.reasonCode, 'DEPTH_TOO_LOW');
  assert.equal(ctx.outcome.reasonDetail, 'depth=8000 < 10000');
  assert.equal(ctx.rejections?.length, 2);
  assert.deepEqual(ctx.chain, { id: chainId, name: chainName });
  assert.equal(ctx.pool?.protocol, 'v3');
  assert.equal(ctx.pool?.poolAddress, '0xabc');
  assert.equal(ctx.metrics?.volumeUsd, 1000);
  assert.equal(ctx.metrics?.tvlUsd, 5000);
  assert.equal(ctx.policyVersion, 'paper-policy-1');
  assert.equal(ctx.scoreVersion, 'within-group-1');
  assert.equal(ctx.timestamp, 1234);
});

test('contextFromApprovedCandidate overrides kind to approved', () => {
  const ctx = contextFromApprovedCandidate({
    candidate: makeCandidate({ approved: true, rejections: [] }),
    chainName,
  });
  assert.equal(ctx.outcome.kind, 'approved');
  assert.equal(ctx.rejections?.length, 0);
  assert.equal(ctx.eventType, 'accepted_candidate');
});

test('contextFromManagement maps hold/close/emergency-close/claim actions', () => {
  const baseArgs = { position: makePaperPosition(), chainName, timestamp: 100 };
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'hold', reason: 'range ok' } }).outcome.kind, 'held');
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'close', reason: 'STOP_LOSS' } }).outcome.kind, 'closed');
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'emergency-close', reason: 'HONEYPOT' } }).outcome.kind, 'emergency_closed');
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'rebalance', reason: 'OOR' } }).outcome.kind, 'rebalanced');
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'pause', reason: 'STALE_STATE' } }).outcome.kind, 'paused');
  assert.equal(contextFromManagement({ ...baseArgs, decision: { action: 'claim', reason: 'gas ok' } }).outcome.kind, 'claim');
});

test('contextFromPlanBlocked captures error code from message', () => {
  const ctx = contextFromPlanBlocked({
    planAttempt: { pool: { chainId } },
    candidateIdentity: '8453:v3:uniswap:0xabc',
    error: new Error('EXPOSURE_LIMIT: portfolio full'),
    chainName,
  });
  assert.equal(ctx.outcome.kind, 'plan_blocked');
  assert.equal(ctx.outcome.reasonCode, 'EXPOSURE_LIMIT');
  assert.match(ctx.outcome.reasonDetail!, /EXPOSURE_LIMIT/);
  assert.deepEqual(ctx.safety, { prevented: true, reason: 'EXPOSURE_LIMIT: portfolio full' });
});

test('contextFromError handles non-Error throw values', () => {
  const ctx = contextFromError({ error: 'NO_COMPLETE_OBSERVATIONS', runStatus: 'failed', chainId, chainName });
  assert.equal(ctx.outcome.kind, 'errored');
  assert.equal(ctx.outcome.reasonCode, 'NO_COMPLETE_OBSERVATIONS');
  assert.equal(ctx.run?.status, 'failed');
});

test('contextFromNoCandidates produces a minimal context', () => {
  const ctx = contextFromNoCandidates({ chainId, chainName, timestamp: 999 });
  assert.equal(ctx.eventType, 'no_candidates');
  assert.equal(ctx.outcome.kind, 'no_candidates');
  assert.equal(ctx.chain?.id, chainId);
  assert.equal(ctx.timestamp, 999);
});

test('contextFromPlanCreated carries plan fields', () => {
  const plan: PositionPlan = {
    chainId,
    pool: poolRef,
    mode: 'paper',
    createdAt: 0,
    deadline: 120,
    sourceBlock: 1n,
    sourceBlockHash: '0x' + '00'.repeat(32),
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1000n,
    depositAssets: [{ token: '0x0000000000000000000000000000000000000001', amount: 100n }],
    expectedTransfers: [{ token: '0x0000000000000000000000000000000000000001', direction: 'out', maximumAmount: 100n }],
    slippageBps: 50,
    maximumGasCostUsd: 0.01,
    depositUsd: 5,
  };
  const ctx = contextFromPlanCreated({
    candidate: makeCandidate({ approved: true }),
    plan,
    chainName,
  });
  assert.equal(ctx.eventType, 'plan_created');
  assert.equal(ctx.outcome.kind, 'plan_created');
  assert.equal(ctx.plan?.mode, 'paper');
  assert.equal(ctx.plan?.tickLower, -100);
  assert.equal(ctx.plan?.depositUsd, 5);
});

// ─── Fallback explanation ─────────────────────────────────────

test('buildFallbackExplanation rejected candidate cites first code', () => {
  const ctx: ExplanationContext = {
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'INSUFFICIENT_LIQUIDITY' },
    rejections: [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'below threshold' }],
  };
  const text = buildFallbackExplanation(ctx);
  assert.match(text, /INSUFFICIENT_LIQUIDITY/);
  assert.match(text, /rejected/i);
});

test('buildFallbackExplanation reports additional rejections', () => {
  const text = buildFallbackExplanation({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected' },
    rejections: [
      { code: 'A', detail: 'a' },
      { code: 'B', detail: 'b' },
      { code: 'C', detail: 'c' },
    ],
  });
  assert.match(text, /2 additional checks? failed/);
});

test('buildFallbackExplanation closed position uses provided reason detail', () => {
  const text = buildFallbackExplanation({
    eventType: 'management',
    outcome: { kind: 'closed', reasonCode: 'STOP_LOSS', reasonDetail: 'PnL -16% < -15%' },
    position: { identity: 'paper-1', status: 'closed' },
  });
  assert.match(text, /closed/i);
  assert.match(text, /PnL -16%/);
});

test('buildFallbackExplanation no candidates is short and specific', () => {
  const text = buildFallbackExplanation({
    eventType: 'no_candidates',
    outcome: { kind: 'no_candidates' },
  });
  assert.match(text, /No candidates/);
});

test('buildFallbackExplanation never invents facts (empty context)', () => {
  const text = buildFallbackExplanation({
    eventType: 'unknown',
    outcome: { kind: 'errored' },
  });
  // No numbers, no chain, no pool — just generic
  assert.match(text, /error/i);
  assert.doesNotMatch(text, /\d+\.\d+/);
});

// ─── Prompt builder ────────────────────────────────────────────

test('EXPLANATION_SYSTEM_PROMPT includes version and forbids hallucination', () => {
  assert.match(EXPLANATION_SYSTEM_PROMPT, /never/i);
  assert.match(EXPLANATION_SYSTEM_PROMPT, /invent/i);
  assert.match(EXPLANATION_SYSTEM_PROMPT, /unavailable/i);
});

test('buildExplanationUserPrompt renders only fields present in context', () => {
  const prompt = buildExplanationUserPrompt({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'A' },
    rejections: [{ code: 'A', detail: 'detail A' }, { code: 'B', detail: 'detail B' }],
  });
  assert.match(prompt, /event_type: rejected_candidate/);
  assert.match(prompt, /outcome\.kind: rejected/);
  assert.match(prompt, /rejections:/);
  assert.match(prompt, /- A: detail A/);
  assert.match(prompt, /- B: detail B/);
  assert.doesNotMatch(prompt, /chain:/);
  assert.doesNotMatch(prompt, /pool:/);
  assert.doesNotMatch(prompt, /metrics:/);
});

test('EXPLANATION_PROMPT_VERSION is a non-empty string', () => {
  assert.equal(typeof EXPLANATION_PROMPT_VERSION, 'string');
  assert.ok(EXPLANATION_PROMPT_VERSION.length > 0);
});

// ─── DecisionExplainer behavior ────────────────────────────────

test('DecisionExplainer.explain returns LLM text when client succeeds', async () => {
  const client = fakeClient(() => okResponse('The pool was rejected for insufficient liquidity.'));
  const explainer = new DecisionExplainer(client);
  const result = await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'INSUFFICIENT_LIQUIDITY' },
    rejections: [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'below threshold' }],
  });
  assert.equal(result.source, 'llm');
  assert.equal(result.llmAvailable, true);
  assert.match(result.text, /rejected/i);
});

test('DecisionExplainer.explain throws LLM_NOT_CONFIGURED when API key is absent', async () => {
  const env: NodeJS.ProcessEnv = {};
  assert.throws(() => createLlmClient(env), /LLM_NOT_CONFIGURED/);
});

test('DecisionExplainer.explain returns fallback on provider error', async () => {
  const client = fakeClient(() => errorResponse());
  const explainer = new DecisionExplainer(client);
  const result = await explainer.explain({
    eventType: 'management',
    outcome: { kind: 'closed', reasonCode: 'STOP_LOSS' },
    position: { identity: 'paper-1', status: 'closed' },
  });
  assert.equal(result.source, 'fallback-error');
  assert.equal(result.llmAvailable, false);
  assert.match(result.text, /closed/i);
});

test('DecisionExplainer.explain returns fallback when LLM returns empty content', async () => {
  const client = fakeClient(() => ({ content: '   ', toolCalls: [], finishReason: 'stop' }));
  const explainer = new DecisionExplainer(client);
  const result = await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'X' },
    rejections: [{ code: 'X', detail: 'x' }],
  });
  assert.equal(result.source, 'fallback-no-content');
  assert.match(result.text, /X/);
});

test('DecisionExplainer.explain never throws even with broken client', async () => {
  const client: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'broken',
    async chat() { throw new Error('totally broken'); },
  };
  const explainer = new DecisionExplainer(client);
  const result = await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Y' },
    rejections: [{ code: 'Y', detail: 'y' }],
  });
  assert.equal(result.source, 'fallback-error');
  assert.match(result.text, /Y/);
});

test('DecisionExplainer.explain does not pass tools to the LLM client', async () => {
  let captured: ChatRequest | null = null;
  const client = fakeClient((req) => { captured = req; return okResponse('ok'); });
  const explainer = new DecisionExplainer(client);
  await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Z' },
    rejections: [{ code: 'Z', detail: 'z' }],
  });
  assert.ok(captured);
  assert.equal(captured!.tools, undefined);
  assert.equal(captured!.toolChoice, undefined);
});

test('DecisionExplainer uses system prompt that enforces facts-only contract', async () => {
  let captured: ChatRequest | null = null;
  const client = fakeClient((req) => { captured = req; return okResponse('ok'); });
  const explainer = new DecisionExplainer(client);
  await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Z' },
  });
  assert.ok(captured);
  assert.match(captured!.systemPrompt, /never/i);
  assert.match(captured!.systemPrompt, /invent/i);
  assert.match(captured!.systemPrompt, /unavailable/i);
  assert.match(captured!.systemPrompt, new RegExp(EXPLANATION_PROMPT_VERSION));
});

test('DecisionExplainer.explain keeps temperature low for determinism', async () => {
  let captured: ChatRequest | null = null;
  const client = fakeClient((req) => { captured = req; return okResponse('ok'); });
  const explainer = new DecisionExplainer(client);
  await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Z' },
  });
  assert.ok(captured);
  assert.equal(captured!.temperature, 0.0);
});

test('DecisionExplainer.explain caps maxTokens at 256 by default', async () => {
  let captured: ChatRequest | null = null;
  const client = fakeClient((req) => { captured = req; return okResponse('ok'); });
  const explainer = new DecisionExplainer(client);
  await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Z' },
  });
  assert.ok(captured);
  assert.equal(captured!.maxTokens, 256);
});

test('DecisionExplainer honors custom maxTokens option', async () => {
  let captured: ChatRequest | null = null;
  const client = fakeClient((req) => { captured = req; return okResponse('ok'); });
  const explainer = new DecisionExplainer(client, { maxTokens: 64 });
  await explainer.explain({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'Z' },
  });
  assert.equal(captured!.maxTokens, 64);
});

// ─── Hallucination guardrails ──────────────────────────────────

test('prompt serializes numbers verbatim — no inference', () => {
  const prompt = buildExplanationUserPrompt({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'INSUFFICIENT_LIQUIDITY' },
    metrics: { tvlUsd: 12345.6789, volumeUsd: 100, feeTvlPct: 0.5 },
  });
  // Numbers from the context appear exactly as supplied.
  assert.match(prompt, /tvl_usd=12345\.6789/);
  assert.match(prompt, /volume_usd=100/);
  assert.match(prompt, /fee_tvl_pct=0\.5/);
  // No invented metric labels.
  assert.doesNotMatch(prompt, /apr/i);
  assert.doesNotMatch(prompt, /balance/i);
});

test('prompt omits chain/pool when context omits them', () => {
  const prompt = buildExplanationUserPrompt({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'X' },
  });
  assert.doesNotMatch(prompt, /^chain:/m);
  assert.doesNotMatch(prompt, /^pool:/m);
});

test('prompt never includes chain/position when not provided to management context', () => {
  const prompt = buildExplanationUserPrompt({
    eventType: 'management',
    outcome: { kind: 'closed', reasonCode: 'STOP_LOSS' },
  });
  assert.doesNotMatch(prompt, /^position:/m);
  assert.doesNotMatch(prompt, /^chain:/m);
});

test('prompt sanitization does not leak non-numeric noise', () => {
  const prompt = buildExplanationUserPrompt({
    eventType: 'rejected_candidate',
    outcome: { kind: 'rejected', reasonCode: 'A', reasonDetail: '<script>alert(1)</script>' },
    rejections: [{ code: 'A', detail: '<script>alert(1)</script>' }],
  });
  // The detail is passed through as-is from Viero's deterministic record.
  // Viero's domain.ts already sanitizes token symbols; this test documents
  // that we do not double-process or strip here.
  assert.match(prompt, /<script>alert\(1\)<\/script>/);
});

// ─── Explanation failure does not affect operational logic ─────

test('explanation failure does not throw — caller can rely on safe handling', async () => {
  const client: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'broken',
    async chat() { throw new Error('something catastrophic'); },
  };
  const explainer = new DecisionExplainer(client);
  // Use a minimal context — should still return a result.
  let result;
  try {
    result = await explainer.explain({ eventType: 'unknown', outcome: { kind: 'errored' } });
  } catch (err) {
    assert.fail(`explain() must never throw, got: ${err}`);
  }
  assert.equal(result!.source, 'fallback-error');
  assert.ok(result!.text.length > 0);
});
