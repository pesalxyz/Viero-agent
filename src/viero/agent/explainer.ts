/**
 * Decision-explanation service.
 *
 * Sits on top of the LlmClient abstraction. Takes a strongly-typed
 * ExplanationContext (built from deterministic Viero records) and
 * produces a short prose explanation.
 *
 * Behavioral guarantees:
 *   - `explain()` NEVER throws. Any failure mode (LLM disabled, provider
 *     error, timeout, malformed output, empty content) returns a
 *     deterministic fallback built from the context itself.
 *   - The result includes a `source` discriminator so callers (Telegram,
 *     CLI, logs) can render it appropriately.
 *   - No tool calls are issued. The system prompt forbids them and the
 *     explainer never sets `tools` on the ChatRequest.
 *   - No state is mutated. The explainer holds an LlmClient reference but
 *     is otherwise stateless.
 */
import {
  type ExplanationContext,
  type ExplanationResult,
  type ExplanationSource,
} from './explanationContext.js';
import {
  EXPLANATION_PROMPT_VERSION,
  EXPLANATION_SYSTEM_PROMPT,
  buildExplanationUserPrompt,
} from './explainerPrompt.js';
import { type LlmClient, type Role, LLM_NOT_CONFIGURED_ERROR } from './llmClient.js';

// Re-export for downstream consumers (Telegram conversational handler)
// that need to log or otherwise reference the prompt version.
export { EXPLANATION_PROMPT_VERSION };

/**
 * Map an ExplanationContext to the most appropriate model role.
 *
 *   screening / rejected_candidate / accepted_candidate
 *   candidate_selected_preview / plan_created / plan_blocked / no_candidates
 *   → SCREENER
 *
 *   management
 *   → MANAGER
 *
 *   everything else (run-level / unknown / replay)
 *   → GENERAL
 *
 * Pure function — no I/O. Callers can use this to pick a role when
 * constructing a DecisionExplainer.
 */
export function roleForExplanationContext(context: ExplanationContext): Role {
  switch (context.eventType) {
    case 'screening':
    case 'rejected_candidate':
    case 'accepted_candidate':
    case 'candidate_selected_preview':
    case 'plan_created':
    case 'plan_blocked':
    case 'no_candidates':
      return 'SCREENER';
    case 'management':
      return 'MANAGER';
    case 'replay':
    case 'run_failed':
    case 'unknown':
      return 'GENERAL';
  }
}

export type DecisionExplainerOptions = {
  /**
   * Default role whose model configuration to use when `explain()`
   * is called without an explicit role override. Defaults to 'SCREENER'.
   * Per-call `explain(ctx, { role })` takes precedence over this default.
   */
  role?: Role;
  /** Maximum tokens for the explanation. Defaults to 256 — explanations are short. */
  maxTokens?: number;
  /** Temperature override. Defaults to 0.0 for determinism. */
  temperature?: number;
};

/**
 * Per-call overrides for `DecisionExplainer.explain()`.
 *
 * `role` selects the model configuration for this single call. When
 * omitted, the constructor-set role (or 'SCREENER' as a final default)
 * is used. Callers that route by explanation context type — e.g.
 * `roleForExplanationContext(ctx)` — should pass `role` here.
 */
export type ExplainOptions = {
  role?: Role;
  temperature?: number;
  maxTokens?: number;
};

export class DecisionExplainer {
  private readonly role: Role;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(
    private readonly client: LlmClient,
    options: DecisionExplainerOptions = {},
  ) {
    this.role = options.role ?? 'SCREENER';
    this.maxTokens = options.maxTokens ?? 256;
    this.temperature = options.temperature ?? 0.0;
  }

  /**
   * Produce a human-readable explanation for the given context.
   * Always resolves; never rejects.
   *
   * Role selection priority (highest first):
   *   1. `options.role` — explicit per-call override.
   *   2. `roleForExplanationContext(context)` — derived from event type.
   *   3. `this.role` — constructor default (defaults to 'SCREENER').
   *
   * Layered callers (e.g. the Telegram conversational handler) typically
   * rely on the context-derived role and pass no explicit `options.role`.
   */
  async explain(context: ExplanationContext, options: ExplainOptions = {}): Promise<ExplanationResult> {
    const role = options.role ?? roleForExplanationContext(context) ?? this.role;
    const userPrompt = buildExplanationUserPrompt(context);
    const systemPrompt = `${EXPLANATION_SYSTEM_PROMPT}\n\nPROMPT_VERSION: ${EXPLANATION_PROMPT_VERSION}`;

    try {
      const response = await this.client.chat({
        role,
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: options.temperature ?? this.temperature,
        maxTokens: options.maxTokens ?? this.maxTokens,
      });

      const trimmed = (response.content ?? '').trim();
      if (trimmed.length === 0) {
        return { text: buildFallbackExplanation(context), source: 'fallback-no-content', llmAvailable: false };
      }
      return { text: trimmed, source: 'llm', llmAvailable: true };
    } catch (error) {
      // Provider errors (HTTP, timeout, network) fall back to
      // deterministic text so conversational flows keep working.
      return { text: buildFallbackExplanation(context), source: 'fallback-error', llmAvailable: false };
    }
  }
}

/**
 * Deterministic fallback explanation built directly from the structured context.
 * Used when LLM is disabled, errors, times out, or returns empty content.
 *
 * The fallback only restates facts present in the context. It never invents
 * details. If a key piece of context is missing, it says so explicitly.
 */
export function buildFallbackExplanation(ctx: ExplanationContext): string {
  const o = ctx.outcome;
  const subject = describeSubject(ctx);
  switch (o.kind) {
    case 'rejected': {
      if (ctx.rejections && ctx.rejections.length > 0) {
        const primary = ctx.rejections[0]!;
        const extra = ctx.rejections.length > 1 ? ` (${ctx.rejections.length - 1} additional check${ctx.rejections.length - 1 === 1 ? '' : 's'} failed)` : '';
        return `${subject} was rejected by deterministic policy with code ${primary.code}${extra}.`;
      }
      if (o.reasonCode) return `${subject} was rejected (code ${o.reasonCode}).`;
      return `${subject} was rejected. Reason unavailable.`;
    }
    case 'rejected_chain_paused':
      return `${subject} was not screened because the chain is paused.`;
    case 'rejected_no_observations':
      return `${subject} was not screened because no complete observations were available.`;
    case 'approved':
      return `${subject} was approved by deterministic policy.`;
    case 'preview':
      return `${subject} was selected for preview.`;
    case 'plan_created':
      return `${subject} a paper-only position plan was created${ctx.plan?.depositUsd !== undefined ? ` for ${ctx.plan.depositUsd} USD` : ''}.`;
    case 'plan_blocked':
      return `${subject} the plan was blocked before creation${o.reasonCode ? ` by safety check ${o.reasonCode}` : ''}.`;
    case 'no_candidates':
      return `No candidates were available for screening.`;
    case 'held':
      return `${subject} was held.${o.reasonDetail ? ` ${o.reasonDetail}.` : o.reasonCode ? ` Reason: ${o.reasonCode}.` : ''}`;
    case 'closed':
      return `${subject} was closed.${o.reasonDetail ? ` Reason: ${o.reasonDetail}.` : o.reasonCode ? ` Code: ${o.reasonCode}.` : ''}`;
    case 'emergency_closed':
      return `${subject} was emergency-closed.${o.reasonDetail ? ` Reason: ${o.reasonDetail}.` : o.reasonCode ? ` Code: ${o.reasonCode}.` : ''}`;
    case 'rebalanced':
      return `${subject} was closed for rebalance.${o.reasonDetail ? ` Reason: ${o.reasonDetail}.` : ''}`;
    case 'paused':
      return `${subject} was paused.${o.reasonDetail ? ` Reason: ${o.reasonDetail}.` : ''}`;
    case 'claim':
      return `${subject} fees were claimed.`;
    case 'errored':
      return `${subject} an error occurred${o.reasonCode ? ` (${o.reasonCode})` : ''}.${o.reasonDetail ? ` ${o.reasonDetail}.` : ''}`;
    default:
      return `${subject} outcome: ${o.kind}.`;
  }
}

function describeSubject(ctx: ExplanationContext): string {
  if (ctx.tokenPair) {
    return `The ${ctx.tokenPair.token0.symbol}/${ctx.tokenPair.token1.symbol} pool on ${ctx.chain?.name ?? 'unknown chain'}`;
  }
  if (ctx.pool && ctx.chain) {
    return `The pool on ${ctx.chain.name}`;
  }
  if (ctx.pool) {
    return 'The pool';
  }
  if (ctx.position?.identity) {
    return 'The position';
  }
  return 'The event';
}


export { type ExplanationSource };
