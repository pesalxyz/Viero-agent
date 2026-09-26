/**
 * Read-only intent vocabulary for conversational Telegram messages.
 *
 * Every intent produced by the LLM is validated against
 * `ReadOnlyIntentSchema` before any retrieval or formatting runs.
 * The discriminated union contains NO execution intents. If the user
 * asks for an executable action (close, swap, deploy, rebalance,
 * claim, sell, etc.) the classifier returns `execution_request` and the
 * handler responds with an informational message — never a tool call.
 *
 * The intent vocabulary is intentionally small and explicit. Each
 * intent maps 1:1 to a small fixed block of code in
 * `ConversationalHandler.execute()`. The LLM cannot pick repository
 * method names, RPC methods, file paths, or shell commands.
 */
import { z } from 'zod';
import { chainIdSchema } from '../domain.js';

export const INTENT_PROMPT_VERSION = 'viero-intent-classifier-1';

const optionalLimit = z.number().int().positive().max(100).optional();
const optionalPoolHint = z.string().min(1).max(200).optional();
const optionalCandidateIdentity = z.string().min(1).max(400).optional();
const optionalPositionId = z.string().min(1).max(200).optional();
const optionalChainId = chainIdSchema.optional();

export const ReadOnlyIntentSchema = z.discriminatedUnion('type', [
  // ─── listings — deterministic formatting ───────────────────────
  z.object({
    type: z.literal('list_open_positions'),
    chainId: optionalChainId,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('list_closed_positions'),
    chainId: optionalChainId,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('latest_run'),
    chainId: optionalChainId,
  }),
  z.object({
    type: z.literal('latest_run_for_chain'),
    chainId: chainIdSchema,
  }),
  z.object({
    type: z.literal('recent_rejected_candidates'),
    chainId: optionalChainId,
    poolHint: optionalPoolHint,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('recent_approved_candidates'),
    chainId: optionalChainId,
    poolHint: optionalPoolHint,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('recent_errors'),
    chainId: optionalChainId,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('recent_close_events'),
    chainId: optionalChainId,
    limit: optionalLimit,
  }),
  z.object({
    type: z.literal('recent_activity'),
    chainId: optionalChainId,
    limit: optionalLimit,
  }),

  // ─── locate-by-id (may produce zero or multiple results) ────────
  z.object({
    type: z.literal('find_candidate'),
    candidateIdentity: optionalCandidateIdentity,
    poolHint: optionalPoolHint,
    chainId: optionalChainId,
  }),
  z.object({
    type: z.literal('find_position'),
    positionId: optionalPositionId,
    poolHint: optionalPoolHint,
  }),

  // ─── explanations — always run through DecisionExplainer ───────
  z.object({
    type: z.literal('explain_candidate'),
    candidateIdentity: optionalCandidateIdentity,
    poolHint: optionalPoolHint,
    chainId: optionalChainId,
  }),
  z.object({
    type: z.literal('explain_position'),
    positionId: optionalPositionId,
    poolHint: optionalPoolHint,
  }),
  z.object({
    type: z.literal('explain_latest_run'),
  }),

  // ─── execution requests — informational denial only ─────────────
  z.object({
    type: z.literal('execution_request'),
    action: z.string().min(1).max(100),
  }),

  // ─── assisted analysis — advisory only ─────────────────────────
  z.object({
    type: z.literal('analyze_candidate'),
    candidateIdentity: optionalCandidateIdentity,
    poolHint: optionalPoolHint,
    chainId: optionalChainId,
  }),
  z.object({
    type: z.literal('analyze_position'),
    positionId: optionalPositionId,
    poolHint: optionalPoolHint,
  }),

  // ─── catch-alls ─────────────────────────────────────────────────
  z.object({
    type: z.literal('help'),
  }),
  z.object({
    type: z.literal('unknown'),
    originalMessage: z.string().min(1).max(2000).optional(),
  }),
]);

export type ReadOnlyIntent = z.infer<typeof ReadOnlyIntentSchema>;

/**
 * Minimal conversation reference state. Resolves references like
 * "that pool", "the previous one", "this position". Stores identifiers
 * only — never model-generated explanations. All operational facts
 * are still pulled from Viero history.
 */
export type ConversationRefs = {
  chatId: number;
  lastRunId?: string;
  lastCandidateIdentity?: string;
  lastPositionId?: string;
  lastChainId?: z.infer<typeof chainIdSchema>;
  updatedAt: number;
};

export type IntentClassifierOptions = {
  /** Timeout for the LLM intent call. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Maximum size of the user message sent to the LLM. Defaults to 500. */
  maxMessageLength?: number;
};

// ─── Deterministic classifier (fast-path + LLM-disabled fallback) ──

const CHAIN_KEYWORDS: ReadonlyArray<{ id: z.infer<typeof chainIdSchema>; pattern: RegExp }> = [
  { id: 4663, pattern: /\brobinhood\b|\brh chain\b|\bchain\s*4663\b|\b4663\b/i },
  { id: 56, pattern: /\bbsc\b|\bbnb\b|\bbinance\b|\bchain\s*56\b|\b56\b/i },
  { id: 8453, pattern: /\bbase\b|\bchain\s*8453\b|\b8453\b/i },
  { id: 5042, pattern: /\barc\b|\bchain\s*5042\b|\b5042\b/i },
];

function detectChain(message: string): z.infer<typeof chainIdSchema> | undefined {
  for (const { id, pattern } of CHAIN_KEYWORDS) {
    if (pattern.test(message)) return id;
  }
  return undefined;
}

function detectLimit(message: string): number | undefined {
  const m = message.match(/\b(?:top|last|recent|first)\s+(\d{1,3})\b/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 100);
  }
  return undefined;
}

function detectExecutionRequest(message: string): string | undefined {
  const lower = message.toLowerCase();
  // Questions starting with "why" are explanation requests, not actions.
  if (/^\s*why\b/i.test(lower)) return undefined;
  const patterns: Array<[RegExp, string]> = [
    [/\b(close|exit|withdraw)\b.{0,40}\b(position|lp|nft)\b/i, 'close_position'],
    [/\b(open|deploy|add\s+liquidity|lp\s+into|invest)\b.{0,40}\b(position|pool)\b/i, 'deploy_position'],
    [/\b(swap|convert|sell|exchange)\b/i, 'swap'],
    [/\brebalance\b/i, 'rebalance'],
    [/\bclaim\b.{0,20}\bfees?\b/i, 'claim_fees'],
    [/\bemergency\s*-?\s*close\b/i, 'emergency_close'],
  ];
  for (const [re, action] of patterns) {
    if (re.test(lower)) return action;
  }
  return undefined;
}

function detectHelpIntent(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return /^(help|what\s+can\s+you\s+do|commands|how\s+do\s+i|\?+)$/i.test(lower);
}

function detectPositionId(message: string): string | undefined {
  const m = message.match(/\bpaper-([a-zA-Z0-9_-]{1,64})\b/);
  return m ? `paper-${m[1]}` : undefined;
}

/**
 * Detect a candidate identity embedded in the message text. A candidate
 * identity in Viero has the form `<chainId>:<protocol>:<dex>:<address>`
 * (v3) or `<chainId>:<protocol>:<dex>:<poolId>` (v4). When present, this
 * resolves a natural-language reference to a specific record.
 */
function detectCandidateIdentity(message: string): string | undefined {
  // v3 — chainId:protocol:dex:0x[40 hex chars]
  const v3 = message.match(/\b(\d+):v3:(uniswap|pancakeswap):0x[0-9a-fA-F]{40}\b/);
  if (v3) return v3[0];
  // v4 — chainId:v4:uniswap:0x[64 hex chars]
  const v4 = message.match(/\b(\d+):v4:uniswap:0x[0-9a-fA-F]{64}\b/);
  if (v4) return v4[0];
  return undefined;
}

/**
 * Detect a generic pool hint — typically a 0x… address (40 hex chars)
 * that the user references as "this pool" or "that address". Distinct
 * from the strict candidate identity: this is a softer match used by
 * the analyst when the user references a pool without giving its full
 * identity tuple.
 */
function detectPoolHint(message: string): string | undefined {
  const m = message.match(/0x[0-9a-fA-F]{40}\b/);
  return m ? m[0].toLowerCase() : undefined;
}

/**
 * Deterministic classifier. Returns a ReadOnlyIntent if the message
 * matches a known pattern; otherwise returns null so the caller can
 * fall back to the LLM classifier.
 *
 * Pure function. No I/O, no LLM call.
 */
export function classifyIntentDeterministic(message: string, refs?: ConversationRefs): ReadOnlyIntent | undefined {
  const text = message.trim();
  if (!text) return { type: 'unknown' };

  if (detectHelpIntent(text)) return { type: 'help' };

  const action = detectExecutionRequest(text);
  if (action) return { type: 'execution_request', action };

  const chainId = detectChain(text);
  const limit = detectLimit(text);
  const positionId = detectPositionId(text);
  const candidateIdentity = detectCandidateIdentity(text);
  const poolHint = detectPoolHint(text);

  const lower = text.toLowerCase();

  // ── Why-* intents (highest precedence among conversational intents) ─
  // "Why" questions are always explanation requests, never actions or
  // listing requests, regardless of which words follow.
  const startsWithWhy = /^\s*why\b/i.test(lower);

  if (startsWithWhy && /\b(reject(s|ed)?|decline(s|d)?|skip(ped)?|fail(s|ed|ure)?|refuse(s|d)?)\b/i.test(lower)) {
    return {
      type: 'explain_candidate',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(candidateIdentity ? { candidateIdentity } : refs?.lastCandidateIdentity ? { candidateIdentity: refs.lastCandidateIdentity } : {}),
    };
  }

  if (startsWithWhy && /\b(position|lp|pool)\b/i.test(lower)) {
    return {
      type: 'explain_position',
      ...(positionId ? { positionId } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
      ...(refs?.lastPositionId && !positionId ? { positionId: refs.lastPositionId } : {}),
    };
  }

  // ── Open / closed positions (factual listing) ──────────────────
  if (/\b(open|current|active)\b.*\bpositions?\b/i.test(lower) || /\bwhat\s+(positions|are)\b/i.test(lower) && /\bopen\b/i.test(lower)) {
    return {
      type: 'list_open_positions',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (/\bclosed\s+positions?\b/i.test(lower) || /\bpositions?\s+(closed|that\s+closed)\b/i.test(lower) || /\brecently\s+closed\b/i.test(lower)) {
    return {
      type: 'list_closed_positions',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  // ── Listing intents ────────────────────────────────────────────
  if (/\b(rejected|declined|skipped)\b/i.test(lower) && /\b(candidates?|pools?)\b/i.test(lower)) {
    return {
      type: 'recent_rejected_candidates',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (/\b(approved|passed)\b/i.test(lower) && /\b(candidates?|pools?)\b/i.test(lower)) {
    return {
      type: 'recent_approved_candidates',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (/\b(close|closed)\b/i.test(lower) && /\bevents?\b/i.test(lower)) {
    return {
      type: 'recent_close_events',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (/\b(error|errors|fail(s|ed|ures?)?|fail[- ]closed?|issues|problems?)\b/i.test(lower)) {
    return {
      type: 'recent_errors',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  // ── Latest run ─────────────────────────────────────────────────
  if (/\b(latest|last|most\s+recent)\s+(run|cycle|screening)\b/i.test(lower) ||
      /\bwhat\s+happened\b/i.test(lower) ||
      /\b(explain|summarise|summarize|describe)\b.{0,30}\b(last|latest|recent)\s+(run|cycle|screening)\b/i.test(lower)) {
    return {
      type: 'explain_latest_run',
      ...(chainId !== undefined ? { chainId } : {}),
    };
  }

  // ── Recent activity ────────────────────────────────────────────
  if (/\b(recent|latest)\s+(activity|events|history|actions|status)\b/i.test(lower)) {
    return {
      type: 'recent_activity',
      ...(chainId !== undefined ? { chainId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  // Generic chain + activity/history verb fallback. Catches
  // "show me bsc activity", "tell me about arc history", etc.
  if (chainId !== undefined && /\b(activity|history|summary|overview|recap|status)\b/i.test(lower)) {
    return {
      type: 'recent_activity',
      chainId,
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  // ── Find by id ──────────────────────────────────────────────────
  if (positionId && /\b(position|paper)\b/i.test(lower)) {
    return { type: 'find_position', positionId, ...(chainId !== undefined ? { chainId } : {}) };
  }

  // ── Assisted analysis ──────────────────────────────────────────
  if (/\b(analyze|analyse|review|examine|assess)\b/i.test(lower) &&
      (/\b(candidate|pool|pools|candidates)\b/i.test(lower) ||
       candidateIdentity !== undefined)) {
    return {
      type: 'analyze_candidate',
      ...(candidateIdentity ? { candidateIdentity } : refs?.lastCandidateIdentity ? { candidateIdentity: refs.lastCandidateIdentity } : {}),
      ...(poolHint ? { poolHint } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
    };
  }
  if (/\b(analyze|analyse|review|examine)\b/i.test(lower) &&
      /\b(position|paper)\b/i.test(lower)) {
    return {
      type: 'analyze_position',
      ...(positionId ? { positionId } : refs?.lastPositionId ? { positionId: refs.lastPositionId } : {}),
      ...(poolHint ? { poolHint } : {}),
    };
  }

  // ── No deterministic match ─────────────────────────────────────
  return undefined;
}

// ─── LLM classifier (used for ambiguous messages) ────────────────

export const INTENT_SYSTEM_PROMPT = `You are a strict intent classifier for Viero's read-only Telegram bot.

Your only job: convert the user's natural-language question into ONE JSON object that matches the schema below. Output JSON only — no prose, no markdown, no explanation.

Hard rules:
1. Output ONLY valid JSON, nothing else. No comments, no trailing commas, no markdown fences.
2. Pick exactly one intent type from the enum. If the user's question is about something Viero doesn't record, use "unknown".
3. NEVER produce an intent that performs an action. The intent vocabulary is read-only.
4. If the user asks for an executable action (close, deploy, swap, rebalance, claim, sell, etc.), output: {"type":"execution_request","action":"<short_action_name>"}.
5. If the user message mentions a chain by name (Base, BSC, Robinhood, Arc), set chainId to the integer 4663/56/8453/5042 respectively. Otherwise omit chainId.
6. If the user mentions a top-N (e.g. "top 3 rejected"), set limit to that integer. Otherwise omit limit.
7. If the user references "that pool" / "this position" / "the previous one", use the conversation_refs field to resolve to identifiers when possible. Otherwise leave the relevant id field absent.
8. Use "explain_*" intents when the user asks "why". Use "list_*" / "recent_*" intents when the user asks to see data.
9. Use "unknown" when the request cannot be mapped to any intent.

Schema (exact field names, no extras):
{type:"list_open_positions"|"list_closed_positions"|"latest_run"|"latest_run_for_chain"|"recent_rejected_candidates"|"recent_approved_candidates"|"recent_errors"|"recent_close_events"|"recent_activity"|"find_candidate"|"find_position"|"explain_candidate"|"explain_position"|"explain_latest_run"|"execution_request"|"analyze_candidate"|"analyze_position"|"help"|"unknown", chainId?:4663|56|8453|5042, limit?:number, poolHint?:string, positionId?:string, candidateIdentity?:string, action?:string, originalMessage?:string}

Output a single JSON object only.`;

export type IntentClassifierResult =
  | { kind: 'parsed'; intent: ReadOnlyIntent }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string };

/**
 * Attempt to classify the user message using the LLM. Returns either a
 * validated `ReadOnlyIntent` (parsed), a structured `unknown` (LLM
 * responded but couldn't classify), or a structured error (LLM
 * unavailable, timeout, malformed JSON).
 *
 * Never throws. Safe to call without try/catch.
 */
export async function classifyIntentWithLlm(
  message: string,
  llmClient: { chat(req: any): Promise<{ content: string | null; toolCalls?: unknown[]; finishReason?: string }>; isEnabled(): boolean },
  refs?: ConversationRefs,
  options: IntentClassifierOptions = {},
): Promise<IntentClassifierResult> {
  if (!llmClient.isEnabled()) return { kind: 'error', message: 'llm_disabled' };
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxMessageLength = options.maxMessageLength ?? 500;
  const truncated = message.length > maxMessageLength ? message.slice(0, maxMessageLength) : message;
  const systemPrompt = `${INTENT_SYSTEM_PROMPT}\n\nPROMPT_VERSION: ${INTENT_PROMPT_VERSION}`;
  const refsBlock = refs ? `\n\nconversation_refs:\n${JSON.stringify(refs, null, 2)}` : '';
  const userPrompt = `User message: ${JSON.stringify(truncated)}${refsBlock}`;

  let response: { content: string | null };
  try {
    response = await withTimeout(
      llmClient.chat({
        role: 'GENERAL',
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.0,
        maxTokens: 200,
      }),
      timeoutMs,
    );
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
  const content = (response.content ?? '').trim();
  if (!content) return { kind: 'error', message: 'empty_content' };

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { kind: 'error', message: 'invalid_json' };
  }
  const validated = ReadOnlyIntentSchema.safeParse(parsed);
  if (!validated.success) {
    return { kind: 'error', message: 'schema_validation_failed' };
  }
  return { kind: 'parsed', intent: validated.data };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`INTENT_TIMEOUT_${ms}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]!.slice(0, 240) : String(error).slice(0, 240);
}
