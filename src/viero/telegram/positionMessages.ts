export type PositionMessageInput = {
  symbol: string; tokenAddress?: string; poolAddress?: string; protocol: 'v3' | 'v4'; tokenId: bigint | string;
  lowerPrice?: number | null; upperPrice?: number | null; currentPrice?: number | null; baseSymbol?: string; quoteSymbol?: string;
  quoteAmount?: number | null; depositUsd?: number | null; txHash?: string | null; positionManager?: string;
  blockExplorerTxBase?: string; positionBase?: string;
};
export type CloseMessageInput = PositionMessageInput & { reason: string; entryPrice?: number | null; exitPrice?: number | null; currentValueUsd?: number | null; pnlPct?: number | null; pnlUsd?: number | null; normalization?: { amount?: string; symbol?: string; txHash?: string } | { pending: true } };
export type ActivePositionInput = PositionMessageInput & { openedAt: number; now: number; valueAmount?: string | null; valueUsd?: number | null; feeAmount?: string | null; feeUsd?: number | null; feeDetails?: string | null; pnlPct?: number | null; inRange?: boolean; trailingState?: string | null; oorState?: string | null };

export function shortAddress(value?: string | null): string {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 8)}…` : value ?? 'unavailable';
}
function num(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'unavailable' : value.toLocaleString('en-US', { maximumSignificantDigits: 6 }); }
function pnlNum(value: number): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return normalized.toFixed(2);
}
function link(base: string | undefined, value: string | bigint): string { return base ? `${base.replace(/\/$/, '')}/${value}` : 'unavailable'; }
function rangeText(lower: number | null | undefined, upper: number | null | undefined): string {
  if (lower == null || upper == null || !Number.isFinite(lower) || !Number.isFinite(upper)) return 'unavailable';
  return `${num(Math.min(lower, upper))}–${num(Math.max(lower, upper))}`;
}

export function formatOpenPositionMessage(input: PositionMessageInput): string {
  const id = input.tokenId.toString(), protocol = input.protocol.toUpperCase();
  const range = rangeText(input.lowerPrice, input.upperPrice);
  const pair = `${input.baseSymbol ?? 'base'}/${input.quoteSymbol ?? 'quote'}`;
  const tx = link(input.blockExplorerTxBase, input.txHash ?? '');
  const position = link(input.positionBase, id);
  return [`✅ ${input.symbol} #${id} [${protocol}]`, `Pool token: ${shortAddress(input.tokenAddress ?? input.poolAddress)}`, `Range: ${range} (now ${num(input.currentPrice)}) ${pair}`, `Deposited: ~${num(input.quoteAmount)} ${input.quoteSymbol ?? 'quote'} ($${num(input.depositUsd)})`, `Mint:`, tx, `Position:`, position].join('\n');
}

export function formatClosePositionMessage(input: CloseMessageInput): string {
  const id = input.tokenId.toString(), protocol = input.protocol.toUpperCase();
  const range = rangeText(input.lowerPrice, input.upperPrice);
  const pnl = input.pnlPct == null ? 'unavailable' : `${input.pnlPct >= 0 ? '+' : ''}${num(input.pnlPct)}% (~$${num(input.pnlUsd)})`;
  const lines = [`✅ Closed ${input.symbol} #${id} [${protocol}]`, `Reason: ${input.reason}`, `Range: ${range}`, `Entry: ${num(input.entryPrice)}`, `Exit: ${num(input.exitPrice)} ${input.baseSymbol ?? 'base'}/${input.quoteSymbol ?? 'quote'}`, `Deposited: ~${num(input.quoteAmount)} ${input.quoteSymbol ?? 'quote'} ($${num(input.depositUsd)})`, `Closed value: ~$${num(input.currentValueUsd)}`, `PnL: ${pnl}`, `Close:`, link(input.blockExplorerTxBase, input.txHash ?? ''), `Position:`, link(input.positionBase, id)];
  if (input.normalization && 'pending' in input.normalization) lines.push('⚠️ Post-close normalization pending');
  else if (input.normalization) { lines.push(`Normalized to: ${input.normalization.amount ?? 'unavailable'} ${input.normalization.symbol ?? input.quoteSymbol ?? 'quote'}`, 'Swap:', link(input.blockExplorerTxBase, input.normalization.txHash ?? '')); }
  return lines.join('\n');
}

export function formatActivePositionCard(input: ActivePositionInput): string {
  const age = Math.max(0, Math.floor((input.now - input.openedAt) / 60));
  const pnl = input.pnlPct == null ? 'unavailable' : `${input.pnlPct >= 0 ? '+' : ''}${pnlNum(input.pnlPct)}%`;
  const range = rangeText(input.lowerPrice, input.upperPrice);
  const rangeStatus = input.inRange === undefined ? '⚪ UNKNOWN' : input.inRange ? '🟢 IN' : '🔴 OUT';
  const value = input.valueUsd != null && Number.isFinite(input.valueUsd) ? `$${num(input.valueUsd)}` : input.valueAmount ?? 'unavailable';
  const unclaimed = input.feeUsd != null && Number.isFinite(input.feeUsd)
    ? `$${num(input.feeUsd)}`
    : input.feeAmount == null
    ? 'unavailable'
    : input.feeAmount;
  const lines = [`${input.symbol} #${input.tokenId.toString()} [${input.protocol}] | Age: ${age}m`, `Val: ${value} | PnL: ${pnl} | ${rangeStatus}`, `Range: ${range} (now ${num(input.currentPrice)}) ${input.baseSymbol ?? 'base'}/${input.quoteSymbol ?? 'quote'}`, `Unclaimed: ${unclaimed}`];
  if (input.feeDetails) lines.push(`Fees: ${input.feeDetails}`);
  if (input.trailingState) lines.push(`Trailing: ${input.trailingState}`);
  if (input.oorState) lines.push(`OOR: ${input.oorState}`);
  const positionLink = input.positionBase ? link(input.positionBase, input.tokenId) : null;
  if (positionLink) lines.push(positionLink);
  return lines.join('\n');
}

export function activePositionButtons(input: Pick<PositionMessageInput, 'symbol' | 'protocol' | 'tokenId'>) {
  const id = input.tokenId.toString(), label = `${input.symbol} #${id}`;
  return { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: `position:refresh:${id}` }], [{ text: `💰 Claim ${label}`, callback_data: `position:claim:${id}` }, { text: `🗑 Close ${label} [${input.protocol}]`, callback_data: `position:close:${id}` }], [{ text: `🔄 Close & AutoSwap ${label}`, callback_data: `position:autoswap:${id}` }]] };
}
