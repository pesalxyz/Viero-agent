/** Canonical PnL semantic: percentage points, not a fraction. */
export function pnlPctFromValues(currentValueUsd: number | null | undefined, depositUsd: number | null | undefined): number | null {
  if (currentValueUsd == null || depositUsd == null || !Number.isFinite(currentValueUsd) || !Number.isFinite(depositUsd) || depositUsd <= 0) return null;
  return (currentValueUsd / depositUsd - 1) * 100;
}

/**
 * A single-sided position whose only asset is the configured primary stable
 * has no market-price exposure. Its live principal is therefore the
 * authoritative cost basis (the persisted pre-refresh transfer amount can
 * differ from the amount represented by the minted liquidity).
 */
export function isPrimaryStableQuoteOnly(input: {
  token0Address: string;
  token1Address: string;
  amount0: bigint;
  amount1: bigint;
  primaryStable: string;
}): boolean {
  const token0 = input.token0Address.toLowerCase();
  const token1 = input.token1Address.toLowerCase();
  const stable = input.primaryStable.toLowerCase();
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
  if (input.principalValueUsd != null && input.token0Address && input.token1Address
    && input.amount0 != null && input.amount1 != null && input.primaryStable
    && isPrimaryStableQuoteOnly({ token0Address: input.token0Address, token1Address: input.token1Address,
      amount0: input.amount0, amount1: input.amount1, primaryStable: input.primaryStable })) {
    return input.principalValueUsd;
  }
  return input.persistedDepositUsd ?? null;
}
