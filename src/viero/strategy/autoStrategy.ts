import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LlmClient } from '../agent/llmClient.js';
import type { Controls } from '../storage/repositories.js';

export const DEFAULT_AUTO_GUARDRAILS = {
  minAutoSizeUsd: 5,
  maxAutoSizeUsd: 25,
  autoSizeMarketCapMinUsd: 1_000_000,
  autoSizeMarketCapMaxUsd: 100_000_000,
  maxWalletExposurePct: 5,
  minAutoRangePct: 30,
  maxAutoRangePct: 85,
  autoRangeVolatilityReferencePct: 5,
} as const;

export type StrategyResolution =
  | { ok: true; value: number; source: 'FIXED' | 'AUTO'; reason: string }
  | { ok: false; source: 'FIXED' | 'AUTO'; error: string };

export type AutoSizeContext = {
  walletEquityUsd: number | null;
  availableExecutionBalanceUsd: number | null;
  marketCapUsd: number | null;
  existingExposureUsd?: number | null;
  activePositions?: number | null;
  tokenRisk?: unknown;
  volatilityPct?: number | null;
  priceMovementPct?: number | null;
  liquidityUsd?: number | null;
  marketData?: unknown;
};

export type AutoRangeContext = {
  volatilityPct?: number | null;
  priceMovementPct?: number | null;
  poolFeeTier?: number | null;
  liquidityUsd?: number | null;
  marketActivity?: unknown;
  direction?: string | null;
};

export async function loadStrategyInstruction(kind: 'auto-size' | 'auto-range', root = process.cwd()): Promise<string> {
  const content = await readFile(resolve(root, 'config', 'strategies', `${kind}.md`), 'utf8');
  if (!content.trim()) throw new Error(`EMPTY_STRATEGY_INSTRUCTION: ${kind}`);
  return content;
}

function rejected(source: 'FIXED' | 'AUTO', error: string): StrategyResolution {
  console.error(`[viero.auto-strategy] ${source.toLowerCase()} rejected: ${error}`);
  return { ok: false, source, error };
}

export async function resolvePositionSize(input: {
  controls: Controls;
  context: AutoSizeContext;
  llm?: LlmClient;
  strategyRoot?: string;
}): Promise<StrategyResolution> {
  const { controls, context } = input;
  if (controls.sizeMode === 'FIXED') {
    const value = controls.fixedSizeUsd;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { ok: true, value, source: 'FIXED', reason: 'Operator-configured fixed USD size' }
      : rejected('FIXED', 'FIXED_SIZE_INVALID');
  }
  if (controls.sizeMode !== 'AUTO') return rejected('AUTO', 'SIZE_MODE_NOT_CONFIGURED');
  const min = controls.minAutoSizeUsd ?? DEFAULT_AUTO_GUARDRAILS.minAutoSizeUsd;
  const max = controls.maxAutoSizeUsd ?? DEFAULT_AUTO_GUARDRAILS.maxAutoSizeUsd;
  const marketCapMin = controls.autoSizeMarketCapMinUsd ?? DEFAULT_AUTO_GUARDRAILS.autoSizeMarketCapMinUsd;
  const marketCapMax = controls.autoSizeMarketCapMaxUsd ?? DEFAULT_AUTO_GUARDRAILS.autoSizeMarketCapMaxUsd;
  const exposurePct = controls.maxWalletExposurePct ?? DEFAULT_AUTO_GUARDRAILS.maxWalletExposurePct;
  if (!(Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min
    && Number.isFinite(marketCapMin) && Number.isFinite(marketCapMax) && marketCapMin > 0 && marketCapMax > marketCapMin
    && Number.isFinite(exposurePct) && exposurePct > 0 && exposurePct <= 100)) {
    return rejected('AUTO', 'AUTO_SIZE_GUARDRAILS_INVALID');
  }
  if (!(typeof context.walletEquityUsd === 'number' && Number.isFinite(context.walletEquityUsd) && context.walletEquityUsd >= 0)) return rejected('AUTO', 'WALLET_EQUITY_UNAVAILABLE');
  if (!(typeof context.availableExecutionBalanceUsd === 'number' && Number.isFinite(context.availableExecutionBalanceUsd) && context.availableExecutionBalanceUsd >= 0)) return rejected('AUTO', 'EXECUTION_BALANCE_UNAVAILABLE');
  if (!(typeof context.marketCapUsd === 'number' && Number.isFinite(context.marketCapUsd) && context.marketCapUsd > 0)) return rejected('AUTO', 'MARKET_CAP_UNAVAILABLE');
  const boundedMarketCap = Math.min(marketCapMax, Math.max(marketCapMin, context.marketCapUsd));
  const factor = Math.log(boundedMarketCap / marketCapMin) / Math.log(marketCapMax / marketCapMin);
  const marketCapSize = min + factor * (max - min);
  const existingExposure = context.existingExposureUsd ?? 0;
  if (!(Number.isFinite(existingExposure) && existingExposure >= 0)) return rejected('AUTO', 'EXISTING_EXPOSURE_INVALID');
  const exposureRemaining = Math.max(0, context.walletEquityUsd * exposurePct / 100 - existingExposure);
  const hardMax = Math.min(max, exposureRemaining, context.availableExecutionBalanceUsd);
  const value = Math.floor(Math.min(marketCapSize, hardMax) * 100) / 100;
  if (value < min) return rejected('AUTO', 'AUTO_SIZE_BELOW_MINIMUM');
  const reason = `Market cap $${context.marketCapUsd.toFixed(2)} mapped to $${marketCapSize.toFixed(2)}; capped to $${value.toFixed(2)}`;
  console.error(`[viero.auto-strategy] auto size accepted: $${value.toFixed(2)} market_cap=${context.marketCapUsd}`);
  return { ok: true, value, source: 'AUTO', reason };
}

export async function resolveRangeWidth(input: {
  controls: Controls;
  context: AutoRangeContext;
  llm?: LlmClient;
  strategyRoot?: string;
}): Promise<StrategyResolution> {
  const { controls, context } = input;
  if (controls.rangeMode === 'FIXED') {
    const value = controls.fixedRangePct;
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 99
      ? { ok: true, value, source: 'FIXED', reason: 'Operator-configured fixed single-side range' }
      : rejected('FIXED', 'FIXED_RANGE_INVALID');
  }
  if (controls.rangeMode !== 'AUTO') return rejected('AUTO', 'RANGE_MODE_NOT_CONFIGURED');
  const min = controls.minAutoRangePct ?? DEFAULT_AUTO_GUARDRAILS.minAutoRangePct;
  const max = controls.maxAutoRangePct ?? DEFAULT_AUTO_GUARDRAILS.maxAutoRangePct;
  const reference = controls.autoRangeVolatilityReferencePct ?? DEFAULT_AUTO_GUARDRAILS.autoRangeVolatilityReferencePct;
  if (!(Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max <= 99 && max >= min && Number.isFinite(reference) && reference > 0)) return rejected('AUTO', 'AUTO_RANGE_GUARDRAILS_INVALID');
  const volatility = context.volatilityPct;
  if (!(typeof volatility === 'number' && Number.isFinite(volatility) && volatility > 0)) return rejected('AUTO', 'VOLATILITY_UNAVAILABLE');
  const value = Math.min(max, Math.max(min, min + volatility / reference * (max - min)));
  const rounded = Math.round(value * 100) / 100;
  console.error(`[viero.auto-strategy] auto range accepted: ${rounded}% volatility=${volatility}%`);
  return { ok: true, value: rounded, source: 'AUTO', reason: `Volatility ${volatility.toFixed(2)}% mapped to a single-sided quote-only ${rounded.toFixed(2)}% range` };
}
