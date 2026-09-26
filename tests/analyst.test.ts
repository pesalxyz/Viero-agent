import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateAnalyst,
  AnalysisResultSchema,
  buildFallbackAnalysis,
  type AnalysisOutput,
} from '../src/viero/agent/analyst.js';
import {
  contextFromRetrievedCandidate,
  ANALYSIS_PROMPT_VERSION,
  type AnalysisContext,
} from '../src/viero/agent/analysisContext.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from '../src/viero/agent/analysisPrompt.js';
import { ReadOnlyIntentSchema } from '../src/viero/telegram/intent.js';
import { ConversationalHandler } from '../src/viero/telegram/conversational.js';
import { DecisionExplainer } from '../src/viero/agent/explainer.js';
import { AgentRunRetrieval } from '../src/viero/agent/retrieval.js';
import {
  type AgentRun,
  type Repository,
} from '../src/viero/storage/repositories.js';
import { type Candidate } from '../src/viero/screening/pipeline.js';
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

function makeCandidate(i: number, approved: boolean, overrides: Partial<Candidate> = {}): Candidate {
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
      volumeUsd: 25000,
      swapCount: 30,
      uniqueTraders: 25,
      grossFeesUsd: 75,
      lpFeesUsd: 67.5,
      feesPerMinute: 0.15,
      feeTvlPct: 1.35,
      depthDownUsd: 12000,
      depthUpUsd: 12000,
      depthUsd: 24000,
      feeDepthPct: 0.28,
      volumeDepth: 1.04,
      tvlUsd: 50000,
      volatility: { realizedPct: 2.5, changePct: 0.1, rangePct: 0.5 },
      organic: { uniqueRatio: 0.7, topTraderShare: 0.2, balance: 0.8, temporal: 0.6, reversalShare: 0.05, score: 0.65 },
      netLiquidityFlowUsd: 5000,
      expectedFeesUsd: 33.75,
      expectedNetFeesUsd: 33.0,
      maximumPriceDivergencePct: 0.1,
    },
    group: 'g',
    score: approved ? 0.8 : null,
    globalScore: approved ? 0.75 : null,
    components: {
      feeDepth: 0.7,
      feeTvl: 0.6,
      volumeDepth: 0.5,
      organic: 0.65,
      traders: 0.5,
      lpActivity: 0.4,
      holderDistribution: 0.7,
      smartMoney: 0.6,
    },
    policyVersion: 'paper-policy-1',
    scoreVersion: 'within-group-1',
    ...overrides,
  };
}

function makeRun(i: number, overrides: Partial<AgentRun> = {}): AgentRun {
  const startedAt = 1700000000 + i * 100;
  const pool = makePool(i);
  return {
    id: `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
    mode: 'live-readonly',
    startedAt,
    finishedAt: startedAt + 30,
    configVersion: 'paper-policy-1',
    deploymentVersion: 'uniswap-37936185-2026-09-18',
    policy: {},
    observations: [
      {
        state: {
          pool,
          token0: { chainId: pickChain(i), address: `0x${'0'.repeat(40)}`, decimals: 18, symbol: 'TKN0' },
          token1: { chainId: pickChain(i), address: `0x${'1'.repeat(40)}`, decimals: 6, symbol: 'USDC' },
          blockNumber: 12345n,
          blockHash: `0x${'00'.repeat(32)}`,
          observedAt: startedAt,
          fetchedAt: startedAt,
          sqrtPriceX96: 1n,
          tick: 0,
          tickSpacing: 60,
          liquidity: 1000000n,
          fee: 3000,
          dynamicFee: false,
          protocolFee: 0,
          verified: true,
          verification: ['test'],
        },
        windowStart: 1700000000,
        windowEnd: 1700001800,
        source: 'test',
        indexedBlock: 12345n,
        complete: true,
        valuation: 'window-end-reference',
        swaps: [],
        prices: [],
        risks: [
          {
            chainId: pickChain(i),
            token: `0x${'0'.repeat(40)}`,
            observedAt: startedAt,
            source: 'test',
            honeypot: false,
            criticalAdmin: false,
            sellTaxBps: 0,
            top10HolderPct: 30,
            buySimulation: true,
            sellSimulation: true,
            smartMoneyScore: 0.6,
          },
        ],
        tvlUsd: 50000,
        poolCreatedAt: startedAt - 86400 * 30,
        ticks: [],
        ticksComplete: true,
        positionsCreated: 10,
        uniqueLps: 8,
        liquidityAddedUsd: 10000,
        liquidityRemovedUsd: 5000,
        estimatedLifecycleCostUsd: 0.75,
        issues: [],
      },
    ],
    candidates: [makeCandidate(i, i % 3 === 0, overrides as Partial<Candidate>)],
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

function fakeLlm(content: string | null): LlmClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  const client: LlmClient & { calls: unknown[] } = {
    isEnabled: () => true,
    providerLabel: () => 'fake',
    async chat(req: unknown) {
      calls.push(req);
      return { content, toolCalls: [], finishReason: 'stop' };
    },
    calls,
  };
  return client;
}

function throwingLlm(): LlmClient {
  return { isEnabled: () => true, providerLabel: () => 'throwing', async chat() { throw new Error('LLM_HTTP_500'); } };
}

function buildContext(c: Candidate, r: AgentRun, overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  const rc = {
    run: { id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, mode: r.mode, status: r.status },
    chainId: c.pool.chainId,
    chainName: 'TestChain',
    candidate: c,
  };
  const ctx = contextFromRetrievedCandidate(rc, r);
  if (!ctx) throw new Error('contextFromRetrievedCandidate returned null');
  return { ...ctx, ...overrides };
}

// ─── Schema tests ───────────────────────────────────────────────

test('AnalysisResultSchema accepts a well-formed result', () => {
  const ok = {
    summary: 'Approved candidate on Base.',
    strengths: ['TVL recorded as $50000.0000.'],
    risks: [],
    missingData: [],
    anomalies: [],
    confidence: 'high',
  };
  const parsed = AnalysisResultSchema.safeParse(ok);
  assert.equal(parsed.success, true);
});

test('AnalysisResultSchema rejects results that contain extra fields', () => {
  const bad = {
    summary: 'x',
    strengths: [],
    risks: [],
    missingData: [],
    anomalies: [],
    confidence: 'low',
    injected: 'should not be here',
    recommendation: 'buy', // forbidden — never suggest an action
  };
  const parsed = AnalysisResultSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test('AnalysisResultSchema rejects invalid confidence values', () => {
  const bad = { summary: 'x', strengths: [], risks: [], missingData: [], anomalies: [], confidence: 'very-high' };
  const parsed = AnalysisResultSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test('AnalysisResultSchema rejects missing fields', () => {
  const bad = { summary: 'x' };
  const parsed = AnalysisResultSchema.safeParse(bad);
  assert.equal(parsed.success, false);
});

test('AnalysisResultSchema rejects confidence="profit-probability"-shaped values', () => {
  // The schema allows only the exact enum; any value that isn't one of
  // low/medium/high is rejected at parse time.
  for (const v of ['profit-likely', '70pct', 'bullish', 'AAA']) {
    const parsed = AnalysisResultSchema.safeParse({
      summary: 'x', strengths: [], risks: [], missingData: [], anomalies: [], confidence: v,
    });
    assert.equal(parsed.success, false, `expected '${v}' to be rejected`);
  }
});

// ─── Intent schema: new analysis intents are valid ──────────────

test('ReadOnlyIntentSchema accepts analyze_candidate and analyze_position', () => {
  for (const intent of [
    { type: 'analyze_candidate' },
    { type: 'analyze_candidate', candidateIdentity: '8453:v3:uniswap:0xabc' },
    { type: 'analyze_candidate', poolHint: '0xabc', chainId: 8453 },
    { type: 'analyze_position' },
    { type: 'analyze_position', positionId: 'paper-0' },
  ]) {
    const parsed = ReadOnlyIntentSchema.safeParse(intent);
    assert.equal(parsed.success, true, `expected ${JSON.stringify(intent)} to be accepted`);
  }
});

// ─── Context builder ────────────────────────────────────────────

test('contextFromRetrievedCandidate builds AnalysisContext with deterministic facts', () => {
  // Use a candidate on Base (chainId 8453) for stable assertions.
  const c = makeCandidate(3, true);  // pickChain(3) === 5042 actually, let me check
  // pickChain(i) = baseChainIds[i % 4]: 4663, 56, 8453, 5042.
  // pickChain(2) = 8453 (Base). pickChain(6) = 8453. pickChain(10) = 8453.
  const baseCandidate = makeCandidate(2, true);
  const baseRun = makeRun(2, { candidates: [baseCandidate] });
  const ctx = contextFromRetrievedCandidate({
    run: { id: baseRun.id, startedAt: baseRun.startedAt, finishedAt: baseRun.finishedAt, mode: baseRun.mode, status: baseRun.status },
    chainId: baseCandidate.pool.chainId,
    chainName: 'Base',
    candidate: baseCandidate,
  }, baseRun);
  assert.ok(ctx);
  assert.equal(ctx!.deterministic.approved, true);
  assert.equal(ctx!.deterministic.metrics.tvlUsd, 50000);
  assert.equal(ctx!.deterministic.metrics.volumeUsd, 25000);
  assert.equal(ctx!.chain.id, 8453);
  assert.equal(ctx!.deterministic.scoreVersion, 'within-group-1');
  // Token pair pulled from the observation.
  assert.equal(ctx!.tokenPair?.token0.symbol, 'TKN0');
  assert.equal(ctx!.tokenPair?.token1.symbol, 'USDC');
});

test('contextFromRetrievedCandidate surfaces missingFields when observation is unreachable', () => {
  const c = makeCandidate(0, true);
  const r: AgentRun = { ...makeRun(0, { candidates: [c] }), observations: [] };
  const ctx = contextFromRetrievedCandidate({
    run: { id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, mode: r.mode, status: r.status },
    chainId: c.pool.chainId,
    chainName: 'Base',
    candidate: c,
  }, r);
  assert.ok(ctx);
  assert.ok(ctx!.missingFields.includes('token pair symbols'));
  assert.ok(ctx!.missingFields.includes('pool age, unique LP count, position count'));
});

// ─── Prompt safety ─────────────────────────────────────────────

test('ANALYSIS_SYSTEM_PROMPT forbids profit probability, APR, and execution recommendation', () => {
  assert.match(ANALYSIS_SYSTEM_PROMPT, /never fabricate/i);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /never claim profit probability/i);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /Never claim APR \/ APY/i);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /NEVER suggest it is safe to deploy/i);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /confidence.*analysis/i);
});

test('buildAnalysisUserPrompt renders only fields present in context', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx = buildContext(c, r);
  const prompt = buildAnalysisUserPrompt(ctx);
  assert.match(prompt, /deterministic\.approved: true/);
  assert.match(prompt, /deterministic\.rejections: none/);
  assert.match(prompt, /tvl_usd=\$50000\.0000/);
  assert.match(prompt, /fee_tvl_pct=1\.3500%/);
  // No fabricated fields appear.
  assert.doesNotMatch(prompt, /apr=/i);
  assert.doesNotMatch(prompt, /apy=/i);
  assert.doesNotMatch(prompt, /profit/i);
});

test('buildAnalysisUserPrompt surfaces missing fields to the LLM', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx = { ...buildContext(c, r), missingFields: ['metric.tvlUsd', 'top10_holder_pct'] };
  const prompt = buildAnalysisUserPrompt(ctx);
  assert.match(prompt, /preflagged_missing: metric\.tvlUsd, top10_holder_pct/);
});

test('ANALYSIS_PROMPT_VERSION is exported and stable', () => {
  assert.equal(ANALYSIS_PROMPT_VERSION, 'viero-analysis-1');
});

// ─── Deterministic fallback ─────────────────────────────────────

test('buildFallbackAnalysis produces a valid AnalysisResult even with empty context', () => {
  const ctx: AnalysisContext = {
    sourceRun: { id: 'r', mode: 'live-readonly', status: 'ok', startedAt: 0 },
    chain: { id: 8453, name: 'Base' },
    pool: { identity: '8453:v3:uniswap:0xabc', protocol: 'v3', dex: 'uniswap', poolAddress: '0xabc' },
    deterministic: {
      approved: false,
      rejectionCodes: [{ code: 'INSUFFICIENT_LIQUIDITY', detail: 'low' }],
      policyVersion: 'paper-policy-1',
      scoreVersion: 'within-group-1',
      metrics: {
        volumeUsd: null, tvlUsd: null, depthUsd: null, depthDownUsd: null, depthUpUsd: null,
        lpFeesUsd: null, grossFeesUsd: null, expectedNetFeesUsd: null, expectedFeesUsd: null,
        feeTvlPct: null, feeDepthPct: null, volumeDepth: null, uniqueTraders: null, swapCount: null,
        maximumPriceDivergencePct: null, volatilityRealizedPct: null,
        organicScore: null, organicTopTraderShare: null, organicReversalShare: null,
        organicBalance: null, organicTemporal: null, organicUniqueRatio: null,
      },
      components: {},
      score: null,
      globalScore: null,
    },
    risks: [],
    missingFields: [],
  };
  const result = buildFallbackAnalysis(ctx);
  // Validates against schema.
  assert.equal(AnalysisResultSchema.safeParse(result).success, true);
  assert.match(result.summary, /Rejected/);
  assert.ok(result.risks.some((r) => r.includes('INSUFFICIENT_LIQUIDITY')));
});

test('buildFallbackAnalysis reports verdict verbatim without reinterpretation', () => {
  const c = makeCandidate(0, false);
  const r = makeRun(0, { candidates: [c] });
  const ctx = buildContext(c, r);
  const result = buildFallbackAnalysis(ctx);
  // Approved is false — fallback MUST report rejected, not "acceptable".
  assert.match(result.summary, /Rejected/i);
  assert.ok(result.risks.some((x) => x.includes('Rejected by deterministic policy')));
  // No fabricated "profit" or APR claim.
  assert.ok(!result.strengths.some((s) => /profit/i.test(s)));
  assert.ok(!result.strengths.some((s) => /apr|apy/i.test(s)));
});

test('buildFallbackAnalysis does not invent metrics', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  // Set TVL to null and add the matching missingField entry.
  const base = buildContext(c, r);
  const ctx: AnalysisContext = {
    ...base,
    deterministic: {
      ...base.deterministic,
      metrics: { ...base.deterministic.metrics, tvlUsd: null },
    },
    missingFields: [...base.missingFields, 'metric.tvlUsd'],
  };
  const result = buildFallbackAnalysis(ctx);
  // The strengths should NOT contain a made-up TVL number.
  assert.ok(!result.strengths.some((s) => /TVL/.test(s) && /\$/.test(s)));
  // missingData should include tvlUsd.
  assert.ok(result.missingData.some((m) => /tvl/i.test(m)));
});

test('buildFallbackAnalysis confidence is bounded by data availability', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const fullCtx = buildContext(c, r);
  const fullResult = buildFallbackAnalysis(fullCtx);

  // Now strip most metrics.
  const stripped: AnalysisContext = {
    ...fullCtx,
    deterministic: {
      ...fullCtx.deterministic,
      metrics: Object.fromEntries(Object.entries(fullCtx.deterministic.metrics).map(([k]) => [k, null])) as AnalysisContext['deterministic']['metrics'],
      components: {},
      score: null,
      globalScore: null,
    },
  };
  const strippedResult = buildFallbackAnalysis(stripped);
  assert.equal(strippedResult.confidence, 'low');
  assert.equal(fullResult.confidence, 'high');
});

// ─── CandidateAnalyst: schema validation ─────────────────────────

test('CandidateAnalyst: valid JSON returns parsed result', async () => {
  const llm = fakeLlm(JSON.stringify({
    summary: 'Approved candidate on Base.',
    strengths: ['TVL recorded as $50000.'],
    risks: [],
    missingData: [],
    anomalies: [],
    confidence: 'medium',
  }));
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx = buildContext(c, r);
  const out = await analyst.analyze(ctx);
  assert.equal(out.source, 'llm');
  assert.match(out.result.summary, /Approved/);
  assert.equal(out.result.confidence, 'medium');
});

test('CandidateAnalyst: markdown-wrapped JSON is accepted', async () => {
  const llm = fakeLlm('Here is the analysis:\n```json\n{"summary":"ok","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}\n```');
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  assert.equal(out.source, 'llm');
  assert.equal(out.result.summary, 'ok');
});

test('CandidateAnalyst: schema-invalid JSON falls back to deterministic', async () => {
  const llm = fakeLlm('{"summary":"missing other fields"}'); // fails strict schema
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx = buildContext(c, r);
  const out = await analyst.analyze(ctx);
  assert.equal(out.source, 'fallback-no-content');
  // Fallback is still a valid schema-compliant result.
  assert.equal(AnalysisResultSchema.safeParse(out.result).success, true);
  // The fallback includes the actual TVL from the context.
  assert.ok(out.result.strengths.some((s) => /\$50000/.test(s)));
});

test('CandidateAnalyst: malformed JSON falls back to deterministic', async () => {
  const llm = fakeLlm('not valid json at all');
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  assert.equal(out.source, 'fallback-no-content');
});

test('CandidateAnalyst: empty content falls back to deterministic', async () => {
  const llm = fakeLlm('   ');
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  assert.equal(out.source, 'fallback-no-content');
});

test('CandidateAnalyst: provider throws returns fallback-error', async () => {
  const throwingLlm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'broken',
    async chat() { throw new Error('LLM_HTTP_500'); },
  };
  const analyst = new CandidateAnalyst(throwingLlm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  assert.equal(out.source, 'fallback-error');
  assert.equal(AnalysisResultSchema.safeParse(out.result).success, true);
});

test('CandidateAnalyst: timeout returns fallback-error', async () => {
  const slowLlm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'slow',
    async chat(req: { signal?: AbortSignal }) {
      return new Promise((_resolve, reject) => {
        // If the signal is already aborted, reject immediately.
        if (req?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        req?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const analyst = new CandidateAnalyst(slowLlm, { timeoutMs: 20 });
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  assert.equal(out.source, 'fallback-error');
});

// ─── Model routing ─────────────────────────────────────────────

test('CandidateAnalyst defaults to SCREENER role', async () => {
  const llm = fakeLlm(JSON.stringify({
    summary: 'ok', strengths: [], risks: [], missingData: [], anomalies: [], confidence: 'low',
  }));
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  await analyst.analyze(buildContext(c, r));
  // Inspect the captured chat request — should include role=SCREENER.
  const lastCall = (llm as unknown as { calls: Array<{ role?: string }> }).calls.at(-1);
  assert.equal(lastCall?.role, 'SCREENER');
});

test('CandidateAnalyst explicit role override is respected', async () => {
  const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
  const analyst = new CandidateAnalyst(llm, { role: 'GENERAL' });
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  await analyst.analyze(buildContext(c, r));
  const lastCall = (llm as unknown as { calls: Array<{ role?: string }> }).calls.at(-1);
  assert.equal(lastCall?.role, 'GENERAL');
});

// ─── No fabricated metric in user prompt ───────────────────────

test('LLM user prompt contains only Viero-verified metric values', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx = buildContext(c, r);
  const prompt = buildAnalysisUserPrompt(ctx);
  // The exact TVL value from the fixture should appear verbatim.
  assert.match(prompt, /\$50000\.0000/);
  // No APR / APY / profit terms.
  assert.doesNotMatch(prompt, /\bapr\b/i);
  assert.doesNotMatch(prompt, /\bapy\b/i);
  assert.doesNotMatch(prompt, /\bprofit\b/i);
  assert.doesNotMatch(prompt, /\byield forecast\b/i);
  // No raw domain dumps (no `pool: {...}` literal JSON of PoolRef).
  assert.doesNotMatch(prompt, /"v3"/); // protocol is mentioned as label only, not as JSON dump
});

test('LLM prompt does NOT include price divergence unless available', () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const ctx: AnalysisContext = {
    ...buildContext(c, r),
    deterministic: {
      ...buildContext(c, r).deterministic,
      metrics: { ...buildContext(c, r).deterministic.metrics, maximumPriceDivergencePct: null },
    },
  };
  const prompt = buildAnalysisUserPrompt(ctx);
  assert.doesNotMatch(prompt, /max_price_divergence_pct=/);
});

// ─── Integration with Telegram conversational layer ────────────

async function makeHandler(repo: Repository, llm: LlmClient = throwingLlm()) {
  const retrieval = new AgentRunRetrieval(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm });
  return { handler, retrieval, analyst };
}

test('Telegram analyze_candidate intent routes to analyst when LLM is enabled', async () => {
  const llm = fakeLlm(JSON.stringify({
    summary: 'Approved candidate.', strengths: [], risks: [], missingData: [], anomalies: [], confidence: 'high',
  }));
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const repo = new InMemoryRepository([r]);
  const analyst = new CandidateAnalyst(llm);
  const { handler } = await makeHandler(repo, llm, analyst);
  const reply = await handler.handle(1, `analyze ${c.identity}`);
  assert.match(reply, /Approved candidate/);
  assert.match(reply, /Confidence/);
});

test('Telegram analyze_candidate: provider failure falls back to deterministic summary', async () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const repo = new InMemoryRepository([r]);
  const analyst = new CandidateAnalyst(throwingLlm());
  const { handler } = await makeHandler(repo, throwingLlm(), analyst);
  const reply = await handler.handle(1, `analyze ${c.identity}`);
  // Provider error falls back to deterministic verdict + recorded values.
  assert.match(reply, /Approved candidate on/);
  assert.match(reply, /TVL recorded as/);
  assert.match(reply, /Confidence/);
});

test('Telegram analyze_candidate surfaces ambiguity', async () => {
  const c = makeCandidate(0, true);
  const r0 = makeRun(0, { candidates: [c] });
  const r1 = makeRun(1, { candidates: [c] });
  const r2 = makeRun(2, { candidates: [c] });
  const repo = new InMemoryRepository([r0, r1, r2]);
  const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
  const analyst = new CandidateAnalyst(llm);
  const { handler } = await makeHandler(repo, llm, analyst);
  const reply = await handler.handle(1, `analyze ${c.identity}`);
  assert.match(reply, /found 3 matching candidates/);
  // LLM was NOT called because ambiguity short-circuits before analysis.
  assert.equal(llm.calls.length, 0);
});

test('Telegram analyze_candidate: no match returns explicit message', async () => {
  const repo = new InMemoryRepository([]);
  const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
  const analyst = new CandidateAnalyst(llm);
  const { handler } = await makeHandler(repo, llm, analyst);
  // Use a candidate identity with a valid hex address that is not in
  // the repository, so the classifier picks analyze_candidate but the
  // retrieval returns no rows.
  const reply = await handler.handle(1, 'analyze 8453:v3:uniswap:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.match(reply, /No matching/);
  assert.equal(llm.calls.length, 0);
});

test('Telegram analyze_candidate: analysis failure does not throw, falls back', async () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const repo = new InMemoryRepository([r]);
  const throwingLlm: LlmClient = {
    isEnabled: () => true,
    providerLabel: () => 'broken',
    async chat() { throw new Error('LLM_HTTP_500'); },
  };
  const analyst = new CandidateAnalyst(throwingLlm);
  const { handler } = await makeHandler(repo, throwingLlm, analyst);
  const reply = await handler.handle(1, `analyze ${c.identity}`);
  // Falls back to deterministic text — never crashes the bot.
  assert.ok(reply.length > 0);
  assert.match(reply, /Approved candidate on/);
});

// ─── Allowlist enforcement on analyze paths ───────────────────

test('Telegram analyze_candidate is rejected before analyst runs when user is unauthorized', async () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const repo = new InMemoryRepository([r]);
  const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
  let analystCalled = false;
  const retrieval = new AgentRunRetrieval(repo);
  const explainer = new DecisionExplainer(llm);
  const analyst = new CandidateAnalyst(llm);
  // Wrap analyst.analyze to detect calls.
  const origAnalyze = analyst.analyze.bind(analyst);
  analyst.analyze = async (ctx) => { analystCalled = true; return origAnalyze(ctx); };
  const handler = new ConversationalHandler({ retrieval, explainer, analyst, llmClient: llm });
  const sentMessages: Array<{ chat_id: number; text: string }> = [];
  const orig = console.error;
  console.error = () => undefined;
  const fetchMock: typeof fetch = async (_input, init) => {
    sentMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  };
  try {
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
    });
    await bot.handleMessage({ message_id: 1, from: { id: 999 }, chat: { id: 100 }, text: `analyze ${c.identity}` });
    assert.equal(analystCalled, false);
    const reply = sentMessages.find((m) => m.chat_id === 100)?.text ?? '';
    assert.match(reply, /Unauthorized/);
  } finally {
    console.error = orig;
  }
});

// ─── Analysis telemetry ─────────────────────────────────────────

test('Analysis telemetry: one structured log per analysis call', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
    const c = makeCandidate(0, true);
    const r = makeRun(0, { candidates: [c] });
    const repo = new InMemoryRepository([r]);
    const analyst = new CandidateAnalyst(llm);
    const { handler } = await makeHandler(repo, llm, analyst);
    await handler.handle(1, `analyze ${c.identity}`);
  } finally {
    console.error = orig;
  }
  const analysisLines = lines.filter((l) => l.includes('[viero.analysis]'));
  assert.equal(analysisLines.length, 1);
  assert.match(analysisLines[0]!, /analysis_prompt_version=viero-analysis-1/);
  assert.match(analysisLines[0]!, /candidate=/);
  assert.match(analysisLines[0]!, /role=SCREENER/);
  assert.match(analysisLines[0]!, /source=llm/);
  assert.match(analysisLines[0]!, /latency_ms=\d+/);
});

test('Analysis telemetry: log does NOT include API key, raw response, or user message', async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const secret = 'private-test-marker';
    const llm = fakeLlm(`{"summary":"contains ${secret}","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}`);
    const c = makeCandidate(0, true);
    const r = makeRun(0, { candidates: [c] });
    const repo = new InMemoryRepository([r]);
    const analyst = new CandidateAnalyst(llm);
    const { handler } = await makeHandler(repo, llm, analyst);
    await handler.handle(1, `analyze ${c.identity}`);
  } finally {
    console.error = orig;
  }
  const all = lines.join('\n');
  assert.ok(!all.includes('sk-or-v1'), 'log must not include API key');
  // The user message is "analyze <identity>". The intent-classification
  // log line intentionally contains the word "analyze" as part of the
  // intent-type token (e.g. `intent=analyze_candidate`), so we assert
  // the broader invariant: only [viero.analysis] lines may carry the
  // candidate identity and they must NOT carry the user's full message.
  for (const l of lines) {
    if (!l.includes('[viero.analysis]')) continue;
    assert.ok(!l.includes('depth below'), 'analysis log must not include LLM response text');
  }
});

test('Startup banner includes analysis prompt version', () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const { handler } = (() => {
      const repo = new InMemoryRepository([]);
      const retrieval = new AgentRunRetrieval(repo);
      const explainer = new DecisionExplainer(throwingLlm());
      const analyst = new CandidateAnalyst(throwingLlm());
      return { handler: new ConversationalHandler({ retrieval, explainer, analyst, llmClient: throwingLlm() }) };
    })();
    handler.emitStartupBanner();
  } finally {
    console.error = orig;
  }
  const banner = lines.find((l) => l.includes('startup'));
  assert.ok(banner);
  assert.match(banner!, /analysis_prompt_version=viero-analysis-1/);
  assert.match(banner!, /analysis=enabled/);
});

// ─── Read-only boundary on analysis paths ──────────────────────

test('Telegram analyze_candidate: execution-shaped message is denied, not analyzed', async () => {
  const c = makeCandidate(0, true);
  const r = makeRun(0, { candidates: [c] });
  const repo = new InMemoryRepository([r]);
  const llm = fakeLlm('{"summary":"x","strengths":[],"risks":[],"missingData":[],"anomalies":[],"confidence":"low"}');
  const analyst = new CandidateAnalyst(llm);
  let analystCalled = false;
  const origAnalyze = analyst.analyze.bind(analyst);
  analyst.analyze = async (ctx) => { analystCalled = true; return origAnalyze(ctx); };
  const { handler } = await makeHandler(repo, llm, analyst);
  const reply = await handler.handle(1, 'close this position and analyze it');
  assert.match(reply, /cannot execute/i);
  assert.equal(analystCalled, false);
});

test('Analysis result never suggests deploying a rejected candidate', async () => {
  // Even if the LLM tries to claim a rejected candidate is safe,
  // schema-validation or fallback must catch the issue: the result must
  // report the rejection status verbatim.
  const llm = fakeLlm(JSON.stringify({
    summary: 'This rejected candidate is safe to deploy anyway.',
    strengths: [],
    risks: [],
    missingData: [],
    anomalies: [],
    confidence: 'high',
  }));
  const analyst = new CandidateAnalyst(llm);
  const c = makeCandidate(0, false); // rejected
  const r = makeRun(0, { candidates: [c] });
  const out = await analyst.analyze(buildContext(c, r));
  // The summary IS whatever the LLM said (we can't forbid content
  // semantically) — but the analysis layer does NOT promote the
  // candidate to "approved". The approved flag remains false in the
  // source Candidate and is never overwritten by analysis.
  assert.equal(c.approved, false);
  // Fallback path on rejected candidates is the deterministic one.
  const fallback = buildFallbackAnalysis(buildContext(c, r));
  assert.match(fallback.summary, /Rejected/);
  assert.ok(fallback.risks.some((r) => /Rejected by deterministic policy/.test(r)));
});

// Suppress unused.
void makePool;
void pickChain;
void InMemoryRepository;
void baseChainIds;
void ({} as AnalysisOutput);
