import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { LlmClient } from '../agent/llmClient.js';
import type { Controls } from '../storage/repositories.js';

export const DEFAULT_AUTO_GUARDRAILS = {
  minAutoSizeUsd: 5,
  maxAutoSizeUsd: 25,
  maxWalletExposurePct: 5,
  minAutoRangePct: 5,
  maxAutoRangePct: 30,
} as const;

export type StrategyResolution =
  | { ok: true; value: number; source: 'FIXED' | 'AUTO'; reason: string }
  | { ok: false; source: 'FIXED' | 'AUTO'; error: string };

export type AutoSizeContext = {
  walletEquityUsd: number | null;
  availableExecutionBalanceUsd: number | null;
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

const sizeProposalSchema = z.object({ sizeUsd: z.number().finite(), reason: z.string().min(1).max(500) }).strict();
const rangeProposalSchema = z.object({ rangePct: z.number().finite(), reason: z.string().min(1).max(500) }).strict();

export async function loadStrategyInstruction(kind: 'auto-size' | 'auto-range', root = process.cwd()): Promise<string> {
  const content = await readFile(resolve(root, 'config', 'strategies', `${kind}.md`), 'utf8');
  if (!content.trim()) throw new Error(`EMPTY_STRATEGY_INSTRUCTION: ${kind}`);
  return content;
}

function rejected(source: 'FIXED' | 'AUTO', error: string): StrategyResolution {
  console.error(`[viero.auto-strategy] ${source.toLowerCase()} rejected: ${error}`);
  return { ok: false, source, error };
}

function strictJson(content: string | null): unknown {
  if (!content?.trim()) throw new Error('LLM_EMPTY_RESPONSE');
  return JSON.parse(content);
}

export async function resolvePositionSize(input: {
  controls: Controls;
  context: AutoSizeContext;
  llm?: LlmClient;
  strategyRoot?: string;
}): Promise<StrategyResolution> {
  const { controls, context, llm } = input;
  if (controls.sizeMode === 'FIXED') {
    const value = controls.fixedSizeUsd;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { ok: true, value, source: 'FIXED', reason: 'Operator-configured fixed USD size' }
      : rejected('FIXED', 'FIXED_SIZE_INVALID');
  }
  if (controls.sizeMode !== 'AUTO') return rejected('AUTO', 'SIZE_MODE_NOT_CONFIGURED');
  if (!llm?.isEnabled()) return rejected('AUTO', 'LLM_NOT_CONFIGURED');

  const min = controls.minAutoSizeUsd ?? DEFAULT_AUTO_GUARDRAILS.minAutoSizeUsd;
  const max = controls.maxAutoSizeUsd ?? DEFAULT_AUTO_GUARDRAILS.maxAutoSizeUsd;
  const exposurePct = controls.maxWalletExposurePct ?? DEFAULT_AUTO_GUARDRAILS.maxWalletExposurePct;
  if (!(Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min && Number.isFinite(exposurePct) && exposurePct > 0 && exposurePct <= 100)) {
    return rejected('AUTO', 'AUTO_SIZE_GUARDRAILS_INVALID');
  }
  if (!(typeof context.walletEquityUsd === 'number' && Number.isFinite(context.walletEquityUsd) && context.walletEquityUsd >= 0)) return rejected('AUTO', 'WALLET_EQUITY_UNAVAILABLE');
  if (!(typeof context.availableExecutionBalanceUsd === 'number' && Number.isFinite(context.availableExecutionBalanceUsd) && context.availableExecutionBalanceUsd >= 0)) return rejected('AUTO', 'EXECUTION_BALANCE_UNAVAILABLE');

  try {
    const instruction = await loadStrategyInstruction('auto-size', input.strategyRoot);
    const facts = {
      walletEquityUsd: context.walletEquityUsd,
      availableExecutionBalanceUsd: context.availableExecutionBalanceUsd,
      existingExposureUsd: context.existingExposureUsd ?? null,
      activePositions: context.activePositions ?? null,
      tokenRisk: context.tokenRisk ?? null,
      volatilityPct: context.volatilityPct ?? null,
      priceMovementPct: context.priceMovementPct ?? null,
      liquidityUsd: context.liquidityUsd ?? null,
      marketData: context.marketData ?? null,
      limits: { minAutoSizeUsd: min, maxAutoSizeUsd: max, maxWalletExposurePct: exposurePct },
    };
    const response = await llm.chat({ role: 'GENERAL', systemPrompt: instruction, messages: [{ role: 'user', content: JSON.stringify(facts) }], temperature: 0, maxTokens: 200 });
    const proposal = sizeProposalSchema.parse(strictJson(response.content));
    const walletCap = context.walletEquityUsd * exposurePct / 100;
    const hardMax = Math.min(max, walletCap, context.availableExecutionBalanceUsd);
    if (proposal.sizeUsd < min) return rejected('AUTO', 'AUTO_SIZE_BELOW_MINIMUM');
    if (proposal.sizeUsd > hardMax) return rejected('AUTO', 'AUTO_SIZE_EXCEEDS_HARD_LIMIT');
    console.error(`[viero.auto-strategy] auto size accepted: $${proposal.sizeUsd}`);
    return { ok: true, value: proposal.sizeUsd, source: 'AUTO', reason: proposal.reason };
  } catch (error) {
    return rejected('AUTO', `AUTO_SIZE_LLM_FAILED: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
  }
}

export async function resolveRangeWidth(input: {
  controls: Controls;
  context: AutoRangeContext;
  llm?: LlmClient;
  strategyRoot?: string;
}): Promise<StrategyResolution> {
  const { controls, context, llm } = input;
  if (controls.rangeMode === 'FIXED') {
    const value = controls.fixedRangePct;
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 99
      ? { ok: true, value, source: 'FIXED', reason: 'Operator-configured fixed single-side range' }
      : rejected('FIXED', 'FIXED_RANGE_INVALID');
  }
  if (controls.rangeMode !== 'AUTO') return rejected('AUTO', 'RANGE_MODE_NOT_CONFIGURED');
  if (!llm?.isEnabled()) return rejected('AUTO', 'LLM_NOT_CONFIGURED');

  const min = controls.minAutoRangePct ?? DEFAULT_AUTO_GUARDRAILS.minAutoRangePct;
  const max = controls.maxAutoRangePct ?? DEFAULT_AUTO_GUARDRAILS.maxAutoRangePct;
  if (!(Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max <= 99 && max >= min)) return rejected('AUTO', 'AUTO_RANGE_GUARDRAILS_INVALID');
  try {
    const instruction = await loadStrategyInstruction('auto-range', input.strategyRoot);
    const facts = {
      volatilityPct: context.volatilityPct ?? null,
      priceMovementPct: context.priceMovementPct ?? null,
      poolFeeTier: context.poolFeeTier ?? null,
      liquidityUsd: context.liquidityUsd ?? null,
      marketActivity: context.marketActivity ?? null,
      direction: context.direction ?? null,
      limits: { absoluteMinPct: 1, absoluteMaxPct: 99, minAutoRangePct: min, maxAutoRangePct: max },
    };
    const response = await llm.chat({ role: 'GENERAL', systemPrompt: instruction, messages: [{ role: 'user', content: JSON.stringify(facts) }], temperature: 0, maxTokens: 200 });
    const proposal = rangeProposalSchema.parse(strictJson(response.content));
    if (proposal.rangePct < 1 || proposal.rangePct > 99) return rejected('AUTO', 'AUTO_RANGE_OUTSIDE_ABSOLUTE_LIMITS');
    if (proposal.rangePct < min || proposal.rangePct > max) return rejected('AUTO', 'AUTO_RANGE_OUTSIDE_CONFIGURED_LIMITS');
    console.error(`[viero.auto-strategy] auto range accepted: ${proposal.rangePct}%`);
    return { ok: true, value: proposal.rangePct, source: 'AUTO', reason: proposal.reason };
  } catch (error) {
    return rejected('AUTO', `AUTO_RANGE_LLM_FAILED: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
  }
}
