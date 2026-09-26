import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { chainIdSchema, errorMessage, poolIdentity, type ChainId } from './domain.js';
import { type AgentRun, type Controls, type Repository } from './storage/repositories.js';
import { type Agent } from './workers/screeningWorker.js';
import { ConversationalHandler } from './telegram/conversational.js';
import { getChain } from './config/chains.js';
import { type LlmClient } from './agent/llmClient.js';
import { activePositionButtons, formatActivePositionCard, formatClosePositionMessage } from './telegram/positionMessages.js';
import { effectivePnlDepositUsd, pnlPctFromValues } from './management/pnl.js';
import { isAddress } from 'viem';
import { BlockedTokenStore } from './storage/blockedTokens.js';

type TelegramUser = { id: number };
type TelegramMessage = { message_id: number; from?: TelegramUser; chat: { id: number }; text?: string };
type TelegramCallbackQuery = { id: string; from: TelegramUser; message?: { message_id?: number; chat: { id: number }; text?: string }; data?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type TelegramResponse<T> = { ok: boolean; result?: T; description?: string };

export interface TelegramOptions {
  token: string;
  allowedUserIds: Set<number>;
  agent: Agent;
  repo: Repository;
  chains: ChainId[];
  tokenLimit: number;
  poolLimit: number;
  scanFrom?: bigint;
  intervalSeconds: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Optional read-only conversational handler. When set, non-slash
   * messages from allowlisted users are routed to it after the existing
   * command router has missed. The handler never performs execution.
   */
  conversational?: ConversationalHandler;
  reportLlm?: LlmClient;
}

function reportFacts(run: AgentRun, liveExecutionEnabled: boolean, signerConfigured: boolean, botState: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  const chainIds = [...new Set<ChainId>([
    ...run.discoveries.map(discovery => discovery.chainId),
    ...run.decisions.map(decision => decision.chainId),
    ...run.observations.map(observation => observation.state.pool.chainId),
    ...run.errors.map(error => error.chainId),
  ])].sort((a, b) => a - b);
  const reasonCounts = new Map<string, number>();
  for (const candidate of run.candidates) for (const rejection of candidate.rejections) {
    reasonCounts.set(rejection.code, (reasonCounts.get(rejection.code) ?? 0) + 1);
  }
  for (const error of run.errors) reasonCounts.set(error.error, (reasonCounts.get(error.error) ?? 0) + 1);
  const importantRejections = [...reasonCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8).map(([reason, count]) => ({ reason, count }));
  const bestCandidates = [...run.candidates]
    .sort((left, right) => (right.globalScore ?? -1) - (left.globalScore ?? -1) || left.identity.localeCompare(right.identity))
    .slice(0, 3).map(candidate => ({
      chain: getChain(candidate.pool.chainId).name,
      pool: candidate.identity,
      accepted: candidate.approved,
      score: candidate.globalScore,
      tvlUsd: candidate.metrics.tvlUsd,
      volumeUsd: candidate.metrics.volumeUsd,
      rejectionCodes: candidate.rejections.map(rejection => rejection.code),
    }));
  const tokenSummary = run.discoveries.map(discovery => ({
    chain: getChain(discovery.chainId).name,
    pass: discovery.tokens.length,
    reject: null as number | null,
    rejectNote: 'Rejected-token count is not persisted in the deterministic run record',
  }));
  const tokenDecisions = run.tokenDecisions ?? [];
  const passTokens = tokenDecisions.filter(token => token.verdict === 'PASS').map(token => ({
    label: token.symbol || token.name || `${token.tokenAddress.slice(0, 8)}…`,
    tokenAddress: token.tokenAddress,
  }));
  const candidateRows = run.candidates.slice(0, 3).map(candidate => {
    const explicit = run.selectedTokenAddress
      ? tokenDecisions.find(item => item.chainId === candidate.pool.chainId && item.tokenAddress.toLowerCase() === run.selectedTokenAddress!.toLowerCase())
      : undefined;
    const quote = candidate.pool.protocol === 'v4' ? (() => { const chain = getChain(candidate.pool.chainId); const c0 = candidate.pool.poolKey.currency0.toLowerCase(); return c0 === chain.primaryStable.toLowerCase() ? 'USDG' : c0 === chain.wrappedNative?.toLowerCase() ? 'WETH' : null; })() : null;
    const feeBps = candidate.pool.protocol === 'v4'
      ? candidate.pool.poolKey.fee
      : run.observations.find(observation => poolIdentity(observation.state.pool) === candidate.identity)?.state.fee;
    const poolId = candidate.pool.protocol === 'v3' ? candidate.pool.poolAddress : candidate.pool.poolId;
    return { chain: getChain(candidate.pool.chainId).name, protocol: candidate.pool.protocol, volumeUsd: run.selectedTokenVolume1h ?? explicit?.volume1h ?? null,
      label: run.selectedTokenSymbol || explicit?.symbol || explicit?.name || null, accepted: candidate.approved,
      reasons: [...new Set(candidate.rejections.map(rejection => rejection.code))], quote, poolLiquidityUsd: candidate.metrics.tvlUsd,
      feePercent: feeBps == null ? null : formatPoolFee(feeBps), poolUrl: `https://app.uniswap.org/explore/pools/robinhood/${poolId}` };
  });
  const rankable = (run.stage1Ranking?.ranked ?? []).map(token => ({ label: token.symbol || `${token.tokenAddress.slice(0, 8)}…`, score: token.score, volume1h: token.volume1h, liquidityUsd: token.liquidityUsd, hotSearchRank: token.hotSearchRank, address: token.tokenAddress }));
  const selectedToken = run.selectedTokenAddress ? { label: run.selectedTokenSymbol || run.selectedTokenAddress.slice(0, 8) + '…', address: run.selectedTokenAddress } : null;
  const candidateHandoff = run.candidateHandoff;
  const openedDetails = run.decisions.find(decision => decision.opened)?.opened ?? null;
  const exclusionCounts = (run.stage1Ranking?.exclusions ?? []).map(item => ({ kind: item.reason.toLowerCase().replace(/_position$/, '').replace('_', ' '), count: item.count }));
  const eligibleCount = run.stage1Ranking?.eligibleCount;
  const poolSummary = run.discoveries.map(discovery => ({
    chain: getChain(discovery.chainId).name,
    poolsFound: discovery.pools.length,
  }));
  const decisions = run.decisions.map(decision => ({
    chain: getChain(decision.chainId).name,
    action: decision.selection.action,
    reason: decision.selection.reason,
  }));
  const providerFailures = run.errors.filter(error => /GMGN|RPC|provider|rate.?limit|Hot Search|fetch failed/i.test(error.error))
    .map(error => ({ chain: getChain(error.chainId).name, error: error.error })).slice(0, 8);
  return {
    runId: run.id,
    status: run.status,
    mode: run.mode,
    cycleStartedAt: new Date(run.startedAt * 1000).toISOString(),
    cycleFinishedAt: new Date(run.finishedAt * 1000).toISOString(),
    cycleDurationSeconds: Math.max(0, run.finishedAt - run.startedAt),
    chainsScanned: chainIds.map(chainId => ({ chainId, name: getChain(chainId).name })),
    tokenSummary,
    poolSummary,
    candidates: run.candidates.length,
    accepted: run.candidates.filter(candidate => candidate.approved).length,
    rejected: run.candidates.filter(candidate => !candidate.approved).length,
    importantRejections,
    bestCandidates,
    decisions,
    providerFailures,
    executionErrors: run.errors,
    positionsOpened: run.decisions.filter(decision => decision.opened).length,
    openedDetails: openedDetails ? { ...openedDetails, label: run.selectedTokenSymbol || selectedToken?.label || 'position' } : null,
    plansCreated: run.decisions.filter(decision => decision.plan).length,
    transactionsRecorded: run.decisions.reduce((count, decision) => count + (decision.transactionHashes?.length ?? 0), 0),
    liveExecutionEnabled,
    signerConfigured,
    activePositionCards: run.positions.filter(position => position.status === 'open').map(position => formatActivePositionCard({
      symbol: position.plan.pool.protocol === 'v4' ? 'V4 position' : 'V3 position', protocol: position.plan.pool.protocol,
      tokenId: position.id.split(':').at(-1) ?? position.id, openedAt: position.openedAt, now: run.finishedAt,
      lowerPrice: null, upperPrice: null, currentPrice: null, baseSymbol: 'base', quoteSymbol: 'quote',
      valueUsd: position.currentValueUsd, feeUsd: position.unclaimedFeesUsd, pnlPct: pnlPctFromValues(position.currentValueUsd, position.initialValueUsd),
      inRange: position.outOfRangeSince === null, positionBase: position.plan.pool.protocol === 'v4' ? 'https://app.uniswap.org/positions/v4/robinhood' : undefined,
    })),
    passTokens, candidateRows, botState,
    scannedCount: run.discoverySnapshot?.discovered ?? (run.discoveries.reduce((n, discovery) => n + discovery.tokens.length, 0) || undefined),
    passCount: tokenDecisions.filter(token => token.verdict === 'PASS').length,
    eligibleCount,
    exclusions: exclusionCounts,
    tokenRanking: rankable,
    selectedToken, candidateHandoff,
    activePositionSummary: (run.livePositions ?? []).map(position => `${position.protocol.toUpperCase()} #${position.tokenId} [${position.protocol}] | ${position.status.toUpperCase()}${position.closeReason ? ` | Close: ${position.closeReason}` : ''}`),
    normalizationStatus: undefined,
  };
}

function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unavailable';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(2)}k`;
  return `$${value.toFixed(2)}`;
}

function formatPoolFee(feeBps: number): string {
  return `${(feeBps / 10_000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function balanceErrorText(error: { code?: string; details?: { quoteSymbol?: string; requiredHuman?: string; availableHuman?: string; requiredUsd?: number } }): string | null {
  const d = error.details;
  if (error.code !== 'INSUFFICIENT_QUOTE_BALANCE' || !d?.quoteSymbol) return null;
  return `❌ Insufficient ${d.quoteSymbol} balance\nRequired: ~${d.requiredHuman ?? 'unavailable'} ${d.quoteSymbol} (${d.requiredUsd == null ? 'unavailable' : `$${d.requiredUsd}`})\nAvailable: ${d.availableHuman ?? 'unavailable'} ${d.quoteSymbol}`;
}

function fallbackReportSummary(facts: ReturnType<typeof reportFacts>): string {
  const chain = facts.chainsScanned[0];
  const duration = Math.max(0, facts.cycleDurationSeconds).toFixed(1).replace(/\.0$/, '');
  const statusEmoji = facts.status === 'ok' ? '✅' : facts.status === 'degraded' ? '⚠️' : '❌';
  const rankings = facts.tokenRanking.slice(0, 5);
  const candidate = facts.candidateRows[0];
  const selected = facts.selectedToken;
  const screening = [`🔎 Screening`, `Scanned: ${facts.scannedCount ?? 'unavailable'} | PASS: ${facts.passCount}`];
  if (facts.eligibleCount != null) screening[1] += ` | Eligible: ${facts.eligibleCount}`;
  if (facts.exclusions.length) screening.push(`Excluded: ${facts.exclusions.map(item => `${item.count} ${item.kind}`).join(' • ')}`);
  const rankingLines = rankings.length
    ? ['🏆 Token Ranking', ...rankings.flatMap((ranking, index) => [
      `#${index + 1} ${ranking.label} | Score ${ranking.score.toFixed(4)}`,
      `Vol 1h: ${compactUsd(ranking.volume1h)} | Liq: ${compactUsd(ranking.liquidityUsd)}`,
    ])]
    : ['🏆 Token Ranking', 'No eligible token'];
  let candidateLines: string[];
  if (candidate) {
    const quote = candidate.quote ? ` | Quote: ${candidate.quote}` : '';
    const fee = candidate.feePercent ? ` ${candidate.feePercent}` : '';
    const poolLink = candidate.poolUrl ? ` <a href="${candidate.poolUrl}">Pool</a>` : '';
    candidateLines = ['🎯 Candidate', `${candidate.label ?? 'unavailable'}${candidate.protocol ? ` [${candidate.protocol}]` : ''}${fee}${poolLink}${quote}`];
    if (candidate.poolLiquidityUsd != null) candidateLines.push(`Pool Liq: ${compactUsd(candidate.poolLiquidityUsd)}`);
    candidateLines.push(candidate.accepted ? '✅ ACCEPTED' : `❌ ${candidate.reasons.join(', ') || 'REJECTED'}`);
  } else if (selected) {
    const handoff = facts.candidateHandoff;
    const status = handoff?.status === 'SKIPPED'
      ? handoff.reason === 'NO_SUPPORTED_POOL' ? '❌ NO_SUPPORTED_POOL' : handoff.reason === 'BOT_STOPPED' ? '⏸ Handoff skipped — BOT_STOPPED' : '⚠️ Candidate handoff unavailable'
      : facts.botState === 'STOPPED' ? '⏸ Handoff skipped — BOT_STOPPED' : 'No candidate execution result';
    candidateLines = ['🎯 Candidate', selected.label, status];
  } else candidateLines = ['🎯 Candidate', 'None'];
  const failures = facts.providerFailures.map(failure => `⚠️ Provider: ${failure.error.split(':')[0]}`).join('\n');
  const balanceFailure = facts.executionErrors.find((e: any) => e.code === 'INSUFFICIENT_QUOTE_BALANCE');
  const opened = facts.openedDetails;
  const executionFailure = facts.executionErrors.find((e: any) => e.code !== 'INSUFFICIENT_QUOTE_BALANCE');
  const execution = balanceFailure ? balanceErrorText(balanceFailure)! : opened ? `✅ Opened ${opened.label} #${opened.tokenId} [${opened.protocol}]\nSize: ~$${opened.sizeUsd}\nTx: ${opened.txHash.slice(0, 10)}…${opened.txHash.slice(-4)}` : executionFailure ? `❌ ${executionFailure.code ?? executionFailure.error}` : facts.transactionsRecorded > 0 ? `⚙️ Transaction activity (${facts.transactionsRecorded})` : 'No action';
  const openCount = (facts as any).activePositionSummary.filter((line: string) => line.includes(' | OPEN')).length;
  const closingCount = (facts as any).activePositionSummary.filter((line: string) => line.includes(' | CLOSING')).length;
  const positionLines = facts.activePositionSummary.length ? ['📊 Positions', `Open: ${openCount} | Closing: ${closingCount}`, ...facts.activePositionSummary] : ['📊 Positions', 'No open positions'];
  const footer = facts.botState === 'STOPPED' ? '🔴 STOPPED | Signer Ready' : facts.liveExecutionEnabled ? (facts.signerConfigured ? '🟢 RUNNING | Signer Ready' : '⚠️ RUNNING | Signer Degraded') : '⚠️ RUNNING | Signer Degraded';
  return [
    `🤖 Viero Cycle #${facts.runId.slice(0, 8)}`,
    `⏱ ${duration}s | ${chain?.name ?? 'No chains'}${chain ? ` [${chain.chainId}]` : ''} | ${statusEmoji} ${facts.status}`,
    '', ...screening, '', ...rankingLines, '', ...candidateLines,
    '', '⚙️ Execution', execution,
    '', ...positionLines,
    ...(facts.normalizationStatus ? ['', `Normalization: ${facts.normalizationStatus}`] : []),
    footer,
    ...(failures ? [failures] : []),
  ].join('\n');
}

/**
 * Strip chain-of-thought / reasoning blocks from LLM output.
 *
 * Some providers (e.g. reasoning-tuned models) emit a free-form preamble
 * such as `<think>...</think>` before the final answer. Telegram users
 * must never see that reasoning — only the final summary. This is the
 * last line of defense:
 *
 *   1. Match every well-formed <think>...</think> block (greedy, multiline).
 *   2. If a `<think>` tag was opened but never closed, drop from the open
 *      tag to the end of the string (the reasoning runs to completion with
 *      no visible final answer).
 */
export function sanitizeLlmOutput(text: string): string {
  if (!text) return '';
  return text
    // Closed reasoning blocks.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Unclosed trailing reasoning (runs to end of string).
    .replace(/<think>[\s\S]*$/gi, '')
    // Collapse runs of blank lines created by the strip.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Hard cap for any single Telegram message. Telegram's own limit is 4096
 * characters; we leave headroom for safety.
 */
const TELEGRAM_MESSAGE_LIMIT = 3200;
const TRUNCATION_SUFFIX = '\n…(truncated)';

/**
 * Truncate at the LAST newline within the cap (or at the cap), then
 * append a truncation suffix. The final length is ALWAYS ≤
 * TELEGRAM_MESSAGE_LIMIT.
 */
function clampForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  const softCap = TELEGRAM_MESSAGE_LIMIT - TRUNCATION_SUFFIX.length;
  const cut = text.slice(0, softCap);
  const lastNl = cut.lastIndexOf('\n');
  const finalText = lastNl > softCap - 200 ? cut.slice(0, lastNl) : cut;
  return finalText.trimEnd() + TRUNCATION_SUFFIX;
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const token = z.string().min(20, 'TELEGRAM_BOT_TOKEN is required').parse(env.TELEGRAM_BOT_TOKEN);
  const allowedUserIds = new Set(z.string().min(1, 'TELEGRAM_USER_IDS is required').parse(env.TELEGRAM_USER_IDS)
    .split(',').map(v => z.coerce.number().int().positive().parse(v.trim())));
  return { token, allowedUserIds };
}

export function validateStartSettings(controls: Controls): string[] {
  const errors: string[] = [];
  if (!(controls.enabledChains?.length)) errors.push('enable at least one chain');
  if (!(typeof controls.takeProfitPct === 'number' && Number.isFinite(controls.takeProfitPct) && controls.takeProfitPct > 0)) errors.push('set Take Profit to a percentage greater than 0');
  if (!(typeof controls.stopLossPct === 'number' && Number.isFinite(controls.stopLossPct) && controls.stopLossPct < 0)) errors.push('set Stop Loss to a negative percentage');
  if (controls.sizeMode === 'FIXED') {
    if (!(typeof controls.fixedSizeUsd === 'number' && Number.isFinite(controls.fixedSizeUsd) && controls.fixedSizeUsd > 0)) errors.push('set a valid Fixed Size in USD');
  } else if (controls.sizeMode !== 'AUTO') errors.push('select Auto Size or Fixed Size');
  if (controls.rangeMode === 'FIXED') {
    if (!(typeof controls.fixedRangePct === 'number' && Number.isFinite(controls.fixedRangePct) && controls.fixedRangePct >= 1 && controls.fixedRangePct <= 99)) errors.push('set a valid Fixed Range from 1% to 99%');
  } else if (controls.rangeMode !== 'AUTO') errors.push('select Auto Range or Fixed Range');
  return errors;
}

export class TelegramBot {
  private offset = 0;
  private runningScreen = false;
  private fetchImpl: typeof fetch;
  private automaticReportsInitialized = false;
  private lastAutomaticReportId: string | null = null;
  private pendingSetting = new Map<number, 'fixedSizeUsd' | 'fixedRangePct' | 'takeProfitPct' | 'stopLossPct'>();
  private positionActions = new Set<string>();

  constructor(private options: TelegramOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async start() {
    await this.api('setMyCommands', { commands: [
      { command: 'start', description: 'Start Viero' },
      { command: 'stop', description: 'Stop new LP entries' },
      { command: 'status', description: 'Show Viero status' },
      { command: 'settings', description: 'Configure LP strategy' },
      { command: 'report', description: 'Show latest screening report' },
      { command: 'help', description: 'Show available commands' },
      { command: 'block_tokens', description: 'Manage blocked discovery tokens' },
    ] });
    await this.api('deleteWebhook', { drop_pending_updates: false });
    await this.checkForScheduledReport();
    const automaticReporter = this.automaticReportLoop();
    try {
      while (!this.options.signal?.aborted) {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message) await this.handleMessage(update.message);
          if (update.callback_query) await this.handleCallbackQuery(update.callback_query);
        }
      }
    } finally {
      await automaticReporter;
    }
  }

  private async automaticReportLoop() {
    while (!this.options.signal?.aborted) {
      await delay(Math.min(this.options.intervalSeconds * 1000, 30_000), undefined, { signal: this.options.signal }).catch(() => undefined);
      if (this.options.signal?.aborted) break;
      try { await this.checkForScheduledReport(); }
      catch (error) { console.error(`telegram automatic report failed: ${errorMessage(error)}`); }
    }
  }

  /**
   * Auto-report gate. The startup run is recorded but NEVER pushed.
   * We only auto-push runs that completed successfully enough to be
   * meaningful — i.e. not in a failed/paused state.
   *
   * Run IDs are tracked in `lastAutomaticReportId` so each completed
   * scheduled run is sent at most once.
   */
  async checkForScheduledReport() {
    // Management lifecycle notifications are persisted by the agent so this
    // process can deliver them exactly once without performing any chain/API
    // enrichment of its own.
    const managementState = typeof this.options.repo.strategyState === 'function' ? await this.options.repo.strategyState() : null;
    const pendingManagement = (managementState?.managementNotifications ?? []).filter(event => !event.delivered);
    for (const event of pendingManagement) {
      const label = `${event.symbol ?? event.protocol.toUpperCase()} #${event.tokenId} [${event.protocol}]`;
      const body = event.kind === 'opened'
        ? [`✅ Position Opened`, label, event.valueUsd != null ? `Size: ~$${event.valueUsd.toFixed(2)}` : null, event.txHash ? `Tx: ${event.txHash.slice(0, 6)}…${event.txHash.slice(-4)}` : null].filter(Boolean).join('\n')
        : event.kind === 'closing'
        ? [`⚠️ Closing Position`, label, `Reason: ${event.reason ?? 'CLOSE'}`, event.pnlPct != null ? `PnL: ${event.pnlPct >= 0 ? '+' : ''}${event.pnlPct.toFixed(4)}%` : null, event.valueUsd != null ? `Val: $${event.valueUsd.toFixed(2)}` : null, event.feeUsd != null ? `Unclaimed: $${event.feeUsd.toFixed(4)}` : null].filter(Boolean).join('\n')
        : event.kind === 'closed'
          ? [`✅ Position Closed`, label, `Reason: ${event.reason ?? 'CLOSE'}`, event.pnlPct != null ? `Final PnL: ${event.pnlPct >= 0 ? '+' : ''}${event.pnlPct.toFixed(4)}%` : null, event.txHash ? `Tx: ${event.txHash.slice(0, 6)}…${event.txHash.slice(-4)}` : null].filter(Boolean).join('\n')
          : event.kind === 'close_failed'
            ? [`❌ Close Failed`, label, `Reason: ${event.reason ?? 'CLOSE'}`, `Error: ${event.error ?? 'unknown'}`].join('\n')
            : [
              `🔄 SWAP`,
              label,
              event.status === 'SUCCESS' ? 'Status: SUCCESS ✅' : 'Status: FAILED ❌',
              event.status === 'SUCCESS' && event.symbol && event.targetSymbol ? `${event.symbol} -> ${event.targetSymbol}` : null,
              event.txHash ? `Tx: ${event.txHash.slice(0, 6)}…${event.txHash.slice(-4)}` : null,
              event.status !== 'SUCCESS' && event.error ? `Error: ${event.error}` : null,
            ].filter(Boolean).join('\n');
      await this.send(this.options.allowedUserIds.values().next().value!, body);
      if (!managementState || typeof this.options.repo.strategyState !== 'function' || typeof this.options.repo.setStrategyState !== 'function') continue;
      const current = await this.options.repo.strategyState();
      const item = current.managementNotifications.find(candidate => candidate.id === event.id);
      if (item) item.delivered = true;
      await this.options.repo.setStrategyState(current);
    }
    const latest = await this.options.repo.latest();
    const controls = await this.options.repo.controls();
    if (!this.automaticReportsInitialized) {
      this.automaticReportsInitialized = true;
      this.lastAutomaticReportId = controls.lastAutoReportRunId ?? latest?.id ?? null;
      if (!controls.lastAutoReportRunId && latest) await this.options.repo.setControls({ ...controls, lastAutoReportRunId: latest.id });
      return; // never push the pre-existing stale / startup / failed run
    }
    if (!latest) return;
    if (latest.id === this.lastAutomaticReportId || latest.id === controls.lastAutoReportRunId) return; // already sent
    if (this.runningScreen) return;
    // Fail-closed for unsuccessful runs: never auto-push a CHAIN_PAUSED /
    // GLOBAL_PAUSED / no-decisions / status=failed run as a "screening result".
    // An idle 'ok' cycle (status=ok, observations=[], no decisions) IS a
    // legitimate completed scheduled run and should be reported.
    if (latest.status === 'failed') return;
    const allPaused = latest.errors.length > 0 && latest.errors.every(
      error => /CHAIN_PAUSED|GLOBAL_PAUSED/.test(error.error),
    );
    if (allPaused) return;
    await this.sendSummarizedReport(this.options.allowedUserIds, latest);
    this.lastAutomaticReportId = latest.id;
    await this.options.repo.setControls({ ...controls, lastAutoReportRunId: latest.id });
  }

  async handleMessage(message: TelegramMessage) {
    const userId = message.from?.id;
    if (!userId || !this.options.allowedUserIds.has(userId)) {
      await this.send(message.chat.id, 'Unauthorized.');
      return;
    }
    const text = (message.text ?? '').trim();
    const [command, ...args] = text.split(/\s+/);
    switch ((command || '/help').split('@')[0]) {
      case '/start':
        await this.startBot(message.chat.id);
        return;
      case '/stop':
        await this.setBotState(message.chat.id, 'STOPPED');
        return;
      case '/settings':
        await this.settings(message.chat.id);
        return;
      case '/status':
        await this.status(message.chat.id);
        return;
      case '/block_tokens':
        await this.blockTokens(message.chat.id, args);
        return;
      case '/help':
        await this.send(message.chat.id, [
          'Viero Telegram bot is online.',
          '',
          '/start - allow new-entry execution',
          '/stop - block new entries while preserving position management',
          '/settings - show settings while stopped',
          '/status - show operating and execution status',
          '/report - send the latest saved report',
          '/block_tokens - list/add/remove manually blocked tokens',
          '/screen - run one read-only screening cycle',
          '/pause [chains] - pause all chains or comma-separated chain IDs',
          '/resume [chains] - resume all chains or comma-separated chain IDs',
          ...(this.options.conversational
            ? ['', 'Conversational chat is enabled. Send plain-English questions (read-only).']
            : []),
        ].join('\n'));
        return;
      case '/report':
      case 'report':
        await this.report(message.chat.id);
        return;
      case '/screen':
      case 'screen':
        await this.screen(message.chat.id);
        return;
      case '/pause':
      case 'pause':
        await this.setPaused(message.chat.id, true, args[0]);
        return;
      case '/resume':
      case 'resume':
        await this.setPaused(message.chat.id, false, args[0]);
        return;
      default:
        if (this.pendingSetting.has(userId) && text.length > 0 && !text.startsWith('/')) {
          await this.acceptSettingInput(message.chat.id, userId, text);
          return;
        }
        // Slash commands (and bare command words) always win over conversation.
        // Free-form text (no leading slash, no recognized command) goes to the
        // read-only conversational handler if one was configured.
        if (text.length > 0 && !text.startsWith('/') && this.options.conversational) {
          try {
            const reply = await this.options.conversational.handle(message.chat.id, text);
            for (const chunk of chunkTelegramText(reply)) {
              await this.send(message.chat.id, chunk);
            }
          } catch (error) {
            await this.send(message.chat.id, `Conversational handler failed: ${errorMessage(error)}`);
          }
          return;
        }
        await this.send(message.chat.id, 'Unknown command. Send /help for options.');
    }
  }

  private async blockTokens(chatId: number, args: string[]) {
    const store = this.options.agent.blockedTokens;
    const state = await store.load();
    const sub = (args[0] ?? 'help').toLowerCase();
    if (sub === 'add') {
      const address = args[1];
      if (!address || !isAddress(address)) { await this.send(chatId, 'Usage: /block_tokens add <address> [symbol]'); return; }
      const key = BlockedTokenStore.key(4663, address);
      state.tokens[key] ??= { symbol: args[2], reason: 'MANUAL_BLOCK', addedAt: Date.now() / 1000, addedBy: String(chatId) };
      await store.save(state); await this.send(chatId, `✅ Token blocked\n${args[2] ?? 'unnamed'}\n${address.slice(0, 8)}…\nChain: 4663`); return;
    }
    if (sub === 'remove') {
      const address = args[1];
      if (!address || !isAddress(address)) { await this.send(chatId, 'Usage: /block_tokens remove <address>'); return; }
      const key = BlockedTokenStore.key(4663, address); delete state.tokens[key]; state.removedSeed ??= {}; state.removedSeed[key] = true;
      await store.save(state); await this.send(chatId, `✅ Token unblocked\n${address.slice(0, 8)}…`); return;
    }
    if (sub === 'list') {
      const page = Math.max(1, Number(args[1] ?? 1) || 1), entries = Object.entries(state.tokens), start = (page - 1) * 25;
      const lines = entries.slice(start, start + 25).map(([key, value], i) => `${start + i + 1}. ${value.symbol ?? 'unnamed'} — ${key.split(':')[1]!.slice(0, 8)}…`);
      await this.send(chatId, `🚫 Blocked Tokens (${entries.length})\n\n${lines.join('\n') || 'No entries'}\n\nPage ${page}`); return;
    }
    await this.send(chatId, `🚫 Blocked Tokens: ${Object.keys(state.tokens).length}\n\nCommands:\n/block_tokens list [page]\n/block_tokens add <address> [symbol]\n/block_tokens remove <address>`);
  }

  private async getUpdates() {
    try {
      const response = await this.api<TelegramUpdate[]>('getUpdates', {
        offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'],
      });
      return response;
    } catch (error) {
      if (!this.options.signal?.aborted) {
        console.error(`telegram polling failed: ${errorMessage(error)}`);
        await delay(5000, undefined, { signal: this.options.signal }).catch(() => undefined);
      }
      return [];
    }
  }

  private async report(chatId: number) {
    const latest = await this.options.repo.latest();
    if (!latest) {
      await this.send(chatId, 'No saved report yet. Send /screen to run one read-only cycle.');
      return;
    }
    await this.sendSummarizedReport([chatId], latest);
    this.lastAutomaticReportId = latest.id;
  }

  private async summarizeReport(run: AgentRun): Promise<string> {
    const controls = await this.options.repo.controls();
    const signerConfigured = Boolean(this.options.agent.signer);
    const facts = reportFacts(run, process.env.VIERO_EXECUTION_ENABLED === 'true', signerConfigured, controls.botState ?? 'STOPPED');
    let summary = fallbackReportSummary(facts);
    if (this.options.reportLlm) {
      try {
        const response = await this.options.reportLlm.chat({
          role: 'GENERAL',
          systemPrompt: [
            'Summarize the supplied deterministic Viero report facts for Telegram.',
            'Use only supplied facts. Never infer or invent values, actions, positions, transactions, or availability.',
            'The LLM is presentation-only: do not alter decisions, scores, acceptance, or execution status.',
            // --- Reasoning suppression (fix for chain-of-thought leakage) ---
            'IMPORTANT: Output ONLY the final summary — NO chain-of-thought, NO reasoning, NO internal monologue.',
            'Do NOT emit <think>, <reasoning>, or any internal tags. Output the final answer directly.',
            'When the provider exposes a separate `reasoning` field, ignore it — only the final `content` is used.',
            // --- Format / size constraints ---
            'Write concise natural language with short lines or bullets, no table, no preamble, and stay under 3000 characters.',
            'Use exactly this compact structure: cycle ID, duration/chain/status, actual PASS token names, one candidate with compact volume and deduplicated reasons, execution, positions opened, transactions, runtime footer, and provider failures only when present.',
            'Do not mention pools found, plans, decisions, verbose timestamps, unavailable reject counts, full IDs, or active-position details.',
          ].join(' '),
          messages: [{ role: 'user', content: JSON.stringify(facts) }],
          temperature: 0,
          maxTokens: 600,
        });
        const content = response.content?.trim();
        if (content) {
          // Defensive strip + clamp — even if the LLM obeys the
          // instructions, some models still leak <think>...</think>. The
          // sanitizer is the last line of defense.
          const cleaned = clampForTelegram(sanitizeLlmOutput(content));
          // A model response is accepted only when it preserves the
          // canonical cycle-report envelope. Otherwise the deterministic
          // formatter remains the single source of truth for every report
          // delivery path.
          const legacy = /Pools Found|Provider Failures|Plans Created|Decisions:|^Cycle:/im.test(cleaned);
          // Candidate pool links/fees are deterministic report facts. Keep
          // the canonical formatter when a candidate exists so a presentation
          // model cannot silently drop or rewrite those safety-relevant
          // identifiers.
          const candidateFacts = facts.candidateRows[0];
          const candidateLinkRequired = Boolean(candidateFacts?.poolUrl);
          if (cleaned.length > 0 && /^🤖 Viero cycle #/m.test(cleaned) && !legacy && !candidateLinkRequired) summary = cleaned;
        }
      } catch (error) {
        console.error(`telegram report summarization failed: ${errorMessage(error)}`);
      }
    }
    // Always sanitize the fallback path too (defensive).
    return clampForTelegram(sanitizeLlmOutput(summary));
  }

  private async sendSummarizedReport(chatIds: Iterable<number>, run: AgentRun) {
    const summary = await this.summarizeReport(run);
    const positions = typeof (this.options.repo as Partial<Repository>).strategyState === 'function'
      ? (await this.options.repo.strategyState()).positions.filter(position => position.status === 'open') : [];
    for (const chatId of chatIds) {
      await this.send(chatId, summary);
      for (const position of positions) await this.renderPositionCard(chatId, position);
    }
  }

  private async screen(chatId: number) {
    if (this.runningScreen) {
      await this.send(chatId, 'A screening cycle is already running.');
      return;
    }
    this.runningScreen = true;
    await this.send(chatId, 'Running one read-only screening cycle...');
    try {
      const run = await this.options.agent.cycle({
        mode: 'live-readonly',
        chains: this.options.chains,
        seeds: [],
        tokenLimit: this.options.tokenLimit,
        poolLimit: this.options.poolLimit,
        scanFrom: this.options.scanFrom,
      });
      // Manual /screen uses the same canonical formatter as automatic
      // delivery and /report; it must not emit the legacy renderReport table.
      await this.sendSummarizedReport([chatId], run);
      this.lastAutomaticReportId = run.id;
    } catch (error) {
      await this.send(chatId, `Screening failed: ${errorMessage(error)}`);
    } finally {
      this.runningScreen = false;
    }
  }

  private async setPaused(chatId: number, paused: boolean, chainArg?: string) {
    const controls = await this.options.repo.controls();
    if (!chainArg) {
      controls.globalPaused = paused;
    } else {
      const chains = [...new Set(chainArg.split(',').map(v => chainIdSchema.parse(Number(v))))];
      controls.pausedChains = paused
        ? [...new Set([...controls.pausedChains, ...chains])]
        : controls.pausedChains.filter(c => !chains.includes(c));
    }
    await this.options.repo.setControls(controls);
    await this.send(chatId, `Updated controls: globalPaused=${controls.globalPaused}; pausedChains=${controls.pausedChains.join(',') || 'none'}`);
  }

  private async setBotState(chatId: number, botState: 'RUNNING' | 'STOPPED') {
    const controls = await this.options.repo.controls();
    await this.options.repo.setControls({ ...controls, botState });
    await this.send(chatId, botState === 'RUNNING'
      ? 'Viero is RUNNING. New-entry execution is allowed when all existing execution safeguards pass.'
      : 'Viero is STOPPED. New entries are blocked; existing-position safety management remains active.');
  }

  private async startBot(chatId: number) {
    const controls = await this.options.repo.controls();
    const errors = validateStartSettings(controls);
    if (errors.length) {
      await this.options.repo.setControls({ ...controls, botState: 'STOPPED' });
      await this.send(chatId, `Viero remains STOPPED. Fix these settings:\n${errors.map(error => `• ${error}`).join('\n')}`);
      return;
    }
    await this.setBotState(chatId, 'RUNNING');
  }

  private async settings(chatId: number) {
    const controls = await this.options.repo.controls();
    if ((controls.botState ?? 'STOPPED') !== 'STOPPED') {
      await this.send(chatId, 'Stop Viero first with /stop before changing settings.');
      return;
    }
    await this.send(chatId, 'Viero settings (STOPPED)', {
      inline_keyboard: [
        [{ text: 'Auto Range', callback_data: 'settings:auto_range' }, { text: 'Fixed Range', callback_data: 'settings:fixed_range' }],
        [{ text: 'Auto Size', callback_data: 'settings:auto_size' }, { text: 'Fixed Size', callback_data: 'settings:fixed_size' }],
        [{ text: 'Chain', callback_data: 'settings:chain' }, { text: 'TP/SL', callback_data: 'settings:tpsl' }],
        [{ text: 'Wallet', callback_data: 'settings:wallet' }],
      ],
    });
  }

  async handleCallbackQuery(query: TelegramCallbackQuery) {
    const chatId = query.message?.chat.id;
    if (!this.options.allowedUserIds.has(query.from.id)) {
      await this.api('answerCallbackQuery', { callback_query_id: query.id, text: 'Unauthorized.' });
      return;
    }
    await this.api('answerCallbackQuery', { callback_query_id: query.id });
    if (!chatId) return;
    const controls = await this.options.repo.controls();
    const action = query.data ?? '';
    if (action.startsWith('position:')) {
      await this.handlePositionAction(query, chatId, action);
      return;
    }
    if ((controls.botState ?? 'STOPPED') !== 'STOPPED') {
      await this.send(chatId, 'Stop Viero first with /stop before changing settings.');
      return;
    }
    if (action === 'settings:auto_size' || action === 'settings:auto_range') {
      const size = action.endsWith('size');
      await this.options.repo.setControls({ ...controls, ...(size ? { sizeMode: 'AUTO' as const } : { rangeMode: 'AUTO' as const }) });
      await this.send(chatId, `${size ? 'Auto Size' : 'Auto Range'} selected. Deterministic market-cap/volatility rules will apply on the next candidate.`);
      return;
    }
    if (action === 'settings:fixed_size' || action === 'settings:fixed_range') {
      const size = action.endsWith('size');
      this.pendingSetting.set(query.from.id, size ? 'fixedSizeUsd' : 'fixedRangePct');
      await this.send(chatId, size ? 'Enter position size in USD (positive number), for example: 25' : 'Enter the single-side range width from 1% to 99%, for example: 15');
      return;
    }
    if (action === 'settings:chain') { await this.sendChainMenu(chatId, controls); return; }
    if (action.startsWith('settings:chain:')) {
      const chainId = chainIdSchema.parse(Number(action.split(':')[2]));
      const enabled = new Set(controls.enabledChains ?? []);
      if (enabled.has(chainId)) enabled.delete(chainId); else enabled.add(chainId);
      const next = { ...controls, enabledChains: [...enabled].sort((a, b) => a - b) };
      await this.options.repo.setControls(next);
      await this.sendChainMenu(chatId, next);
      return;
    }
    if (action === 'settings:tpsl') {
      await this.send(chatId, 'Configure TP/SL', { inline_keyboard: [[
        { text: 'Take Profit', callback_data: 'settings:tp' }, { text: 'Stop Loss', callback_data: 'settings:sl' },
      ]] });
      return;
    }
    if (action === 'settings:tp' || action === 'settings:sl') {
      const tp = action.endsWith(':tp');
      this.pendingSetting.set(query.from.id, tp ? 'takeProfitPct' : 'stopLossPct');
      await this.send(chatId, tp ? 'Enter Take Profit percentage greater than 0.' : 'Enter Stop Loss as a negative percentage, for example: -10');
      return;
    }
    if (action === 'settings:wallet') { await this.wallet(chatId); return; }
  }

  private async handlePositionAction(query: TelegramCallbackQuery, chatId: number, action: string) {
    const [, kind, tokenId] = action.split(':');
    if (!['refresh', 'claim', 'close', 'autoswap'].includes(kind ?? '') || !tokenId) {
      await this.send(chatId, 'Invalid position action.'); return;
    }
    const state = await this.options.repo.strategyState();
    const matches = state.positions.filter(position => position.tokenId.toString() === tokenId);
    if (matches.length !== 1) { await this.send(chatId, matches.length ? 'Position action is ambiguous.' : 'Position not found.'); return; }
    const position = matches[0]!;
    const key = `${kind}:${position.id}`;
    if (this.positionActions.has(key)) { await this.send(chatId, 'Position action already in progress.'); return; }
    if (kind !== 'refresh') {
      const controls = await this.options.repo.controls();
      if ((controls.botState ?? 'STOPPED') !== 'RUNNING') {
        await this.send(chatId, 'Bot is STOPPED. Start the bot before executing write actions.');
        return;
      }
      try { await this.options.agent.signer?.health(); } catch { await this.send(chatId, 'Signer is not ready.'); return; }
    }
    this.positionActions.add(key);
    try {
      if (kind === 'refresh') {
        await this.renderPositionCard(chatId, position, undefined, query.message?.message_id, query.message?.text);
        return;
      }
      const result = await this.options.agent.executePositionAction(position.id, kind === 'autoswap' ? 'autoswap' : kind as 'claim' | 'close');
      const tx = result.transactions.at(-1)?.hash;
      if (kind === 'claim') await this.send(chatId, tx ? `✅ Fees claimed\n${tx}` : '✅ Fees claimed.');
      else {
        const closedText = formatClosePositionMessage({ symbol: position.plan.pool.protocol === 'v4' ? 'V4 position' : 'V3 position', protocol: position.plan.pool.protocol,
          tokenId: position.tokenId, poolAddress: position.pool.protocol === 'v3' ? position.pool.poolAddress : position.pool.poolId, reason: position.closeReason ?? 'MANUAL',
          quoteAmount: null, depositUsd: position.plan.depositUsd, lowerPrice: null, upperPrice: null,
          entryPrice: null, exitPrice: null, currentValueUsd: null, pnlPct: null, pnlUsd: null,
          txHash: tx, blockExplorerTxBase: `${getChain(position.chainId).explorerUrl}/tx`, positionBase: position.plan.pool.protocol === 'v4' ? 'https://app.uniswap.org/positions/v4/robinhood' : undefined,
          normalization: kind === 'autoswap' && !result.normalized ? { pending: true } : undefined });
        await this.send(chatId, closedText);
      }
      const updated = (await this.options.repo.strategyState()).positions.find(item => item.id === position.id);
      if (updated?.status === 'open') await this.renderPositionCard(chatId, updated);
    } catch (error) {
      await this.send(chatId, `Position action failed: ${errorMessage(error)}`);
    } finally { this.positionActions.delete(key); }
  }

  private async renderPositionCard(chatId: number, position: import('./execution/liveState.js').LivePosition, currentTick?: number, messageId?: number, existingText?: string) {
    let enriched: any = null;
    try {
      enriched = position.plan.pool.protocol === 'v3'
        ? await this.options.agent.enrichV3Position(position)
        : await this.options.agent.enrichV4Position(position);
    } catch { enriched = null; }
    const feeDetails = enriched?.feeEvidence && enriched?.fee0Human != null && enriched?.fee1Human != null
      ? `${enriched.fee0Human} ${enriched.token0?.symbol ?? 'token0'} + ${enriched.fee1Human} ${enriched.token1?.symbol ?? 'token1'}` : null;
    const pnlValue = enriched?.feeEvidence && enriched?.feeUsd != null && enriched?.valueUsd != null ? enriched.valueUsd + enriched.feeUsd : enriched?.feeEvidence === false ? null : enriched?.valueUsd;
    const pnlDepositUsd = effectivePnlDepositUsd({ persistedDepositUsd: position.plan.depositUsd, entryPrincipalUsd: position.entryPrincipalUsd, principalValueUsd: enriched?.valueUsd ?? null,
      token0Address: enriched?.token0?.address, token1Address: enriched?.token1?.address, amount0: enriched?.amount0, amount1: enriched?.amount1,
      primaryStable: getChain(position.chainId).primaryStable });
    const text = formatActivePositionCard({ symbol: enriched?.baseSymbol ?? (position.plan.pool.protocol === 'v4' ? 'V4 position' : 'V3 position'), protocol: position.plan.pool.protocol,
      tokenId: position.tokenId, openedAt: position.openedAt, now: Date.now() / 1000, lowerPrice: enriched?.lowerPrice ?? null, upperPrice: enriched?.upperPrice ?? null,
      currentPrice: enriched?.currentPrice ?? null, baseSymbol: enriched?.baseSymbol ?? 'base', quoteSymbol: enriched?.quoteSymbol ?? 'quote', valueUsd: enriched?.valueUsd ?? null,
      feeUsd: enriched?.feeUsd ?? null, feeDetails, pnlPct: pnlPctFromValues(pnlValue, pnlDepositUsd),
      inRange: enriched ? enriched.inRange : undefined,
      positionBase: position.plan.pool.protocol === 'v4' ? 'https://app.uniswap.org/positions/v4/robinhood' : undefined });
    const replyMarkup = activePositionButtons({ symbol: position.plan.pool.protocol === 'v4' ? 'V4 position' : 'V3 position', protocol: position.plan.pool.protocol, tokenId: position.tokenId });
    if (messageId !== undefined) {
      if (existingText !== text) await this.api('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, reply_markup: replyMarkup });
    } else await this.send(chatId, text, replyMarkup);
  }

  private async acceptSettingInput(chatId: number, userId: number, text: string) {
    const field = this.pendingSetting.get(userId)!;
    const value = Number(text);
    const valid = Number.isFinite(value) && (field === 'fixedSizeUsd' || field === 'takeProfitPct' ? value > 0
      : field === 'fixedRangePct' ? value >= 1 && value <= 99 : value < 0);
    if (!valid) {
      const requirement = field === 'fixedSizeUsd' ? 'a positive finite USD amount' : field === 'fixedRangePct' ? 'a number from 1 to 99' : field === 'takeProfitPct' ? 'a percentage greater than 0' : 'a negative percentage';
      await this.send(chatId, `Invalid value. Enter ${requirement}.`);
      return;
    }
    const controls = await this.options.repo.controls();
    const mode = field === 'fixedSizeUsd' ? { sizeMode: 'FIXED' as const } : field === 'fixedRangePct' ? { rangeMode: 'FIXED' as const } : {};
    await this.options.repo.setControls({ ...controls, ...mode, [field]: value });
    this.pendingSetting.delete(userId);
    await this.send(chatId, `${field === 'fixedSizeUsd' ? 'Fixed Size' : field === 'fixedRangePct' ? 'Fixed Range' : field === 'takeProfitPct' ? 'Take Profit' : 'Stop Loss'} saved: ${value}${field === 'fixedSizeUsd' ? ' USD' : '%'}.`);
  }

  private async sendChainMenu(chatId: number, controls: Controls) {
    const enabled = new Set(controls.enabledChains ?? []);
    const chains: Array<[ChainId, string]> = [[56, 'BNB Smart Chain'], [8453, 'Base'], [4663, 'Robinhood Chain'], [5042, 'Arc']];
    await this.send(chatId, 'Select enabled chains. At least one is required before /start.', {
      inline_keyboard: chains.map(([id, name]) => [{ text: `${enabled.has(id) ? '✅' : '⬜'} ${name} (${id})`, callback_data: `settings:chain:${id}` }]),
    });
  }

  private async wallet(chatId: number) {
    const signer = this.options.agent.signer;
    let address = 'not available';
    let ready = false;
    if (signer) {
      try {
        const health = await signer.health();
        address = `${health.address.slice(0, 6)}…${health.address.slice(-4)}`;
        ready = true;
      } catch { address = 'unavailable'; }
    }
    await this.send(chatId, [`Wallet: ${address}`, `Execution: ${process.env.VIERO_EXECUTION_ENABLED === 'true' ? 'enabled' : 'disabled'}`, `Signer: ${ready ? 'configured' : 'not configured'}`, 'Private keys and seed phrases are never accepted through Telegram.'].join('\n'));
  }

  private async status(chatId: number) {
    const controls = await this.options.repo.controls();
    let signerReady = false;
    if (this.options.agent.signer) {
      try { await this.options.agent.signer.health(); signerReady = true; } catch { /* report unavailable */ }
    }
    await this.send(chatId, [
      `Bot state: ${controls.botState ?? 'STOPPED'}`,
      `Live execution: ${process.env.VIERO_EXECUTION_ENABLED === 'true' ? 'enabled' : 'disabled'}`,
      `Signer: ${signerReady ? 'configured' : 'not configured'}`,
    ].join('\n'));
  }

  private async send(chatId: number, text: string, replyMarkup?: Record<string, unknown>) {
    const chunks = chunkTelegramText(text);
    for (const [index, chunk] of chunks.entries()) await this.api('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true,
      ...(chunk.includes('<a href="') ? { parse_mode: 'HTML' } : {}),
      ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.options.signal,
    });
    if (!response.ok) throw new Error(`TELEGRAM_HTTP_${response.status}`);
    const payload = await response.json() as TelegramResponse<T>;
    if (!payload.ok) throw new Error(payload.description ?? `TELEGRAM_${method}_FAILED`);
    return payload.result as T;
  }
}

export function chunkTelegramText(text: string, max = 3900) {
  const chunks: string[] = [];
  let remaining = text || ' ';
  while (remaining.length > max) {
    let index = remaining.lastIndexOf('\n', max);
    if (index < max * 0.5) index = max;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}
