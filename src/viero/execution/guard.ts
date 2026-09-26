import { CHAIN_IDS, chainIdSchema, type ChainId } from '../domain.js';

export class ChainSupervisor {
  private failures = new Map<ChainId, number>();
  private paused = new Map<ChainId, string>();
  globalReason: string | null = null;
  constructor(private failureLimit = 3) {}
  success(id: ChainId) { chainIdSchema.parse(id); this.failures.set(id, 0); }
  failure(id: ChainId, reason: string) {
    chainIdSchema.parse(id);
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    if (n >= this.failureLimit) this.paused.set(id, reason);
  }
  pause(id: ChainId, reason: string) { chainIdSchema.parse(id); this.paused.set(id, reason); }
  resume(id: ChainId) { chainIdSchema.parse(id); this.paused.delete(id); this.failures.set(id, 0); }
  stop(reason: string) { this.globalReason = reason; }
  assertActive(id: ChainId) {
    chainIdSchema.parse(id);
    const reason = this.globalReason ?? this.paused.get(id);
    if (reason) throw new Error(`CHAIN_PAUSED: ${reason}`);
  }
  snapshot() { return { globalReason: this.globalReason, chains: CHAIN_IDS.map(chainId => ({ chainId, failures: this.failures.get(chainId) ?? 0, paused: this.paused.get(chainId) ?? null })) }; }
}
export function executeTransaction(): never {
  throw new Error('READ_ONLY_RELEASE: transaction signing and broadcasting are disabled');
}
