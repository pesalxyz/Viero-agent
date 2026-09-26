import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isAddress } from 'viem';
import { ROBINHOOD_STOCK_SEED } from '../config/blockedStockSeeds.js';

export type BlockedToken = { symbol?: string; reason: string; addedAt: number; addedBy: string };
export type BlockedState = { tokens: Record<string, BlockedToken>; removedSeed?: Record<string, true> };
export class BlockedTokenStore {
  constructor(readonly path = process.env.VIERO_BLOCKED_TOKENS_PATH ?? '/var/lib/viero/blocked-tokens.json') {}
  async load(): Promise<BlockedState> {
    let state: BlockedState = { tokens: {}, removedSeed: {} };
    try { const parsed = JSON.parse(await readFile(this.path, 'utf8')); if (parsed?.tokens && typeof parsed.tokens === 'object') state = { tokens: parsed.tokens, removedSeed: parsed.removedSeed ?? {} }; } catch { /* seed recovery below */ }
    const now = Date.now() / 1000;
    let changed = false;
    for (const seed of ROBINHOOD_STOCK_SEED) { const key = `4663:${seed.address}`; if (!state.removedSeed?.[key] && !state.tokens[key]) { state.tokens[key] = { symbol: seed.symbol, reason: 'MANUAL_BLOCK', addedAt: now, addedBy: 'seed' }; changed = true; } }
    if (changed || !state.tokens) await this.save(state);
    return state;
  }
  async save(state: BlockedState): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const tmp = `${this.path}.tmp-${process.pid}`; await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(tmp, this.path); }
  static key(chainId: number, address: string): string { if (!isAddress(address)) throw new Error('INVALID_ADDRESS'); return `${chainId}:${address.toLowerCase()}`; }
}
