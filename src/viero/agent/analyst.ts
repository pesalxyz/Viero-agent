/**
 * Candidate analyst service.
 *
 * Sits on top of the LlmClient abstraction. Takes a strongly-typed
 * AnalysisContext (built from Viero records — never from raw objects)
 * and produces a validated AnalysisResult.
 *
 * Guarantees:
 *   - analyze() NEVER throws. Any failure mode returns a deterministic
 *     fallback summary built from the context.
 *   - The LLM has no execution authority. It returns advisory prose
 *     only; the operational bot never depends on analysis output.
 *   - Schema-validated LLM output. Invalid JSON, schema-invalid output,
 *     timeout, or empty content all fall back to deterministic text.
 *   - Read-only. Does not mutate any Viero state.
 *
 * Model routing: uses the SCREENER role by default (candidate / pool
 * analysis is a screening-adjacent task). Per-call override is
 * supported for tests and future routing layers.
 */
import { z } from 'zod';
import {
  type AnalysisContext,
  ANALYSIS_PROMPT_VERSION,
} from './analysisContext.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from './analysisPrompt.js';
import { type LlmClient, type Role } from './llmClient.js';

export const AnalysisResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  strengths: z.array(z.string().min(1).max(500)).max(20),
  risks: z.array(z.string().min(1).max(500)).max(20),
  missingData: z.array(z.string().min(1).max(500)).max(20),
  anomalies: z.array(z.string().min(1).max(500)).max(20),
  confidence: z.enum(['low', 'medium', 'high']),
}).strict();

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export type AnalysisSource = 'llm' | 'fallback-error' | 'fallback-no-content' | 'fallback-schema-invalid';

export type AnalysisOutput = {
  result: AnalysisResult;
  source: AnalysisSource;
};

export type CandidateAnalystOptions = {
  role?: Role;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export class CandidateAnalyst {
  private readonly role: Role;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly client: LlmClient,
    options: CandidateAnalystOptions = {},
  ) {
    this.role = options.role ?? 'SCREENER';
    this.maxTokens = options.maxTokens ?? 1024;
    this.temperature = options.temperature ?? 0.0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Produce a structured analysis for the given context.
   * Always resolves with a valid AnalysisOutput. Never rejects.
   */
  async analyze(context: AnalysisContext): Promise<AnalysisOutput> {
    try {
      const response = await this.callWithTimeout(context);
      const parsed = this.parseResponse(response.content);
      if (parsed) return { result: parsed, source: 'llm' };
      return { result: buildFallbackAnalysis(context), source: 'fallback-no-content' };
    } catch {
      return { result: buildFallbackAnalysis(context), source: 'fallback-error' };
    }
  }

  private async callWithTimeout(context: AnalysisContext) {
    const userPrompt = buildAnalysisUserPrompt(context);
    const systemPrompt = `${ANALYSIS_SYSTEM_PROMPT}\n\nPROMPT_VERSION: ${ANALYSIS_PROMPT_VERSION}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.client.chat({
        role: this.role,
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResponse(content: string | null | undefined): AnalysisResult | null {
    if (!content) return null;
    const trimmed = content.trim();
    if (!trimmed) return null;

    // Extract the first JSON object from the response. The LLM is
    // instructed to output raw JSON, but may wrap it in markdown fences
    // or include prose around it; we accept either shape but never
    // try to "repair" malformed JSON — anything unrecoverable falls
    // through to the deterministic fallback.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    const validated = AnalysisResultSchema.safeParse(parsed);
    if (!validated.success) return null;
    return validated.data;
  }
}

/**
 * Deterministic fallback analysis. Built only from fields present in
 * the context. Never invents metrics, behavior, or numeric values.
 *
 * Used when LLM is disabled, errors, times out, or returns malformed
 * / schema-invalid output. Always produces a valid AnalysisResult so
 * downstream consumers (Telegram formatter, logs) can rely on the
 * schema.
 */
export function buildFallbackAnalysis(ctx: AnalysisContext): AnalysisResult {
  const summary = buildFallbackSummary(ctx);
  const strengths: string[] = [];
  const risks: string[] = [];
  const missingData: string[] = [...ctx.missingFields];
  const anomalies: string[] = [];

  const m = ctx.deterministic.metrics;

  // Surface deterministic verdict
  if (ctx.deterministic.approved) {
    strengths.push('Approved by deterministic policy.');
  } else {
    if (ctx.deterministic.rejectionCodes.length > 0) {
      const first = ctx.deterministic.rejectionCodes[0]!;
      risks.push(`Rejected by deterministic policy (${first.code}).`);
    } else {
      risks.push('Rejected by deterministic policy (no rejection code recorded).');
    }
  }

  // Numeric facts → list verbatim as strengths/risks, NOT reinterpretations
  if (m.tvlUsd !== null) strengths.push(`TVL recorded as ${formatUsd(m.tvlUsd)}.`);
  if (m.volumeUsd !== null) strengths.push(`Window volume recorded as ${formatUsd(m.volumeUsd)}.`);
  if (m.depthUsd !== null) strengths.push(`1% exit depth recorded as ${formatUsd(m.depthUsd)}.`);
  if (m.expectedNetFeesUsd !== null) strengths.push(`Expected net fees (gas-adjusted) recorded as ${formatUsd(m.expectedNetFeesUsd)}.`);
  if (m.lpFeesUsd !== null) strengths.push(`LP-net fees recorded as ${formatUsd(m.lpFeesUsd)}.`);
  if (m.feeTvlPct !== null) strengths.push(`Fee / TVL ratio recorded as ${m.feeTvlPct.toFixed(4)}%.`);
  if (m.uniqueTraders !== null) strengths.push(`Distinct transaction senders recorded as ${m.uniqueTraders}.`);
  if (m.volatilityRealizedPct !== null && Number.isFinite(m.volatilityRealizedPct)) {
    strengths.push(`Realized volatility recorded as ${m.volatilityRealizedPct.toFixed(4)}%.`);
  }

  // Score components — descriptive only
  if (ctx.deterministic.score !== null) strengths.push(`Within-group score recorded as ${ctx.deterministic.score.toFixed(4)}.`);
  if (ctx.deterministic.globalScore !== null) strengths.push(`Global score recorded as ${ctx.deterministic.globalScore.toFixed(4)}.`);

  // Risk evidence
  for (const r of ctx.risks) {
    const sym = r.tokenSymbol ? ` (${r.tokenSymbol})` : '';
    const unresolved: string[] = [];
    if (r.honeypot === null) unresolved.push('honeypot');
    if (r.criticalAdmin === null) unresolved.push('critical_admin');
    if (r.sellTaxBps === null) unresolved.push('sell_tax');
    if (r.top10HolderPct === null) unresolved.push('top10_holder_pct');
    if (r.buySimulation === null) unresolved.push('buy_simulation');
    if (r.sellSimulation === null) unresolved.push('sell_sell_simulation');
    if (unresolved.length > 0) {
      missingData.push(`${r.tokenAddress}${sym} risk fields unresolved: ${unresolved.join(', ')}`);
    }
  }

  // Anomalies — only report what the deterministic data actually shows
  if (m.maximumPriceDivergencePct !== null && m.maximumPriceDivergencePct > 1) {
    anomalies.push(`Price providers diverged by ${m.maximumPriceDivergencePct.toFixed(4)}%.`);
  }
  if (ctx.risks.some((r) => r.sellSimulation === false)) {
    anomalies.push('At least one token has a recorded failed sell simulation.');
  }
  if (ctx.risks.some((r) => r.honeypot === true)) {
    anomalies.push('At least one token has a recorded honeypot=true signal.');
  }

  // Confidence is bounded by data availability. No model called here.
  const filledMetricCount = countFilledMetrics(m);
  const confidence: AnalysisResult['confidence'] =
    filledMetricCount >= 12 && missingData.length <= 3 ? 'high' :
    filledMetricCount >= 7 ? 'medium' : 'low';

  // Trim arrays to the schema's max lengths (20 items each)
  return {
    summary,
    strengths: trim(strengths, 20),
    risks: trim(risks, 20),
    missingData: trim(dedupe(missingData), 20),
    anomalies: trim(anomalies, 20),
    confidence,
  };
}

function buildFallbackSummary(ctx: AnalysisContext): string {
  const verdict = ctx.deterministic.approved ? 'Approved' : 'Rejected';
  const chain = `${ctx.chain.name} (${ctx.chain.id})`;
  const m = ctx.deterministic.metrics;
  const parts: string[] = [`${verdict} candidate on ${chain}, identity ${shortIdentity(ctx.pool.identity)}.`];
  if (m.tvlUsd !== null) parts.push(`TVL recorded as ${formatUsd(m.tvlUsd)}.`);
  if (m.expectedNetFeesUsd !== null) parts.push(`Expected net fees recorded as ${formatUsd(m.expectedNetFeesUsd)}.`);
  if (!ctx.deterministic.approved && ctx.deterministic.rejectionCodes.length > 0) {
    parts.push(`Primary rejection code: ${ctx.deterministic.rejectionCodes[0]!.code}.`);
  }
  if (ctx.deterministic.globalScore !== null) {
    parts.push(`Global score recorded as ${ctx.deterministic.globalScore.toFixed(4)}.`);
  }
  return parts.join(' ');
}

function countFilledMetrics(m: AnalysisContext['deterministic']['metrics']): number {
  let n = 0;
  for (const v of Object.values(m)) {
    if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) n += 1;
  }
  return n;
}

function trim(arr: string[], n: number): string[] {
  return arr.slice(0, n);
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return 'unavailable';
  return `$${n.toFixed(4)}`;
}

function shortIdentity(id: string): string {
  if (id.length <= 32) return id;
  return `${id.slice(0, 16)}…${id.slice(-8)}`;
}

// Suppress unused-import warnings for helpers kept for symmetry.
void ({} as z.infer<typeof AnalysisResultSchema>);
