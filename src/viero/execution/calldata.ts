import { concatHex, encodeAbiParameters, maxUint128, type Address, type Hex } from 'viem';
import { type PositionPlan } from './planner.js';

const poolKeyParameter = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] } as const;
export const V4_ACTIONS = { INCREASE_LIQUIDITY: 0x00, DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d, TAKE_PAIR: 0x11 } as const;

function pair(plan: PositionPlan) {
  const first = plan.depositAssets[0], second = plan.depositAssets[1];
  if (!first || !second) throw new Error('POSITION_REQUIRES_TWO_ASSETS');
  return [first, second] as const;
}
export function v3MintArgs(plan: PositionPlan, recipient: Address) {
  if (plan.pool.protocol !== 'v3') throw new Error('V3_PLAN_REQUIRED');
  const [a0, a1] = pair(plan), minimum = (amount: bigint) => amount * BigInt(10_000 - plan.slippageBps) / 10_000n;
  return [{ token0: a0.token, token1: a1.token, fee: plan.poolFee,
    tickLower: plan.tickLower, tickUpper: plan.tickUpper, amount0Desired: a0.amount, amount1Desired: a1.amount,
    amount0Min: minimum(a0.amount), amount1Min: minimum(a1.amount), recipient, deadline: BigInt(Math.floor(plan.deadline)) }] as const;
}
export function v4MintData(plan: PositionPlan, recipient: Address): Hex {
  if (plan.pool.protocol !== 'v4') throw new Error('V4_PLAN_REQUIRED');
  const [a0, a1] = pair(plan), key = plan.pool.poolKey;
  const actions = concatHex([`0x${V4_ACTIONS.MINT_POSITION.toString(16).padStart(2, '0')}`, `0x${V4_ACTIONS.SETTLE_PAIR.toString(16).padStart(2, '0')}`]);
  const params = [
    encodeAbiParameters([poolKeyParameter, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
      [{ currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, plan.tickLower, plan.tickUpper, plan.liquidity, a0.amount, a1.amount, recipient, '0x']),
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, key.currency1]),
  ];
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
}
export function v4DecreaseData(plan: PositionPlan, tokenId: bigint, liquidity: bigint, minimum0: bigint, minimum1: bigint, recipient: Address): Hex {
  if (plan.pool.protocol !== 'v4') throw new Error('V4_PLAN_REQUIRED');
  const key = plan.pool.poolKey;
  const actions = concatHex([`0x${V4_ACTIONS.DECREASE_LIQUIDITY.toString(16).padStart(2, '0')}`, `0x${V4_ACTIONS.TAKE_PAIR.toString(16).padStart(2, '0')}`]);
  const params = [
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], [tokenId, liquidity, minimum0, minimum1, '0x']),
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [key.currency0, key.currency1, recipient]),
  ];
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
}
export function v4CollectData(plan: PositionPlan, tokenId: bigint, recipient: Address) {
  return v4DecreaseData(plan, tokenId, 0n, 0n, 0n, recipient);
}
export const UINT128_MAX = maxUint128;
