import { z } from 'zod';
import { CHAIN_IDS, chainIdSchema, type ChainId } from '../domain.js';

export const POLICY_VERSION = 'paper-policy-1';
export const policySchema = z.object({
  enabledChains: z.array(chainIdSchema).nonempty().default([...CHAIN_IDS]),
  windowMinutes: z.number().int().min(1).max(1440).default(30),
  screeningIntervalSeconds: z.number().int().min(60).default(300),
  managementIntervalSeconds: z.number().int().min(30).default(300),
  maximumDataAgeSeconds: z.number().int().positive().default(180),
  maximumPriceDivergencePct: z.number().finite().min(0).max(100).default(3),
  maximumPositivePriceDivergencePct: z.number().finite().min(0).max(100).default(2.5),
  maximumNegativePriceDivergencePct: z.number().finite().min(0).max(100).default(10),
  maximumIndexerLagBlocks: z.number().int().nonnegative().default(5),
  maximumExposureUsd: z.number().finite().positive().default(500),
  maximumDailyLossUsd: z.number().finite().positive().default(50),
  maximumPositionUsd: z.number().finite().positive().default(25),
  minimumPoolAgeSeconds: z.number().int().nonnegative().default(600),
  minimumVolumeUsd: z.number().finite().nonnegative().default(10000),
  minimumUniqueTraders: z.number().int().positive().default(20),
  maximumHolderPct: z.number().finite().min(0).max(100).default(40),
  maximumSellTaxBps: z.number().int().nonnegative().default(0),
  minimumExpectedNetFeesUsd: z.number().finite().nonnegative().default(0),
  maximumSlippageBps: z.number().int().min(0).max(500).default(50),
  maximumRangeWidthTicks: z.number().int().min(2).max(1774544).default(10000),
  minimumClaimUsd: z.number().finite().nonnegative().default(2),
  claimCostMultiplier: z.number().finite().min(1).default(5),
  outOfRangeGraceSeconds: z.number().int().nonnegative().default(900),
  trailingTakeProfitEnabled: z.boolean().default(true),
  trailingTriggerPct: z.number().finite().nonnegative().default(3),
  trailingDropPct: z.number().finite().positive().default(1.5),
  farAboveRangeEnabled: z.boolean().default(true),
  farAboveRangePct: z.number().finite().nonnegative().default(10),
  farAboveRangeBlacklistGracePct: z.number().finite().negative().default(-3),
  outOfRangeTimeoutEnabled: z.boolean().default(true),
  outOfRangeTimeoutSeconds: z.number().int().nonnegative().default(1800),
  stopLossPct: z.number().finite().min(0).max(100).default(15),
  trailingDrawdownPct: z.number().finite().min(0).max(100).default(10),
  pauseAfterFailures: z.number().int().positive().default(3),
  maximumOpenPositions: z.number().int().min(1).max(20).default(3),
  poolCooldownSeconds: z.number().int().nonnegative().default(7 * 86400),
  noSupportedPoolCooldownSeconds: z.number().int().nonnegative().default(3600),
  insufficientQuoteBalanceCooldownSeconds: z.number().int().nonnegative().default(1800),
  lossBlacklistSeconds: z.number().int().nonnegative().default(30 * 86400),
  minimumPositionAgeSeconds: z.number().int().nonnegative().default(1800),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export const DEFAULT_POLICY = policySchema.parse({});
export const CHAIN_LIMITS: Record<ChainId, { maximumExposureUsd: number; minimumTvlUsd: number; minimumDepthUsd: number; minimumDepthDownUsd?: number; minimumDepthUpUsd?: number }> = {
  4663: { maximumExposureUsd: 100, minimumTvlUsd: 50000, minimumDepthUsd: 100, minimumDepthDownUsd: 50, minimumDepthUpUsd: 50 },
  56: { maximumExposureUsd: 150, minimumTvlUsd: 75000, minimumDepthUsd: 20000 },
  8453: { maximumExposureUsd: 150, minimumTvlUsd: 75000, minimumDepthUsd: 20000 },
  5042: { maximumExposureUsd: 100, minimumTvlUsd: 50000, minimumDepthUsd: 10000 },
};
