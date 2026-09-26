/**
 * System + user prompts for the candidate analyst.
 *
 * The system prompt enforces the strict "facts only" contract. The
 * user prompt serializes the AnalysisContext as a labeled key/value
 * list. Every numeric value is taken verbatim from Viero's
 * deterministic records — no internal objects are dumped.
 */

export { ANALYSIS_PROMPT_VERSION } from './analysisContext.js';

export const ANALYSIS_SYSTEM_PROMPT = `You are Viero's candidate analyst. Your only job is to interpret the structured analysis context below and produce a JSON object that matches the schema exactly. The JSON will be parsed by a strict validator.

HARD RULES — read carefully:

1. Use ONLY facts present in the context block. If a fact is absent, put it in "missingData". Never guess, infer, or invent.
2. The "deterministic" block contains facts Viero already recorded. When you mention them in "summary" / "strengths" / "risks" / "anomalies", repeat the values verbatim — never re-interpret them as something different.
3. Approved vs rejected is a deterministic verdict. If "deterministic.approved" is false, the candidate was rejected by policy. NEVER suggest it is safe to deploy anyway. You may describe the rejection codes and the metrics, but you must not override the rejection.
4. Never claim an action occurred unless the context explicitly says it did. Viero has not executed any trade for this candidate; this is analysis, not action.
5. Never fabricate numeric values: no TVL, no holder concentration, no price targets, no APR / APY, no profit probability, no expected return, no volatility number, no fee forecast. If a metric is not in "deterministic.metrics", it goes into "missingData".
6. Never fabricate token behavior: no claim that "holders appear healthy", "taxes are low", "the token has no admin keys", etc. If the corresponding risk field is null or absent, the item belongs in "missingData".
7. Never claim APR / APY / yield forecasts. Viero does not store annualized yield; only the configured-window fee/TVL ratio is available. If the user wants annualized yield, report that data is missing.
8. Never claim profit probability. The "confidence" field is confidence in the analysis given the available data, NOT probability of profit.
9. Strengths, risks, missingData, anomalies: each entry is one short factual sentence or one labeled gap. No preambles, no qualifiers like "based on the data", no marketing language.
10. The "summary" is one or two sentences. It must state the deterministic verdict and the most material metric(s). Do not include new facts here that are not in the deterministic block.
11. Output JSON only — no prose, no markdown fences, no comments. Valid JSON object matching the schema below.

Schema (exact field names):
{
  "summary": string (1-2000 chars),
  "strengths": string[] (each 1-500 chars, max 20 items),
  "risks": string[] (each 1-500 chars, max 20 items),
  "missingData": string[] (each 1-500 chars, max 20 items),
  "anomalies": string[] (each 1-500 chars, max 20 items),
  "confidence": "low" | "medium" | "high"
}

Confidence guidance:
- "low" — most material fields are in missingData, OR multiple safety signals are null (honeypot, simulation, holder concentration).
- "medium" — core metrics present, some safety signals null.
- "high" — metrics, depth, fees, price-divergence, and risk evidence all present.

OUTPUT: a single JSON object, no extra text.`;

export function buildAnalysisUserPrompt(context: import('./analysisContext.js').AnalysisContext): string {
  return renderContext(context);
}

function renderContext(ctx: import('./analysisContext.js').AnalysisContext): string {
  const lines: string[] = ['CONTEXT (use only these facts):'];
  lines.push(`source_run: ${ctx.sourceRun.mode} id=${ctx.sourceRun.id} status=${ctx.sourceRun.status} started_at=${ctx.sourceRun.startedAt}`);
  lines.push(`chain: ${ctx.chain.name} (id=${ctx.chain.id})`);
  const poolAddr = ctx.pool.protocol === 'v3' ? ctx.pool.poolAddress ?? '?' : ctx.pool.poolId ?? '?';
  lines.push(`pool: ${ctx.pool.protocol}:${ctx.pool.dex}:${poolAddr}`);
  lines.push(`pool_identity: ${ctx.pool.identity}`);

  if (ctx.tokenPair) {
    lines.push(`token_pair: ${ctx.tokenPair.token0.symbol}/${ctx.tokenPair.token1.symbol} (${ctx.tokenPair.token0.address}, ${ctx.tokenPair.token1.address})`);
  } else {
    lines.push(`token_pair: unavailable (${(ctx.missingFields.includes('token pair symbols') ? 'flagged in missingData' : '')})`.trim());
  }

  // ── Deterministic verdict (must be repeated verbatim) ────────────
  lines.push(`deterministic.approved: ${ctx.deterministic.approved}`);
  if (ctx.deterministic.rejectionCodes.length === 0) {
    lines.push('deterministic.rejections: none');
  } else {
    lines.push('deterministic.rejections:');
    for (const r of ctx.deterministic.rejectionCodes) {
      lines.push(`  - ${r.code}: ${r.detail}`);
    }
  }
  lines.push(`deterministic.policy_version: ${ctx.deterministic.policyVersion}`);
  lines.push(`deterministic.score_version: ${ctx.deterministic.scoreVersion}`);

  // ── Metrics ─────────────────────────────────────────────────────
  const m = ctx.deterministic.metrics;
  const metricEntries: string[] = [];
  const pushIf = (label: string, raw: unknown, formatter: (v: unknown) => string) => {
    if (raw === null || raw === undefined) return;
    if (typeof raw === 'number' && !Number.isFinite(raw)) return;
    metricEntries.push(`${label}=${formatter(raw)}`);
  };
  pushIf('volume_usd', m.volumeUsd, formatUsd);
  pushIf('tvl_usd', m.tvlUsd, formatUsd);
  pushIf('depth_usd', m.depthUsd, formatUsd);
  pushIf('depth_down_usd', m.depthDownUsd, formatUsd);
  pushIf('depth_up_usd', m.depthUpUsd, formatUsd);
  pushIf('lp_fees_usd', m.lpFeesUsd, formatUsd);
  pushIf('gross_fees_usd', m.grossFeesUsd, formatUsd);
  pushIf('expected_net_fees_usd', m.expectedNetFeesUsd, formatUsd);
  pushIf('expected_fees_usd', m.expectedFeesUsd, formatUsd);
  pushIf('fee_tvl_pct', m.feeTvlPct, (v) => `${formatNumber(v as number)}%`);
  pushIf('fee_depth_pct', m.feeDepthPct, (v) => `${formatNumber(v as number)}%`);
  pushIf('volume_depth', m.volumeDepth, (v) => formatNumber(v as number));
  pushIf('unique_traders', m.uniqueTraders, (v) => String(v));
  pushIf('swap_count', m.swapCount, (v) => String(v));
  pushIf('max_price_divergence_pct', m.maximumPriceDivergencePct, (v) => `${formatNumber(v as number)}%`);
  pushIf('volatility_realized_pct', m.volatilityRealizedPct, (v) => `${formatNumber(v as number)}%`);
  pushIf('organic_score', m.organicScore, (v) => formatNumber(v as number));
  pushIf('organic_top_trader_share', m.organicTopTraderShare, (v) => formatNumber(v as number));
  pushIf('organic_reversal_share', m.organicReversalShare, (v) => formatNumber(v as number));
  pushIf('organic_balance', m.organicBalance, (v) => formatNumber(v as number));
  pushIf('organic_temporal', m.organicTemporal, (v) => formatNumber(v as number));
  pushIf('organic_unique_ratio', m.organicUniqueRatio, (v) => formatNumber(v as number));
  if (metricEntries.length > 0) lines.push(`deterministic.metrics: ${metricEntries.join(', ')}`);

  // ── Components + scores ────────────────────────────────────────
  const componentEntries = Object.entries(ctx.deterministic.components).map(([k, v]) => `${k}=${formatNumber(v)}`);
  if (componentEntries.length > 0) lines.push(`deterministic.components: ${componentEntries.join(', ')}`);
  if (ctx.deterministic.score !== null) lines.push(`deterministic.score: ${formatNumber(ctx.deterministic.score)}`);
  if (ctx.deterministic.globalScore !== null) lines.push(`deterministic.global_score: ${formatNumber(ctx.deterministic.globalScore)}`);

  // ── Risk evidence ──────────────────────────────────────────────
  if (ctx.risks.length === 0) {
    lines.push('risks: none recorded');
  } else {
    lines.push('risks:');
    for (const r of ctx.risks) {
      const parts: string[] = [];
      if (r.honeypot === true) parts.push('honeypot=true');
      else if (r.honeypot === false) parts.push('honeypot=false');
      else parts.push('honeypot=null');
      if (r.criticalAdmin === true) parts.push('critical_admin=true');
      else if (r.criticalAdmin === false) parts.push('critical_admin=false');
      else parts.push('critical_admin=null');
      if (r.sellTaxBps !== null) parts.push(`sell_tax_bps=${r.sellTaxBps}`);
      else parts.push('sell_tax_bps=null');
      if (r.top10HolderPct !== null) parts.push(`top10_holder_pct=${r.top10HolderPct}`);
      else parts.push('top10_holder_pct=null');
      if (r.buySimulation === true) parts.push('buy_simulation=true');
      else if (r.buySimulation === false) parts.push('buy_simulation=false');
      else parts.push('buy_simulation=null');
      if (r.sellSimulation === true) parts.push('sell_simulation=true');
      else if (r.sellSimulation === false) parts.push('sell_simulation=false');
      else parts.push('sell_simulation=null');
      if (r.smartMoneyScore !== null) parts.push(`smart_money_score=${r.smartMoneyScore}`);
      const symbol = r.tokenSymbol ? ` (${r.tokenSymbol})` : '';
      lines.push(`  - ${r.tokenAddress}${symbol}: ${parts.join(', ')}`);
    }
  }

  // ── Pool meta ──────────────────────────────────────────────────
  if (ctx.poolMeta) {
    const pm = ctx.poolMeta;
    const parts: string[] = [];
    if (pm.poolCreatedAt !== null) parts.push(`pool_created_at=${pm.poolCreatedAt}`);
    else parts.push('pool_created_at=null');
    if (pm.uniqueLps !== null) parts.push(`unique_lps=${pm.uniqueLps}`);
    else parts.push('unique_lps=null');
    if (pm.positionsCreated !== null) parts.push(`positions_created=${pm.positionsCreated}`);
    else parts.push('positions_created=null');
    if (pm.netLiquidityFlowUsd !== null) parts.push(`net_liquidity_flow_usd=${formatUsd(pm.netLiquidityFlowUsd)}`);
    else parts.push('net_liquidity_flow_usd=null');
    lines.push(`pool_meta: ${parts.join(', ')}`);
  } else {
    lines.push('pool_meta: unavailable (flagged in missingData)');
  }

  // ── Missing fields (explicit, for the LLM to surface) ──────────
  if (ctx.missingFields.length > 0) {
    lines.push(`preflagged_missing: ${ctx.missingFields.join(', ')}`);
  }

  return lines.join('\n');
}

function formatUsd(n: unknown): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'unavailable';
  return `$${num.toFixed(4)}`;
}

function formatNumber(n: unknown): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'unavailable';
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(6);
}
