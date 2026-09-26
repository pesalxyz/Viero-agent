import test from 'node:test';
import assert from 'node:assert/strict';
import { v4FeeGrowthDelta } from '../src/viero/management/v4Fees.js';
import { feeGrowthInsideV3, v3UnclaimedFees } from '../src/viero/management/v3Fees.js';
test('V4 fee growth uses Q128 accounting for both currencies', () => {
  const r = v4FeeGrowthDelta(1n<<128n, 3n<<128n, 0n, 1n<<128n, 10n);
  assert.deepEqual(r, { fee0Raw: 10n, fee1Raw: 20n });
});
test('V4 fee growth handles uint256 wraparound', () => {
  const max = 1n<<256n;
  assert.equal(v4FeeGrowthDelta(2n, max-3n, 0n, max-5n, 1n<<128n).fee1Raw, 2n);
});
test('V4 fee growth handles zero liquidity and zero delta', () => {
  assert.deepEqual(v4FeeGrowthDelta(4n, 4n, 4n, 4n, 0n), { fee0Raw: 0n, fee1Raw: 0n });
});
test('V3 fee growth inside handles all tick positions and owed amounts', () => {
  const g = 1000n, lo = 100n, hi = 200n;
  assert.equal(feeGrowthInsideV3(g, 200n, 100n, -2, 0, 10), 100n);
  assert.equal(feeGrowthInsideV3(g, 200n, 100n, 5, 0, 10), 700n);
  assert.equal(feeGrowthInsideV3(g, 200n, 100n, 20, 0, 10), (1n << 256n) - 100n);
  const fees = v3UnclaimedFees({ tokensOwed0: 3n, tokensOwed1: 4n, feeGrowthInside0Now: (1n << 128n) + 5n, feeGrowthInside1Now: 2n << 128n, feeGrowthInside0Last: 5n, feeGrowthInside1Last: 0n, liquidity: 10n });
  assert.deepEqual(fees, { fee0Raw: 13n, fee1Raw: 24n });
});
