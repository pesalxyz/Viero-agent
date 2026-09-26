const MOD = 1n << 256n;
const Q128 = 1n << 128n;
const mod = (x: bigint) => ((x % MOD) + MOD) % MOD;

export function feeGrowthInsideV3(global: bigint, lowerOutside: bigint, upperOutside: bigint, currentTick: number, tickLower: number, tickUpper: number): bigint {
  const below = currentTick >= tickLower ? lowerOutside : mod(global - lowerOutside);
  const above = currentTick < tickUpper ? upperOutside : mod(global - upperOutside);
  return mod(global - below - above);
}

export function v3UnclaimedFees(args: { tokensOwed0: bigint; tokensOwed1: bigint; feeGrowthInside0Now: bigint; feeGrowthInside1Now: bigint; feeGrowthInside0Last: bigint; feeGrowthInside1Last: bigint; liquidity: bigint }) {
  if (args.liquidity <= 0n) return { fee0Raw: args.tokensOwed0, fee1Raw: args.tokensOwed1 };
  return {
    fee0Raw: args.tokensOwed0 + mod(args.feeGrowthInside0Now - args.feeGrowthInside0Last) * args.liquidity / Q128,
    fee1Raw: args.tokensOwed1 + mod(args.feeGrowthInside1Now - args.feeGrowthInside1Last) * args.liquidity / Q128,
  };
}
