import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TokenMemoryEntry = { symbol?: string; firstSeenAt: number; lastSeenAt: number; candidateAttempts: number; successfulOpens: number; failedAttempts: number; lastAttemptAt?: number; lastAttemptResult?: string; lastPoolId?: string; closedPositions: number; wins: number; losses: number; averagePnlPct: number; lastCloseAt?: number; lastCloseReason?: string; consecutiveOutOfRangeCloses: number; consecutiveStopLossCloses: number; cooldownUntil?: number; cooldownReason?: string };
export type TokenMemory = Record<string, TokenMemoryEntry>;
export class TokenMemoryStore {
  constructor(readonly path = process.env.VIERO_TOKEN_MEMORY_PATH ?? '/var/lib/viero/token-memory.json') {}
  async load(): Promise<TokenMemory> { try { return JSON.parse(await readFile(this.path, 'utf8')) as TokenMemory; } catch { return {}; } }
  async save(value: TokenMemory): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const tmp = `${this.path}.tmp-${process.pid}`; await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, this.path); }
}
