import test from 'node:test';
import assert from 'node:assert/strict';
import { activePositionButtons, formatActivePositionCard, formatClosePositionMessage, formatOpenPositionMessage, shortAddress } from '../src/viero/telegram/positionMessages.js';

const TEST_TOKEN = `0x${['5fc5360D0400a0Fd4f2a', 'f552ADD042D716F1d168'].join('')}`;
const base = { symbol: 'Agrippa', tokenAddress: TEST_TOKEN, protocol: 'v4' as const, tokenId: 7n, lowerPrice: 0.0000285, upperPrice: 0.0000567, currentPrice: 0.000057, baseSymbol: 'Agrippa', quoteSymbol: 'USDG', quoteAmount: 5, depositUsd: 5, txHash: '0x' + 'a'.repeat(64), blockExplorerTxBase: 'https://robinhoodchain.blockscout.com/tx', positionBase: 'https://app.uniswap.org/positions/v4/robinhood' };
test('formats confirmed V4 open with links and compact address', () => { const text = formatOpenPositionMessage(base); assert.match(text, /✅ Agrippa #7 \[V4\]/); assert.match(text, /Pool token: 0x5fc536…/); assert.match(text, /blockscout.com\/tx\/0xaaaa/); assert.match(text, /positions\/v4\/robinhood\/7/); });
for (const reason of ['TAKE_PROFIT', 'STOP_LOSS']) test(`formats close ${reason}`, () => { const text = formatClosePositionMessage({ ...base, reason, entryPrice: 0.00005, exitPrice: 0.00006, currentValueUsd: 5.5, pnlPct: 10, pnlUsd: 0.5 }); assert.match(text, new RegExp(`Reason: ${reason}`)); assert.match(text, /PnL: \+10%/); });
test('omits unavailable values without fabrication and reports normalization states', () => { const pending = formatClosePositionMessage({ ...base, reason: 'MANUAL', lowerPrice: null, upperPrice: null, pnlPct: null, normalization: { pending: true } }); assert.match(pending, /unavailable/); assert.match(pending, /normalization pending/); const done = formatClosePositionMessage({ ...base, reason: 'MANUAL', normalization: { amount: '5', symbol: 'USDG', txHash: '0x' + 'b'.repeat(64) } }); assert.match(done, /Normalized to: 5 USDG/); assert.ok(!done.includes('private')); });
test('shortAddress never leaks full address', () => { assert.equal(shortAddress(base.tokenAddress), '0x5fc536…'); });
test('active card shows IN/OUT state and deterministic controls', () => { const text = formatActivePositionCard({ ...base, openedAt: 1000, now: 3520, valueAmount: '5 USDG', valueUsd: 5, feeAmount: '0.01 USDG', feeUsd: 0.01, pnlPct: 0.2, inRange: true }); assert.match(text, /Age: 42m/); assert.match(text, /🟢 IN/); assert.match(text, /positions\/v4\/robinhood\/7/); const buttons = activePositionButtons(base); assert.equal(buttons.inline_keyboard[0]![0]!.callback_data, 'position:refresh:7'); assert.equal(buttons.inline_keyboard[2]![0]!.callback_data, 'position:autoswap:7'); });
test('active card rounds PnL to two decimal places', () => {
  const text = formatActivePositionCard({ ...base, pnlPct: -1.64236, openedAt: 1000, now: 1000, inRange: false, positionBase: undefined });
  assert.match(text, /PnL: -1\.64%/);
  assert.doesNotMatch(text, /PnL: -1\.64236%/);
});
test('position range display is normalized regardless of boundary order', () => { const text = formatActivePositionCard({ ...base, lowerPrice: 0.05509, upperPrice: 0.02769, openedAt: 1000, now: 1000 }); assert.match(text, /Range: 0\.02769–0\.05509/); });
test('active card keeps known USD value when quote amount is unavailable', () => {
  const text = formatActivePositionCard({ ...base, tokenId: 1296861n, valueAmount: null, valueUsd: 9.94256, feeAmount: null, feeUsd: null, pnlPct: 0.416131, openedAt: 1000, now: 2680, inRange: true, positionBase: undefined });
  assert.match(text, /SPCX|Agrippa #1296861 \[v4\]/);
  assert.match(text, /Val: \$9\.94256/);
  assert.match(text, /Unclaimed: unavailable/);
  assert.doesNotMatch(text, /\$unavailable/);
  assert.doesNotMatch(text, /\nunavailable$/);
  assert.match(text, /Range:/);
  assert.match(text, /PnL: \+0\.42%/);
});
test('optional trailing and OOR state are omitted when unavailable', () => {
  const text = formatActivePositionCard({ ...base, valueUsd: 1, feeAmount: null, feeUsd: null, openedAt: 1000, now: 1000, inRange: true, trailingState: null, oorState: null, positionBase: undefined });
  assert.doesNotMatch(text, /Trailing:/);
  assert.doesNotMatch(text, /OOR:/);
  assert.doesNotMatch(text, /\nunavailable$/);
});
test('active V4 card renders exact fee-inclusive details separately from principal value', () => {
  const text = formatActivePositionCard({ ...base, protocol: 'v4', tokenId: 3223710n, valueUsd: 9.760762, feeUsd: 0.742098, feeDetails: '0.223523 USDG + 153.250611061292164634 JOLLY', pnlPct: 7.35367, openedAt: 1000, now: 1000, inRange: false });
  assert.match(text, /Val: \$9\.76076/);
  assert.match(text, /PnL: \+7\.35%/);
  assert.match(text, /Unclaimed: \$0\.742098/);
  assert.match(text, /Fees: 0\.223523 USDG \+ 153\.250611061292164634 JOLLY/);
});
