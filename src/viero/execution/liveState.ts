import { z } from 'zod';
import { addressSchema, chainIdSchema, hex32Schema, poolSchema, type ChainId, type PoolRef } from '../domain.js';
import { type PositionPlan } from './planner.js';

export type LivePosition = {
  id: string; chainId: ChainId; pool: PoolRef; tokenId: bigint; positionManager: `0x${string}`;
  plan: PositionPlan; openedAt: number; updatedAt: number; status: 'open' | 'closing' | 'closed';
  /** Actual principal value observed immediately after mint, when available. */
  entryPrincipalUsd?: number | null;
  entryTxHash: `0x${string}`; closeTxHash?: `0x${string}`; lastAction: 'open' | 'hold' | 'claim' | 'rebalance' | 'close' | 'emergency-close' | 'pause';
  outOfRangeSince: number | null; claimed0: bigint; claimed1: bigint; realizedPnlUsd: number | null;
  peakPnlPct: number | null; trailingTakeProfitArmed: boolean;
  normalization: { status: 'not-required' | 'pending' | 'complete' | 'failed' | 'blocked'; targetToken: `0x${string}` | null; attempts: number; lastError: string | null };
  closeReason: string | null;
};
export type ExecutionTransaction = {
  id: string; chainId: ChainId; positionId?: string; action: 'approve' | 'swap' | 'mint' | 'claim' | 'decrease' | 'burn';
  hash: `0x${string}`; at: number; status: 'confirmed' | 'failed'; blockNumber?: bigint; detail: string;
};
export type StrategyLesson = { at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string };
export type ManagementNotification = { id: string; kind: 'opened' | 'closing' | 'closed' | 'close_failed' | 'normalization'; positionId: string; symbol?: string; targetSymbol?: string; protocol: 'v3' | 'v4'; tokenId: string; reason?: string; pnlPct?: number | null; valueUsd?: number | null; feeUsd?: number | null; txHash?: string; status?: string; error?: string; at: number; delivered?: boolean };
export type StrategyState = {
  version: 1; positions: LivePosition[]; transactions: ExecutionTransaction[]; cooldowns: Record<string, number>;
  blacklist: Record<string, { until: number; reason: string }>; lessons: StrategyLesson[]; dailyRealizedLossUsd: Record<string, number>; managementNotifications: ManagementNotification[];
};
export const emptyStrategyState = (): StrategyState => ({ version: 1, positions: [], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {}, managementNotifications: [] });

const bigintSchema = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform(BigInt);
export const positionPlanSchema = z.object({
  chainId: chainIdSchema, pool: poolSchema, mode: z.enum(['paper', 'live']), createdAt: z.number(), deadline: z.number(),
  sourceBlock: bigintSchema, sourceBlockHash: hex32Schema, tickLower: z.number().int(), tickUpper: z.number().int(), liquidity: bigintSchema, poolFee: z.number().int(),
  depositAssets: z.array(z.object({ token: addressSchema, amount: bigintSchema })),
  expectedTransfers: z.array(z.object({ token: addressSchema, direction: z.literal('out'), maximumAmount: bigintSchema })),
  slippageBps: z.number().int(), maximumGasCostUsd: z.number(), depositUsd: z.number(),
  positionSizeUsd: z.number().finite().positive().optional(), rangePct: z.number().finite().min(1).max(99).optional(),
  takeProfitPct: z.number().finite().positive().optional(), stopLossPct: z.number().finite().negative().optional(),
  sizeMode: z.enum(['AUTO', 'FIXED']).optional(), rangeMode: z.enum(['AUTO', 'FIXED']).optional(),
}).transform(plan => ({ ...plan,
  positionSizeUsd: plan.positionSizeUsd ?? plan.depositUsd,
  rangePct: plan.rangePct ?? 1,
  takeProfitPct: plan.takeProfitPct ?? 1_000_000_000,
  stopLossPct: plan.stopLossPct ?? -15,
  sizeMode: plan.sizeMode ?? 'FIXED' as const,
  rangeMode: plan.rangeMode ?? 'FIXED' as const,
}));
const normalizationSchema = z.object({ status: z.enum(['not-required', 'pending', 'complete', 'failed', 'blocked']),
  targetToken: addressSchema.nullable(), attempts: z.number().int().nonnegative(), lastError: z.string().nullable() }).strict();
const positionSchema = z.object({
  id: z.string(), chainId: chainIdSchema, pool: poolSchema, tokenId: bigintSchema, positionManager: addressSchema, plan: positionPlanSchema,
  openedAt: z.number(), updatedAt: z.number(), status: z.enum(['open', 'closing', 'closed']), entryPrincipalUsd: z.number().finite().positive().nullable().optional(), entryTxHash: hex32Schema, closeTxHash: hex32Schema.optional(),
  lastAction: z.enum(['open', 'hold', 'claim', 'rebalance', 'close', 'emergency-close', 'pause']), outOfRangeSince: z.number().nullable(),
  peakPnlPct: z.number().nullable().optional(), trailingTakeProfitArmed: z.boolean().optional(),
  claimed0: bigintSchema, claimed1: bigintSchema, realizedPnlUsd: z.number().nullable(),
  normalization: normalizationSchema.optional(),
  closeReason: z.string().nullable().optional(),
}).transform(position => ({ ...position, entryPrincipalUsd: position.entryPrincipalUsd ?? null, peakPnlPct: position.peakPnlPct ?? null, trailingTakeProfitArmed: position.trailingTakeProfitArmed ?? false, normalization: position.normalization ?? {
  status: 'not-required' as const, targetToken: null, attempts: 0, lastError: null,
}, closeReason: position.closeReason ?? null }));
export const executionTransactionSchema = z.object({ id: z.string(), chainId: chainIdSchema, positionId: z.string().optional(),
  action: z.enum(['approve', 'swap', 'mint', 'claim', 'decrease', 'burn']), hash: hex32Schema, at: z.number(),
  status: z.enum(['confirmed', 'failed']), blockNumber: bigintSchema.optional(), detail: z.string() });
const lessonSchema = z.object({ at: z.number(), chainId: chainIdSchema, poolIdentity: z.string(), outcome: z.enum(['win', 'loss', 'risk-exit']), pnlUsd: z.number().nullable(), reason: z.string() });
const managementNotificationSchema = z.object({ id: z.string(), kind: z.enum(['opened', 'closing', 'closed', 'close_failed', 'normalization']), positionId: z.string(), symbol: z.string().optional(), targetSymbol: z.string().optional(), protocol: z.enum(['v3', 'v4']), tokenId: z.string(), reason: z.string().optional(), pnlPct: z.number().nullable().optional(), valueUsd: z.number().nullable().optional(), feeUsd: z.number().nullable().optional(), txHash: hex32Schema.optional(), status: z.string().optional(), error: z.string().optional(), at: z.number(), delivered: z.boolean().optional() }).strict();
export const strategyStateSchema = z.object({ version: z.literal(1), positions: z.array(positionSchema), transactions: z.array(executionTransactionSchema),
  cooldowns: z.record(z.number()), blacklist: z.record(z.object({ until: z.number(), reason: z.string() })), lessons: z.array(lessonSchema),
  dailyRealizedLossUsd: z.record(z.number()), managementNotifications: z.array(managementNotificationSchema).default([]) }).strict();
export const livePositionSchema = positionSchema;
