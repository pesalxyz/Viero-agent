/**
 * Conversational message handler for Telegram.
 *
 * Sits between the Telegram layer and the existing retrieval +
 * explanation layers. Responsibilities:
 *
 *   1. Classify the user message into a validated `ReadOnlyIntent`
 *      using the deterministic fast-path classifier first, then the
 *      LLM classifier as a fallback. NEVER invokes any execution code.
 *   2. Map the validated intent to a deterministic retrieval call.
 *      The LLM does not choose retrieval method names — the switch
 *      in `executeIntent()` does.
 *   3. Format results either deterministically (listing questions) or
 *      via `DecisionExplainer` (explanation questions). Explanation
 *      calls pass `roleForExplanationContext(ctx)` to the explainer
 *      so each context type uses the right model.
 *   4. Surface ambiguity cleanly when multiple records match.
 *   5. Sanitize output for Telegram (plain text).
 *   6. Never throw. Always return a string the bot can send.
 *
 * Observability: each classify+execute cycle emits a single structured
 * log line via `console.error` (matching the existing project's bare
 * console logging style). The line carries intent type, classification
 * source, and latency — never user message content, never provider
 * responses, never credentials.
 */
import { type ChainId, errorMessage } from '../domain.js';
import {
  type RetrievalService,
  type RetrievedCandidate,
  type RetrievedDecision,
  type RetrievedPosition,
  type RetrievedPositionEvent,
  type RetrievedError,
  contextForRetrievedCandidate,
  contextForRetrievedDecision,
  contextForRetrievedError,
  contextForRetrievedPosition,
  contextForRetrievedPositionEvent,
  contextForEmptyLatestRun,
} from '../agent/retrieval.js';
import { type ExplanationContext } from '../agent/explanationContext.js';
import { contextFromRetrievedCandidate, type AnalysisContext, ANALYSIS_PROMPT_VERSION } from '../agent/analysisContext.js';
import { CandidateAnalyst } from '../agent/analyst.js';
import { DecisionExplainer, roleForExplanationContext, EXPLANATION_PROMPT_VERSION } from '../agent/explainer.js';
import { classifyIntentDeterministic, classifyIntentWithLlm, INTENT_PROMPT_VERSION, type ReadOnlyIntent, type ConversationRefs } from './intent.js';
import { ConversationStore } from './conversation.js';
import { chunkTelegramText } from '../telegram.js';

export type ConversationalHandlerOptions = {
  retrieval: RetrievalService;
  explainer: DecisionExplainer;
  /** Candidate analyst. Required. */
  analyst: CandidateAnalyst;
  /** LlmClient-shaped dependency used only for intent classification. */
  llmClient: { chat(req: any): Promise<{ content: string | null; toolCalls?: unknown[]; finishReason?: string }>; isEnabled(): boolean };
  store?: ConversationStore;
  /** Per-intent timeout. Defaults to 15s. */
  timeoutMs?: number;
};

export class ConversationalHandler {
  private readonly retrieval: RetrievalService;
  private readonly explainer: DecisionExplainer;
  private readonly analyst: CandidateAnalyst;
  private readonly llmClient: ConversationalHandlerOptions['llmClient'];
  private readonly store: ConversationStore;
  private readonly timeoutMs: number;

  constructor(options: ConversationalHandlerOptions) {
    this.retrieval = options.retrieval;
    this.explainer = options.explainer;
    this.analyst = options.analyst; // required
    if (!this.analyst) throw new Error('ConversationalHandler requires an analyst');
    this.llmClient = options.llmClient;
    this.store = options.store ?? new ConversationStore();
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  /** Test/inspection accessor — exposes the underlying store. */
  getStore(): ConversationStore { return this.store; }

  /**
   * Main entry point. Always returns a non-empty string suitable for
   * Telegram. Never throws. Emits one structured log line per call.
   */
  async handle(chatId: number, message: string): Promise<string> {
    const refs = this.store.get(chatId);
    const classifyStart = Date.now();
    const classification = await this.classifyTracked(message, refs);
    const classifyMs = Date.now() - classifyStart;

    const intent = classification.intent;
    const source = classification.source;

    let response: string;
    try {
      response = await this.executeIntent(intent, refs);
    } catch (error) {
      response = `Sorry, I hit an internal error: ${sanitize(errorMessage(error))}`;
    }
    this.updateRefs(chatId, intent, response);

    this.logIntent({
      chatId,
      intentType: intent.type,
      source,
      classifyMs,
    });
    return response;
  }

  /**
   * Classify a message and tag the result with the source so we can
   * emit a single structured log line per call.
   */
  private async classifyTracked(message: string, refs: ConversationRefs | undefined): Promise<{ intent: ReadOnlyIntent; source: 'deterministic' | 'llm' | 'fallback' }> {
    const det = classifyIntentDeterministic(message, refs);
    if (det) return { intent: det, source: 'deterministic' };

    const result = await classifyIntentWithLlm(message, this.llmClient, refs, { timeoutMs: this.timeoutMs });
    if (result.kind === 'parsed') return { intent: result.intent, source: 'llm' };
    return { intent: { type: 'unknown' }, source: 'fallback' };
  }

  /**
   * Emit a single structured observability line. No message content,
   * no provider responses, no credentials — only intent type, source,
   * latency, and the chat id (which Telegram already exposes).
   */
  private logIntent(event: { chatId: number; intentType: string; source: 'deterministic' | 'llm' | 'fallback'; classifyMs: number }): void {
    const line = [
      `[viero.conversation]`,
      `chat_id=${event.chatId}`,
      `intent=${event.intentType}`,
      `source=${event.source}`,
      `classify_ms=${event.classifyMs}`,
    ].join(' ');
    console.error(line);
  }

  /**
   * Emit a single structured observability line for an analysis call.
   * Carries the analysis role, source, latency, and a truncated
   * candidate identity. Never logs the LLM response, the user
   * message, the API key, or any other sensitive data.
   */
  private logAnalysis(event: { chatId: number; candidateIdentity: string; role: string; source: string; latencyMs: number }): void {
    const line = [
      `[viero.analysis]`,
      `analysis_prompt_version=${ANALYSIS_PROMPT_VERSION}`,
      `candidate=${event.candidateIdentity}`,
      `role=${event.role}`,
      `source=${event.source}`,
      `latency_ms=${event.latencyMs}`,
    ].join(' ');
    console.error(line);
  }

  /**
   * Emit prompt-version banner once on bot startup. Reuses the project's
   * existing `console.error` logging convention (see `telegram.ts`,
   * `cli.ts`).
   */
  emitStartupBanner(): void {
    console.error(
      `[viero.conversation] startup intent_prompt_version=${INTENT_PROMPT_VERSION} ` +
      `explanation_prompt_version=${EXPLANATION_PROMPT_VERSION} ` +
      `analysis_prompt_version=${ANALYSIS_PROMPT_VERSION} analysis=enabled`,
    );
  }

  // ─── Classification ─────────────────────────────────────────────

  private async classify(message: string, refs: ConversationRefs | undefined): Promise<ReadOnlyIntent> {
    // Wrapper kept for backward compat with subclasses / tests. Forwards
    // to classifyTracked and discards the source label.
    const result = await this.classifyTracked(message, refs);
    return result.intent;
  }

  // ─── Execution ─────────────────────────────────────────────────

  private async executeIntent(intent: ReadOnlyIntent, refs: ConversationRefs | undefined): Promise<string> {
    switch (intent.type) {
      case 'help':
        return HELP_MESSAGE;

      case 'unknown':
        return this.formatUnknown(intent, refs);

      case 'execution_request':
        return this.formatExecutionDenial(intent.action);

      case 'list_open_positions':
        return this.formatOpenPositions(intent.chainId, intent.limit);

      case 'list_closed_positions':
        return this.formatClosedPositions(intent.chainId, intent.limit);

      case 'latest_run':
        return this.formatLatestRun(intent.chainId);

      case 'latest_run_for_chain':
        return this.formatLatestRunForChain(intent.chainId);

      case 'recent_rejected_candidates':
        return this.formatRecentRejected(intent.chainId, intent.poolHint, intent.limit);

      case 'recent_approved_candidates':
        return this.formatRecentApproved(intent.chainId, intent.poolHint, intent.limit);

      case 'recent_errors':
        return this.formatRecentErrors(intent.chainId, intent.limit);

      case 'recent_close_events':
        return this.formatRecentCloseEvents(intent.chainId, intent.limit);

      case 'recent_activity':
        return this.formatRecentActivity(intent.chainId, intent.limit);

      case 'find_candidate':
        return this.formatFindCandidate(intent.candidateIdentity, intent.poolHint, intent.chainId, refs);

      case 'find_position':
        return this.formatFindPosition(intent.positionId, intent.poolHint, refs);

      case 'explain_candidate':
        return this.formatExplainCandidate(intent.candidateIdentity, intent.poolHint, intent.chainId, refs);

      case 'explain_position':
        return this.formatExplainPosition(intent.positionId, intent.poolHint, refs);

      case 'explain_latest_run':
        return this.formatExplainLatestRun();

      case 'analyze_candidate':
        return this.formatAnalyzeCandidate(intent.candidateIdentity, intent.poolHint, intent.chainId, refs);

      case 'analyze_position':
        return this.formatAnalyzePosition(intent.positionId, intent.poolHint, refs);
    }
  }

  // ─── Deterministic formatters (no LLM) ─────────────────────────

  private async formatOpenPositions(chainId: ChainId | undefined, limit: number | undefined): Promise<string> {
    const positions = await this.retrieval.openPositions({ ...(chainId !== undefined ? { chainId } : {}), limit });
    if (positions.length === 0) return 'No open positions are currently recorded.';
    return this.formatPositionList(positions);
  }

  private async formatClosedPositions(chainId: ChainId | undefined, limit: number | undefined): Promise<string> {
    const positions = await this.retrieval.closedPositions({ ...(chainId !== undefined ? { chainId } : {}), limit });
    if (positions.length === 0) return 'No closed positions are currently recorded.';
    return this.formatPositionList(positions);
  }

  private formatPositionList(positions: RetrievedPosition[]): string {
    const lines: string[] = [];
    for (const rp of positions) {
      const last = rp.position.events.at(-1);
      const pnlSign = rp.position.netPnlUsd >= 0 ? '+' : '';
      lines.push(
        `• ${rp.position.id} (${rp.chainName}) status=${rp.position.status} ` +
        `pnl=${pnlSign}${rp.position.netPnlUsd.toFixed(4)} USD ` +
        `unclaimed=${rp.position.unclaimedFeesUsd.toFixed(4)} USD ` +
        `last_action=${last?.action ?? 'unknown'}`,
      );
    }
    return lines.join('\n');
  }

  private async formatLatestRun(chainId: ChainId | undefined): Promise<string> {
    const run = chainId !== undefined
      ? await this.retrieval.latestRunForChain(chainId)
      : await this.retrieval.latestRun();
    if (!run) return 'No runs have been recorded yet.';
    const chainLabel = chainId !== undefined ? ` on ${chainNameOrUnknown(chainId)}` : '';
    return (
      `Latest run${chainLabel}: ${run.id}\n` +
      `mode=${run.mode} status=${run.status} ` +
      `started=${new Date(run.startedAt * 1000).toISOString()}\n` +
      `candidates=${run.candidates.length} (approved=${run.candidates.filter((c) => c.approved).length}, ` +
      `rejected=${run.candidates.filter((c) => !c.approved).length}) ` +
      `positions=${run.positions.length} errors=${run.errors.length}`
    );
  }

  private async formatLatestRunForChain(chainId: ChainId): Promise<string> {
    const run = await this.retrieval.latestRunForChain(chainId);
    if (!run) return `No runs recorded for ${chainNameOrUnknown(chainId)}.`;
    return (
      `Latest run on ${chainNameOrUnknown(chainId)}: ${run.id}\n` +
      `status=${run.status} candidates=${run.candidates.length} ` +
      `approved=${run.candidates.filter((c) => c.approved).length} errors=${run.errors.length}`
    );
  }

  private async formatRecentRejected(chainId: ChainId | undefined, poolHint: string | undefined, limit: number | undefined): Promise<string> {
    const out = await this.retrieval.recentRejectedCandidates({
      ...(chainId !== undefined ? { chainId } : {}),
      ...(poolHint !== undefined ? { poolHint } : {}),
      limit,
    });
    if (out.length === 0) return 'No rejected candidates in the recorded history.';
    const lines: string[] = [`${out.length} most recent rejected candidate${out.length === 1 ? '' : 's'}:`];
    for (const rc of out) {
      const first = rc.candidate.rejections[0];
      lines.push(`• ${rc.chainName} ${shortIdentity(rc.candidate.identity)} — ${first?.code ?? 'no code'}${first?.detail ? ` (${first.detail})` : ''}`);
    }
    return lines.join('\n');
  }

  private async formatRecentApproved(chainId: ChainId | undefined, poolHint: string | undefined, limit: number | undefined): Promise<string> {
    const out = await this.retrieval.recentApprovedCandidates({
      ...(chainId !== undefined ? { chainId } : {}),
      ...(poolHint !== undefined ? { poolHint } : {}),
      limit,
    });
    if (out.length === 0) return 'No approved candidates in the recorded history.';
    const lines: string[] = [`${out.length} most recent approved candidate${out.length === 1 ? '' : 's'}:`];
    for (const rc of out) {
      const score = rc.candidate.globalScore?.toFixed(4) ?? 'n/a';
      lines.push(`• ${rc.chainName} ${shortIdentity(rc.candidate.identity)} — global_score=${score}`);
    }
    return lines.join('\n');
  }

  private async formatRecentErrors(chainId: ChainId | undefined, limit: number | undefined): Promise<string> {
    const out = await this.retrieval.recentErrors({
      ...(chainId !== undefined ? { chainId } : {}),
      limit,
    });
    if (out.length === 0) return 'No errors have been recorded recently.';
    const lines: string[] = [`${out.length} most recent error${out.length === 1 ? '' : 's'}:`];
    for (const re of out) {
      lines.push(`• ${re.chainName}${re.pool ? ` ${shortIdentity(re.pool)}` : ''}: ${re.error}`);
    }
    return lines.join('\n');
  }

  private async formatRecentCloseEvents(chainId: ChainId | undefined, limit: number | undefined): Promise<string> {
    const out = await this.retrieval.recentCloseEvents({
      ...(chainId !== undefined ? { chainId } : {}),
      limit,
    });
    if (out.length === 0) return 'No recent close events recorded.';
    const lines: string[] = [`${out.length} recent close-related event${out.length === 1 ? '' : 's'}:`];
    for (const rpe of out) {
      lines.push(`• ${rpe.chainName} ${shortIdentity(rpe.position.id)} — ${rpe.event.action} (${rpe.event.reason})`);
    }
    return lines.join('\n');
  }

  private async formatRecentActivity(chainId: ChainId | undefined, limit: number | undefined): Promise<string> {
    const [runs, decisions, errors, closes] = await Promise.all([
      this.retrieval.recentRuns({ ...(chainId !== undefined ? { chainId } : {}), limit }),
      this.retrieval.recentDecisions({ ...(chainId !== undefined ? { chainId } : {}), limit }),
      this.retrieval.recentErrors({ ...(chainId !== undefined ? { chainId } : {}), limit }),
      this.retrieval.recentCloseEvents({ ...(chainId !== undefined ? { chainId } : {}), limit }),
    ]);
    if (runs.length === 0) return 'No recorded activity.';
    const lines: string[] = [`Recent activity (${runs.length} run${runs.length === 1 ? '' : 's'}):`];
    for (const run of runs.slice(0, Math.min(runs.length, limit ?? 10))) {
      const ts = new Date(run.startedAt * 1000).toISOString();
      lines.push(`• ${ts} run=${run.id} mode=${run.mode} status=${run.status} candidates=${run.candidates.length} errors=${run.errors.length}`);
    }
    if (decisions.length > 0) {
      lines.push('');
      lines.push(`Recent decisions (${decisions.length}):`);
      for (const rd of decisions.slice(0, 5)) {
        lines.push(`• ${rd.chainName}: ${rd.decision.selection.action} — ${rd.decision.selection.reason}`);
      }
    }
    if (errors.length > 0) {
      lines.push('');
      lines.push(`Recent errors (${errors.length}):`);
      for (const re of errors.slice(0, 5)) lines.push(`• ${re.chainName}: ${re.error}`);
    }
    if (closes.length > 0) {
      lines.push('');
      lines.push(`Recent close events (${closes.length}):`);
      for (const rpe of closes.slice(0, 5)) lines.push(`• ${rpe.chainName}: ${rpe.position.id} ${rpe.event.action} (${rpe.event.reason})`);
    }
    return lines.join('\n');
  }

  private async formatFindCandidate(
    candidateIdentity: string | undefined,
    poolHint: string | undefined,
    chainId: ChainId | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    const candidates = await this.findCandidates(candidateIdentity, poolHint, chainId, refs, false);
    if (candidates.length === 0) return 'No matching recorded candidate was found.';
    return this.formatCandidateList(candidates);
  }

  private async formatFindPosition(
    positionId: string | undefined,
    poolHint: string | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    const positions = await this.findPositions(positionId, poolHint, refs);
    if (positions.length === 0) return 'No matching recorded position was found.';
    return this.formatPositionList(positions);
  }

  // ─── Explanation formatters (use DecisionExplainer) ────────────

  private async formatExplainCandidate(
    candidateIdentity: string | undefined,
    poolHint: string | undefined,
    chainId: ChainId | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    const candidates = await this.findCandidates(candidateIdentity, poolHint, chainId, refs, true);
    if (candidates.length === 0) return 'No matching recorded candidate was found. I cannot invent an explanation.';
    if (candidates.length > 1) {
      return `I found ${candidates.length} matching candidates. Please specify one:\n${this.formatCandidateList(candidates)}`;
    }
    return this.explainRecord(contextForRetrievedCandidate(candidates[0]!));
  }

  private async formatExplainPosition(
    positionId: string | undefined,
    poolHint: string | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    let positions = await this.findPositions(positionId, poolHint, refs);
    // Final fallback: "that position" with no id → most recent position
    // across all runs, regardless of open/closed status. Scans both
    // open and closed in the most-recent-first order.
    if (positions.length === 0 && !positionId && !poolHint) {
      const [open, closed] = await Promise.all([
        this.retrieval.openPositions({ limit: 5 }),
        this.retrieval.closedPositions({ limit: 5 }),
      ]);
      positions = [...open, ...closed].slice(0, 10);
    }
    if (positions.length === 0) return 'No matching recorded position was found. I cannot invent an explanation.';
    if (positions.length > 1) {
      return `I found ${positions.length} matching positions. Please specify one:\n${this.formatPositionList(positions)}`;
    }
    return this.explainRecord(contextForRetrievedPosition(positions[0]!));
  }

  private async formatExplainLatestRun(): Promise<string> {
    const run = await this.retrieval.latestRun();
    if (!run) return 'No runs have been recorded yet.';
    // Always deterministic for the run-summary case. LLM is reserved
    // for per-record explanations (why this pool, why this position).
    return this.formatLatestRun(undefined);
  }

  // ─── Assisted analysis (advisory only, never execution) ────────

  private async formatAnalyzeCandidate(
    candidateIdentity: string | undefined,
    poolHint: string | undefined,
    chainId: ChainId | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    const candidates = await this.findCandidates(candidateIdentity, poolHint, chainId, refs, false);
    if (candidates.length === 0) return 'No matching recorded candidate was found.';
    if (candidates.length > 1) {
      return `I found ${candidates.length} matching candidates. Please specify one by identity:\n${this.formatCandidateList(candidates)}`;
    }
    return this.analyzeRetrieved(candidates[0]!);
  }

  private async formatAnalyzePosition(
    positionId: string | undefined,
    poolHint: string | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<string> {
    const positions = await this.findPositions(positionId, poolHint, refs);
    if (positions.length === 0) return 'No matching recorded position was found.';
    if (positions.length > 1) {
      return `I found ${positions.length} matching positions. Please specify one by id or address:\n${this.formatPositionList(positions)}`;
    }
    return 'Position analysis uses the same pipeline as candidate analysis (no separate analyzer yet). Try analyzing the pool the position is in.';
  }

  private async analyzeRetrieved(rc: RetrievedCandidate): Promise<string> {
    const run = await this.retrieval.findRunById(rc.run.id);
    if (!run) return 'The source run for this candidate is no longer available in recorded history.';
    const ctx = contextFromRetrievedCandidate(rc, run);
    if (!ctx) return 'Could not build analysis context for this candidate.';
    const startedAt = Date.now();
    const { result, source } = await this.analyst!.analyze(ctx);
    const latencyMs = Date.now() - startedAt;
    this.logAnalysis({
      chatId: -1,
      candidateIdentity: shortIdentity(rc.candidate.identity),
      role: 'SCREENER',
      source,
      latencyMs,
    });
    return formatAnalysisResult(result, source);
  }

  // ─── Shared helpers ────────────────────────────────────────────

  private async findCandidates(
    candidateIdentity: string | undefined,
    poolHint: string | undefined,
    chainId: ChainId | undefined,
    refs: ConversationRefs | undefined,
    fallbackToLatestRejected: boolean,
  ): Promise<RetrievedCandidate[]> {
    const resolvedIdentity = candidateIdentity ?? refs?.lastCandidateIdentity;
    if (resolvedIdentity) {
      return this.retrieval.findCandidatesByIdentity(resolvedIdentity, { limit: 5 });
    }
    if (poolHint) {
      return this.retrieval.recentRejectedCandidates({ ...(chainId !== undefined ? { chainId } : {}), poolHint, limit: 5 });
    }
    if (fallbackToLatestRejected) {
      const opts = chainId !== undefined ? { chainId, limit: 1 } : { limit: 1 };
      return this.retrieval.recentRejectedCandidates(opts);
    }
    return [];
  }

  private async findPositions(
    positionId: string | undefined,
    poolHint: string | undefined,
    refs: ConversationRefs | undefined,
  ): Promise<RetrievedPosition[]> {
    const resolvedId = positionId ?? refs?.lastPositionId;
    if (resolvedId) {
      // Scan all runs for this id and return every match, so callers
      // can surface ambiguity when the same id appears in multiple runs.
      const all = await this.retrieval.recentRuns({ limit: 100 });
      const out: RetrievedPosition[] = [];
      for (const run of all) {
        const p = run.positions.find((pos) => pos.id === resolvedId);
        if (p) {
          out.push({
            run: { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, mode: run.mode, status: run.status },
            chainId: p.chainId,
            chainName: chainNameOrUnknown(p.chainId),
            position: p,
          });
        }
      }
      return out;
    }
    if (poolHint) {
      return this.retrieval.positionsForPool(poolHint, { limit: 5 });
    }
    return [];
  }

  private async explainRecord(ctx: ExplanationContext): Promise<string> {
    // Route the model selection by the explanation context type so
    // screening events use the SCREENER model, management events use
    // the MANAGER model, and run-level / error / general events use
    // the GENERAL model. See `roleForExplanationContext` for the full
    // mapping. The role is passed per-call to `explain()`; the
    // DecisionExplainer's constructor-set role is only used as a
    // fallback for callers that do not provide one.
    const role = roleForExplanationContext(ctx);
    const result = await this.explainer.explain(ctx, { role });
    return result.text;
  }

  private formatCandidateList(candidates: RetrievedCandidate[]): string {
    const lines: string[] = [];
    candidates.forEach((rc, i) => {
      const status = rc.candidate.approved ? 'approved' : 'rejected';
      const firstRej = rc.candidate.rejections[0];
      const rejText = rc.candidate.approved ? '' : ` [${firstRej?.code ?? 'no code'}]`;
      lines.push(`${i + 1}. ${rc.chainName} ${shortIdentity(rc.candidate.identity)} — ${status}${rejText}`);
    });
    return lines.join('\n');
  }

  private formatUnknown(intent: ReadOnlyIntent & { type: 'unknown' }, _refs: ConversationRefs | undefined): string {
    return 'I could not map your question to a recorded Viero event. Try rephrasing, or send /help for available commands.';
  }

  private formatExecutionDenial(action: string): string {
    return `Conversational chat cannot execute ${sanitize(action)}. Viero Telegram chat is read-only. To act, run the corresponding command or operator action manually.`;
  }

  private updateRefs(chatId: number, intent: ReadOnlyIntent, _response: string): void {
    const patch: Partial<Omit<ConversationRefs, 'chatId' | 'updatedAt'>> = {};
    switch (intent.type) {
      case 'explain_candidate':
      case 'find_candidate':
        if (intent.candidateIdentity) patch.lastCandidateIdentity = intent.candidateIdentity;
        if (intent.chainId !== undefined) patch.lastChainId = intent.chainId;
        break;
      case 'explain_position':
      case 'find_position':
        if (intent.positionId) patch.lastPositionId = intent.positionId;
        break;
      case 'latest_run_for_chain':
        if (intent.chainId !== undefined) patch.lastChainId = intent.chainId;
        break;
      default:
        if (intent.type === 'list_open_positions' || intent.type === 'recent_rejected_candidates') {
          if ('chainId' in intent && intent.chainId !== undefined) patch.lastChainId = intent.chainId;
        }
    }
    if (Object.keys(patch).length > 0) this.store.set(chatId, patch);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

const HELP_MESSAGE = [
  'Viero conversational bot is online. Conversational chat is READ-ONLY.',
  '',
  'You can ask in plain English, for example:',
  '  what positions are open?',
  '  what did Viero do recently?',
  '  why did you reject this pool?',
  '  why did you close that position?',
  '  what were the latest rejected candidates?',
  '  did anything fail recently?',
  '  what happened on Base?',
  '  explain the last screening cycle.',
  '',
  'Slash commands still work:',
  '  /report  /screen  /pause  /resume  /help',
  '',
  'Action requests (close, swap, deploy, etc.) are not executed through chat.',
].join('\n');

function chainNameOrUnknown(chainId: ChainId): string {
  try {
    // Lazy import to avoid circulars; the function is small.
    const { getChain } = require('../config/chains.js') as typeof import('../config/chains.js');
    return getChain(chainId).name;
  } catch {
    return `chain ${chainId}`;
  }
}

function shortIdentity(id: string): string {
  // Don't leak full pool addresses in chat — show first 8 + last 4 chars.
  if (id.length <= 16) return id;
  const colonParts = id.split(':');
  return colonParts.map((p) => (p.length > 16 ? `${p.slice(0, 8)}…${p.slice(-4)}` : p)).join(':');
}

function sanitize(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Build a synthetic ExplanationContext for "explain the latest run" by
 * aggregating the latest run's decisions + errors. Falls back to a
 * deterministic no-candidate context if there is nothing to explain.
 */
function buildExplainLatestRunContext(run: import('../storage/repositories.js').AgentRun): ExplanationContext | null {
  const lastError = run.errors.at(-1);
  const lastDecision = run.decisions.at(-1);
  if (lastError) {
    return {
      ...contextForRetrievedError({
        run: { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, mode: run.mode, status: run.status },
        chainId: lastError.chainId,
        chainName: chainNameOrUnknown(lastError.chainId),
        ...(lastError.pool !== undefined ? { pool: lastError.pool } : {}),
        error: lastError.error,
      }),
      run: { id: run.id, mode: run.mode, startedAt: run.startedAt, status: run.status },
    };
  }
  if (lastDecision) {
    return {
      ...contextForRetrievedDecision({
        run: { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, mode: run.mode, status: run.status },
        chainId: lastDecision.chainId,
        chainName: chainNameOrUnknown(lastDecision.chainId),
        decision: lastDecision,
      }),
      run: { id: run.id, mode: run.mode, startedAt: run.startedAt, status: run.status },
    };
  }
  const rejected = run.candidates.filter((c) => !c.approved);
  if (rejected.length > 0) {
    const candidate = rejected[0]!;
    return {
      ...contextForRetrievedCandidate({
        run: { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, mode: run.mode, status: run.status },
        chainId: candidate.pool.chainId,
        chainName: chainNameOrUnknown(candidate.pool.chainId),
        candidate,
      }),
      run: { id: run.id, mode: run.mode, startedAt: run.startedAt, status: run.status },
    };
  }
  if (run.candidates.length === 0 && run.errors.length === 0) {
    return contextForEmptyLatestRun();
  }
  return null;
}

export { chunkTelegramText };

/**
 * Render an AnalysisResult as plain text suitable for Telegram.
 * Sectioned but never with Markdown. Always wraps in chunkTelegramText.
 */
function formatAnalysisResult(
  result: import('../agent/analyst.js').AnalysisResult,
  source: string,
): string {
  const lines: string[] = [];
  lines.push(result.summary);
  if (result.strengths.length > 0) {
    lines.push('');
    lines.push('Strengths:');
    for (const s of result.strengths) lines.push(`  • ${s}`);
  }
  if (result.risks.length > 0) {
    lines.push('');
    lines.push('Risks:');
    for (const r of result.risks) lines.push(`  • ${r}`);
  }
  if (result.missingData.length > 0) {
    lines.push('');
    lines.push('Missing data:');
    for (const m of result.missingData) lines.push(`  • ${m}`);
  }
  if (result.anomalies.length > 0) {
    lines.push('');
    lines.push('Anomalies:');
    for (const a of result.anomalies) lines.push(`  • ${a}`);
  }
  lines.push('');
  lines.push(`Confidence: ${result.confidence} (${source})`);
  return lines.join('\n');
}
export { roleForExplanationContext };

// Re-export the chain-name helper for tests.
export { chainNameOrUnknown };

// Suppress unused-imports for helpers kept for symmetry.
void ({} as RetrievedDecision);
void ({} as RetrievedPositionEvent);
