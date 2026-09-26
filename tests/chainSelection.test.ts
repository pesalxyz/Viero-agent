import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedRuntimeChains } from '../src/viero/runtime/chainSelection.js';

test('live screening follows the persisted BNB-only selection', () => {
  assert.deepEqual(selectedRuntimeChains([4663, 56, 8453, 5042], [56]), [56]);
});

test('live screening follows a changed Robinhood selection without restart', () => {
  const serviceChains = [4663, 56, 8453, 5042] as const;
  assert.deepEqual(selectedRuntimeChains(serviceChains, [4663]), [4663]);
});

test('an empty operator selection runs no chain', () => {
  assert.deepEqual(selectedRuntimeChains([4663, 56], []), []);
  assert.deepEqual(selectedRuntimeChains([4663, 56], undefined), []);
});
