export type V4FeeResult = { fee0Raw: bigint; fee1Raw: bigint };
export function v4FeeGrowthDelta(current0: bigint, current1: bigint, last0: bigint, last1: bigint, liquidity: bigint): V4FeeResult {
  if (liquidity <= 0n) return { fee0Raw: 0n, fee1Raw: 0n };
  const mod = 1n << 256n, q128 = 1n << 128n;
  const delta = (current: bigint, last: bigint) => ((current - last) % mod + mod) % mod;
  return { fee0Raw: delta(current0, last0) * liquidity / q128, fee1Raw: delta(current1, last1) * liquidity / q128 };
}
