import { z } from 'zod';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

export const CHAIN_IDS = [4663, 56, 8453, 5042] as const;
export type ChainId = typeof CHAIN_IDS[number];
export const chainIdSchema = z.union([z.literal(4663), z.literal(56), z.literal(8453), z.literal(5042)]);
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as Address);
export const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
export const uintSchema = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform(BigInt).refine(v => v >= 0n);
const nonnegative = z.number().finite().nonnegative();
export const poolKeySchema = z.object({
  currency0: addressSchema, currency1: addressSchema,
  fee: z.number().int().min(0).max(0xffffff),
  tickSpacing: z.number().int().min(1).max(32767), hooks: addressSchema,
}).strict().refine(k => BigInt(k.currency0) < BigInt(k.currency1), 'Currencies must be strictly ordered');
export const poolSchema = z.discriminatedUnion('protocol', [
  z.object({ chainId: chainIdSchema, protocol: z.literal('v3'), dex: z.enum(['uniswap', 'pancakeswap']), poolAddress: addressSchema }).strict(),
  z.object({ chainId: chainIdSchema, protocol: z.literal('v4'), dex: z.literal('uniswap'), poolId: hex32Schema, poolKey: poolKeySchema }).strict(),
]).refine(p => p.dex !== 'pancakeswap' || p.chainId === 56, 'PancakeSwap is enabled only on BSC');
export type PoolRef = z.infer<typeof poolSchema>;
export function poolId(key: z.infer<typeof poolKeySchema>): Hex {
  const k = poolKeySchema.parse(key);
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}
export function poolIdentity(pool: PoolRef): string {
  const p = poolSchema.parse(pool);
  return `${p.chainId}:${p.protocol}:${p.dex}:${p.protocol === 'v3' ? p.poolAddress : p.poolId}`;
}
export function tokenIdentity(chainId: ChainId, token: Address): string {
  return `${chainIdSchema.parse(chainId)}:${addressSchema.parse(token)}`;
}
export function sanitizeMetadata(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/[^a-zA-Z0-9 ._()+/-]/g, '').trim().slice(0, 64);
}
export const tokenSchema = z.object({
  chainId: chainIdSchema, address: addressSchema, decimals: z.number().int().min(0).max(36),
  symbol: z.string().transform(sanitizeMetadata),
});
export type Token = z.infer<typeof tokenSchema>;
export const priceSchema = z.object({
  chainId: chainIdSchema, token: addressSchema, usd: z.number().finite().positive(),
  source: z.string().min(1), observedAt: nonnegative, fetchedAt: nonnegative,
});
export type Price = z.infer<typeof priceSchema>;
export const stateSchema = z.object({
  pool: poolSchema, token0: tokenSchema, token1: tokenSchema, blockNumber: uintSchema,
  blockHash: hex32Schema, observedAt: nonnegative, fetchedAt: nonnegative,
  sqrtPriceX96: uintSchema, tick: z.number().int().min(-887272).max(887272),
  tickSpacing: z.number().int().positive(), liquidity: uintSchema,
  fee: z.number().int().min(0).max(1_000_000), dynamicFee: z.boolean(),
  protocolFee: z.number().int().min(0).max(0xffffffff),
  verified: z.boolean(), verification: z.array(z.string()),
});
export type PoolState = z.infer<typeof stateSchema>;
export const swapSchema = z.object({
  pool: poolSchema, blockNumber: uintSchema, transactionHash: hex32Schema, logIndex: z.number().int().nonnegative(),
  timestamp: nonnegative, trader: addressSchema,
  amount0: z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform(BigInt),
  amount1: z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform(BigInt),
  price1Per0: z.number().finite().positive(), volumeUsd: nonnegative,
  grossFeeUsd: nonnegative, lpFeeUsd: nonnegative.nullable(),
});
export type Swap = z.infer<typeof swapSchema>;
export const riskSchema = z.object({
  chainId: chainIdSchema, token: addressSchema, observedAt: nonnegative, source: z.string().min(1),
  honeypot: z.boolean().nullable(), criticalAdmin: z.boolean().nullable(),
  sellTaxBps: nonnegative.nullable(), top10HolderPct: nonnegative.max(100).nullable(),
  buySimulation: z.boolean().nullable(), sellSimulation: z.boolean().nullable(),
  smartMoneyScore: nonnegative.max(1).nullable(),
});
export type Risk = z.infer<typeof riskSchema>;
export const tickSchema = z.object({ index: z.number().int(), liquidityNet: z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform(BigInt) });
export type InitializedTick = z.infer<typeof tickSchema>;
export const observationSchema = z.object({
  state: stateSchema, windowStart: nonnegative, windowEnd: nonnegative,
  source: z.string().min(1), indexedBlock: uintSchema, complete: z.boolean(),
  valuation: z.enum(['historical-usd', 'window-end-reference']),
  swaps: z.array(swapSchema), prices: z.array(priceSchema), risks: z.array(riskSchema),
  tvlUsd: nonnegative.nullable(), poolCreatedAt: nonnegative.nullable(),
  ticks: z.array(tickSchema), ticksComplete: z.boolean(),
  positionsCreated: nonnegative.nullable(), uniqueLps: nonnegative.nullable(),
  liquidityAddedUsd: nonnegative.nullable(), liquidityRemovedUsd: nonnegative.nullable(),
  estimatedLifecycleCostUsd: nonnegative.nullable(),
  issues: z.array(z.string()).default([]),
});
export type Observation = z.infer<typeof observationSchema>;
export type Mode = 'live-readonly' | 'live-execution' | 'replay';
export function json(value: unknown, pretty = false): string {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, pretty ? 2 : undefined);
}
export function errorMessage(error: unknown): string {
  // Provider errors may contain authenticated URLs; never persist the raw request.
  const detail = error && typeof error === 'object' && 'details' in error ? String(error.details) : '';
  const suffix = /rate.?limit|too many requests|429/i.test(detail) ? ' (provider rate limit)' : '';
  const message = error instanceof z.ZodError
    ? `Validation failed${error.issues[0]?.path.length ? ` at ${error.issues[0].path.join('.')}` : ''}: ${error.issues[0]?.message ?? 'invalid value'}`
    : (error instanceof Error ? error.message : String(error)).split('\n')[0]!;
  return (message + suffix)
    .replace(/https?:\/\/\S+/g, '[provider-url]').replace(/0x[0-9a-fA-F]{64}/g, '[hash]').slice(0, 240);
}
