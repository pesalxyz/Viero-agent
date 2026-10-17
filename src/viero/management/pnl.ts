/** Canonical PnL semantic: percentage points, not a fraction. */
export function pnlPctFromValues(currentValueUsd: number | null | undefined, depositUsd: number | null | undefined): number | null {
  if (currentValueUsd == null || depositUsd == null || !Number.isFinite(currentValueUsd) || !Number.isFinite(depositUsd) || depositUsd <= 0) return null;
  return (currentValueUsd / depositUsd - 1) * 100;
}

/** Legacy shape helper retained for persisted/test compatibility. It is no
 * longer used to select a PnL denominator. */
export function isPrimaryStableQuoteOnly(input: { token0Address: string; token1Address: string; amount0: bigint; amount1: bigint; primaryStable: string }): boolean {
  const token0 = input.token0Address.toLowerCase(), token1 = input.token1Address.toLowerCase(), stable = input.primaryStable.toLowerCase();
  if (token0 === stable) return input.amount1 === 0n && input.amount0 > 0n;
  if (token1 === stable) return input.amount0 === 0n && input.amount1 > 0n;
  return false;
}

export function effectivePnlDepositUsd(input: {
  persistedDepositUsd: number | null | undefined;
  entryPrincipalUsd?: number | null;
  principalValueUsd: number | null | undefined;
  token0Address?: string;
  token1Address?: string;
  amount0?: bigint;
  amount1?: bigint;
  primaryStable?: string;
}): number | null {
  if (input.entryPrincipalUsd != null && Number.isFinite(input.entryPrincipalUsd) && input.entryPrincipalUsd > 0) {
    return input.entryPrincipalUsd;
  }
  // PnL is intentionally unavailable until a receipt-derived entry basis is
  // persisted. Planned budget and live principal are not interchangeable.
  return null;
}
