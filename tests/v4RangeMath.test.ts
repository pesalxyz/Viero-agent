import test from 'node:test';
import assert from 'node:assert/strict';
import { tickAtHumanQuotePrice } from '../src/viero/screening/math.js';
import { orderFixedRangeTicks } from '../src/viero/execution/planner.js';

test('FIXED USDG-token0 range orders boundary ticks for PositionManager', () => {
  assert.deepEqual(orderFixedRangeTicks(381045, 374115), { tickLower: 374115, tickUpper: 381045 });
  assert.ok(374040 < 374115);
});

test('Agrippa USDG-per-meme bounds remain decimal-correct in both token orientations', () => {
  const price = 0.00005403;
  const expected = { lower: price * 0.5, upper: price * 0.995 };
  for (const quoteIsToken0 of [false, true]) {
    const d0 = quoteIsToken0 ? 6 : 18;
    const d1 = quoteIsToken0 ? 18 : 6;
    const lower = tickAtHumanQuotePrice({ quotePerMeme: expected.lower, quoteIsToken0, decimals0: d0, decimals1: d1, tickSpacing: 60, round: quoteIsToken0 ? 'up' : 'down' });
    const upper = tickAtHumanQuotePrice({ quotePerMeme: expected.upper, quoteIsToken0, decimals0: d0, decimals1: d1, tickSpacing: 60, round: quoteIsToken0 ? 'up' : 'down' });
    assert.ok(quoteIsToken0 ? upper < lower : lower < upper);
    assert.equal(Math.abs(lower % 60), 0);
    assert.equal(Math.abs(upper % 60), 0);
  }
});
