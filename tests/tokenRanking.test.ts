import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPersistedTokens } from '../src/viero/workers/screeningWorker.js';

const base = { chainId: 4663 as const, symbol: 'GME', tokenAddress: '0x0000000000000000000000000000000000000001' as const, verdict: 'PASS' as const };
test('reconstructs token score from persisted GMGN fields', () => {
  const ranked = rankPersistedTokens([{ ...base, volume1h: 312000, liquidityUsd: 100000, hotSearchRank: 2 }]);
  assert.equal(ranked[0]!.score, 3.12);
});
test('missing or zero persisted liquidity is not rankable', () => {
  assert.equal(rankPersistedTokens([{ ...base, volume1h: 10, liquidityUsd: null }]).length, 0);
  assert.equal(rankPersistedTokens([{ ...base, volume1h: 10, liquidityUsd: 0 }]).length, 0);
});
test('ranking is deterministic by score, hot-search rank, then address', () => {
  const out = rankPersistedTokens([
    { ...base, tokenAddress: '0x0000000000000000000000000000000000000002', volume1h: 100, liquidityUsd: 100, hotSearchRank: 2 },
    { ...base, tokenAddress: '0x0000000000000000000000000000000000000003', volume1h: 100, liquidityUsd: 100, hotSearchRank: 1 },
  ]);
  assert.equal(out[0]!.tokenAddress, '0x0000000000000000000000000000000000000003');
});
