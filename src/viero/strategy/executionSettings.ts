import type { ChainId } from '../domain.js';
import type { LlmClient } from '../agent/llmClient.js';
import type { Controls, StrategyMode } from '../storage/repositories.js';
import { resolvePositionSize, resolveRangeWidth, type AutoRangeContext, type AutoSizeContext } from './autoStrategy.js';

export type ResolvedExecutionSettings = {
  chainId: ChainId;
  positionSizeUsd: number;
  rangePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  sizeMode: StrategyMode;
  rangeMode: StrategyMode;
  quoteAsset: 'NATIVE' | 'STABLE';
};

export function fixedSizeForQuote(controls: Controls, chainId: ChainId, quoteAsset: 'NATIVE' | 'STABLE'): number | null {
  const configured = controls.fixedSizeByChainQuote?.[chainId]?.[quoteAsset];
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  // Backward-compatible migration: the old single value belongs only to the
  // quote preference it was saved with. Never reuse 10 USDG as 10 ETH.
  const legacyQuote = controls.fixedQuoteByChain?.[chainId] ?? 'STABLE';
  return legacyQuote === quoteAsset && typeof controls.fixedSizeUsd === 'number'
    && Number.isFinite(controls.fixedSizeUsd) && controls.fixedSizeUsd > 0 ? controls.fixedSizeUsd : null;
}

export function assertCandidateExecutionAllowed(controls: Controls, chainId: ChainId): void {
  if ((controls.botState ?? 'STOPPED') !== 'RUNNING') throw new Error('BOT_STOPPED_NEW_ENTRIES_DISABLED');
  if (controls.globalPaused) throw new Error('GLOBAL_PAUSED_NEW_ENTRIES_DISABLED');
  if (controls.pausedChains.includes(chainId)) throw new Error(`CHAIN_PAUSED_NEW_ENTRIES_DISABLED: ${chainId}`);
  if (!(controls.enabledChains ?? []).includes(chainId)) throw new Error(`CHAIN_NOT_ENABLED_FOR_ENTRY: ${chainId}`);
  if (!(typeof controls.takeProfitPct === 'number' && Number.isFinite(controls.takeProfitPct) && controls.takeProfitPct > 0)) throw new Error('TAKE_PROFIT_NOT_CONFIGURED');
  if (!(typeof controls.stopLossPct === 'number' && Number.isFinite(controls.stopLossPct) && controls.stopLossPct < 0)) throw new Error('STOP_LOSS_NOT_CONFIGURED');
}

export function assertLiveExecutionEnabled(mode: 'live-execution' | 'live-readonly', env: NodeJS.ProcessEnv = process.env): void {
  if (mode === 'live-execution' && env.VIERO_EXECUTION_ENABLED !== 'true') throw new Error('LIVE_EXECUTION_NOT_ENABLED');
}

export async function resolveExecutionSettings(input: {
  controls: Controls;
  chainId: ChainId;
  llm?: LlmClient;
  sizeContext: AutoSizeContext;
  rangeContext: AutoRangeContext;
  quoteAsset?: 'NATIVE' | 'STABLE';
  strategyRoot?: string;
}): Promise<ResolvedExecutionSettings> {
  assertCandidateExecutionAllowed(input.controls, input.chainId);
  const quoteAsset = input.quoteAsset ?? input.controls.fixedQuoteByChain?.[input.chainId] ?? 'STABLE';
  const sizingControls = input.controls.sizeMode === 'FIXED'
    ? { ...input.controls, fixedSizeUsd: fixedSizeForQuote(input.controls, input.chainId, quoteAsset) }
    : input.controls;
  const size = await resolvePositionSize({ controls: sizingControls, context: input.sizeContext, llm: input.llm, strategyRoot: input.strategyRoot });
  if (!size.ok) throw new Error(`POSITION_SIZE_RESOLUTION_FAILED: ${size.error}`);
  const range = await resolveRangeWidth({ controls: input.controls, context: input.rangeContext, llm: input.llm, strategyRoot: input.strategyRoot });
  if (!range.ok) throw new Error(`RANGE_RESOLUTION_FAILED: ${range.error}`);
  return {
    chainId: input.chainId,
    positionSizeUsd: size.value,
    rangePct: range.value,
    takeProfitPct: input.controls.takeProfitPct!,
    stopLossPct: input.controls.stopLossPct!,
    sizeMode: input.controls.sizeMode!,
    rangeMode: input.controls.rangeMode!,
    quoteAsset,
  };
}
