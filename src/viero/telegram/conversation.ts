/**
 * Per-chat conversation reference store.
 *
 * Stores ONLY identifiers (runId, candidate identity, position id,
 * chainId). Never stores model-generated explanations or facts — all
 * operational facts are pulled from Viero history at query time.
 *
 * In-memory only. Bounded by chat count (entries are pruned after the
 * TTL expires). No Redis, no database — Viero's deployment is single
 * process and this state is short-lived.
 */
import type { ConversationRefs } from './intent.js';

export const DEFAULT_CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class ConversationStore {
  private readonly map = new Map<number, ConversationRefs>();

  constructor(private readonly ttlMs: number = DEFAULT_CONVERSATION_TTL_MS) {}

  get(chatId: number): ConversationRefs | undefined {
    const entry = this.map.get(chatId);
    if (!entry) return undefined;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.map.delete(chatId);
      return undefined;
    }
    return entry;
  }

  set(chatId: number, patch: Partial<Omit<ConversationRefs, 'chatId' | 'updatedAt'>>): ConversationRefs {
    const existing = this.map.get(chatId);
    const next: ConversationRefs = {
      chatId,
      updatedAt: Date.now(),
      ...(existing ?? {}),
      ...patch,
    };
    this.map.set(chatId, next);
    return next;
  }

  clear(chatId: number): void {
    this.map.delete(chatId);
  }

  size(): number {
    return this.map.size;
  }
}
