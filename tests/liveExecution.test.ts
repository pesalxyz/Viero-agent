/**
 * Focused tests for the live LP execution layer:
 *
 *  - `historicalRejections` (cooldowns, blacklists, position capacity, daily-loss caps)
 *  - `recordClosedOutcome` (cooldown/blacklist/lesson application)
 *  - `liveManagementDecision` (decision branches; fail-closed properties)
 *  - ERC20 Transfer event decoding (executor path)
 *  - `contextFromRetrievedCandidate` risk enrichment
 *  - LivePosition invariants
 *
 * All observations come from `demoObservations()` so screen() invariants
 * (price ranges, depth, fees) are satisfied — no synthetic approximations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEventLog,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  historicalRejections,
  recordClosedOutcome,
} from '../src/viero/execution/history.js';
import { liveManagementDecision, normalizeHumanRange } from '../src/viero/management/live.js';
import { effectivePnlDepositUsd, isPrimaryStableQuoteOnly, pnlPctFromValues } from '../src/viero/management/pnl.js';
import { screen } from '../src/viero/screening/pipeline.js';
import { DEFAULT_POLICY } from '../src/viero/config/policy.js';
import {
  contextFromRetrievedCandidate,
  type AnalysisContext,
} from '../src/viero/agent/analysisContext.js';
import { erc20TransferEvent } from '../src/viero/adapters/abi.js';
import { type ChainId } from '../src/viero/domain.js';
import { type Candidate } from '../src/viero/screening/pipeline.js';
import { type LivePosition } from '../src/viero/execution/liveState.js';
import { demoObservations } from '../src/viero/fixtures/demo.js';
import { contractRequestToTransactionRequest, decodeIncomingErc20Transfers, inspectCloseLiquidity, reconcileClosedWithoutReceipt } from '../src/viero/execution/executor.js';
import { Agent, closeNotificationPnlPct } from '../src/viero/workers/screeningWorker.js';
import type { Controls, Repository } from '../src/viero/storage/repositories.js';

// ─── Helpers ───────────────────────────────────────────────────

function makeApprovedCandidate(): Candidate {
  const obs = demoObservations()[0]!;
  const c = screen(obs, DEFAULT_POLICY, obs.state.observedAt);
  if (!c.approved) {
    throw new Error(`demo fixture did not approve: ${c.rejections.map((r) => r.code).join(',')}`);
  }
  return c;
}

test('contract-write requests are encoded with destination and calldata before signing', () => {
  const request = contractRequestToTransactionRequest({
    address: '0x1111111111111111111111111111111111111111',
    abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }],
    functionName: 'approve',
    args: ['0x2222222222222222222222222222222222222222', 5n],
    value: 0n,
    gas: 100000n,
  });
  assert.equal(request.to, '0x1111111111111111111111111111111111111111');
  assert.match(request.data, /^0x095ea7b3/);
  assert.ok(request.data.length > 10);
  assert.equal(request.gas, 100000n);
});

test('V4 modifyLiquidities request cannot become a null-destination transaction', () => {
  const request = contractRequestToTransactionRequest({
    address: '0x3333333333333333333333333333333333333333',
    abi: [{ type: 'function', name: 'modifyLiquidities', stateMutability: 'payable', inputs: [{ name: 'unlockData', type: 'bytes' }, { name: 'deadline', type: 'uint256' }], outputs: [] }],
    functionName: 'modifyLiquidities', args: ['0x1234', 99n], value: 7n,
  });
  assert.equal(request.to, '0x3333333333333333333333333333333333333333');
  assert.notEqual(request.to, null);
  assert.match(request.data, /^0x/);
  assert.ok(request.data.length > 10);
});

function poolIdOf(): string {
  const obs = demoObservations()[0]!;
  const p = obs.state.pool;
  return `${p.chainId}:${p.protocol}:${p.dex}:${
    p.protocol === 'v3' ? (p as { poolAddress: string }).poolAddress : (p as { poolId: string }).poolId
  }`;
}

function tokenKey(idx: number): string {
  const obs = demoObservations()[0]!;
  const token = idx === 0 ? obs.state.token0.address : obs.state.token1.address;
  return `${obs.state.pool.chainId}:${token.toLowerCase()}`;
}

function makeLivePosition(overrides: Partial<LivePosition> = {}): LivePosition {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const chain = obs.state.pool.chainId;
  const token0 = obs.state.token0.address as Address;
  const token1 = obs.state.token1.address as Address;
  return {
    id: `paper-0:${candidate.identity}`,
    chainId: candidate.pool.chainId,
    pool: candidate.pool,
    tokenId: 1n,
    positionManager: '0x1111111111111111111111111111111111111111',
    plan: {
      chainId: candidate.pool.chainId,
      pool: candidate.pool,
      mode: 'live',
      createdAt: obs.state.observedAt,
      deadline: obs.state.observedAt + 120,
      sourceBlock: 1n,
      sourceBlockHash: '0x' + 'a'.repeat(64),
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1000n,
      poolFee: 3000,
      depositAssets: [
        { token: token0, amount: 1_000_000_000_000_000_000n },
        { token: token1, amount: 1_000_000n },
      ],
      expectedTransfers: [],
      slippageBps: 50,
      maximumGasCostUsd: 0.01,
      depositUsd: 25,
    },
    openedAt: obs.state.observedAt,
    updatedAt: obs.state.observedAt,
    status: 'open',
    entryTxHash: '0x' + 'b'.repeat(64),
    lastAction: 'open',
    outOfRangeSince: null,
    claimed0: 0n,
    claimed1: 0n,
    realizedPnlUsd: null,
    normalization: { status: 'not-required', targetToken: obs.state.token1.address, attempts: 0, lastError: null },
    closeReason: null,
    ...overrides,
  };
}

// ─── historicalRejections ─────────────────────────────────────

test('historicalRejections emits POSITION_CAPACITY + DUPLICATE_EXPOSURE + DUPLICATE_TOKEN_EXPOSURE when 3 positions exist for the same pool', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const now = obs.state.observedAt;
  const codes = historicalRejections(candidate, obs, {
    version: 1,
    positions: [
      { ...makeLivePosition(), id: 'a' },
      { ...makeLivePosition(), id: 'b' },
      { ...makeLivePosition(), id: 'c' },
    ],
    transactions: [],
    cooldowns: {},
    blacklist: {},
    lessons: [],
    dailyRealizedLossUsd: {},
  }, DEFAULT_POLICY, now);
  const set = new Set(codes.map((c) => c.code));
  assert.ok(set.has('POSITION_CAPACITY'));
  assert.ok(set.has('DUPLICATE_EXPOSURE'));
  assert.ok(set.has('DUPLICATE_TOKEN_EXPOSURE'));
});

test('historicalRejections emits POOL_COOLDOWN when pool is in cooldown', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const now = obs.state.observedAt;
  const codes = historicalRejections(candidate, obs, {
    version: 1,
    positions: [],
    transactions: [],
    cooldowns: { [poolIdOf()]: now + 3600 },
    blacklist: {},
    lessons: [],
    dailyRealizedLossUsd: {},
  }, DEFAULT_POLICY, now);
  assert.ok(codes.some((c) => c.code === 'POOL_COOLDOWN'));
});

test('historicalRejections ignores trusted quote blacklist entries', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const now = obs.state.observedAt + 100;
  const codes = historicalRejections(candidate, obs, {
    version: 1,
    positions: [],
    transactions: [],
    cooldowns: {},
    blacklist: { [tokenKey(1)]: { until: now + 3600, reason: 'honeypot detected' } },
    lessons: [],
    dailyRealizedLossUsd: {},
  }, DEFAULT_POLICY, now);
  assert.equal(codes.some((c) => c.code === 'TOKEN_BLACKLISTED'), false);
});

test('historicalRejections still rejects a blacklisted candidate asset', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const now = obs.state.observedAt + 100;
  const codes = historicalRejections(candidate, obs, {
    version: 1, positions: [], transactions: [], cooldowns: {},
    blacklist: { [tokenKey(0)]: { until: now + 3600, reason: 'candidate risk' } },
    lessons: [], dailyRealizedLossUsd: {},
  }, DEFAULT_POLICY, now);
  assert.ok(codes.some((c) => c.code === 'TOKEN_BLACKLISTED'));
});

test('historicalRejections emits DAILY_LOSS_LIMIT when daily realized loss is at cap', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const now = obs.state.observedAt;
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const codes = historicalRejections(candidate, obs, {
    version: 1,
    positions: [],
    transactions: [],
    cooldowns: {},
    blacklist: {},
    lessons: [],
    dailyRealizedLossUsd: { [day]: DEFAULT_POLICY.maximumDailyLossUsd + 1 },
  }, DEFAULT_POLICY, now);
  assert.ok(codes.some((c) => c.code === 'DAILY_LOSS_LIMIT'));
});

// ─── recordClosedOutcome ─────────────────────────────────────

test('recordClosedOutcome applies pool cooldown + blacklist on risk-exit', () => {
  const obs = demoObservations()[0]!;
  const now = obs.state.observedAt;
  const state = {
    version: 1 as const,
    positions: [{ ...makeLivePosition(), id: 'p' }],
    transactions: [],
    cooldowns: {} as Record<string, number>,
    blacklist: {} as Record<string, { until: number; reason: string }>,
    lessons: [] as Array<{ at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string }>,
    dailyRealizedLossUsd: {} as Record<string, number>,
  };
  recordClosedOutcome(state, obs, 'p', 'HONEYPOT detected on exit', now, DEFAULT_POLICY, null);
  assert.ok(state.cooldowns[poolIdOf()]! > now);
  assert.equal(state.blacklist[tokenKey(0)].reason, 'HONEYPOT detected on exit');
  assert.equal(state.blacklist[tokenKey(1)], undefined);
  assert.equal(state.lessons[0]!.outcome, 'risk-exit');
});

test('recordClosedOutcome applies pool cooldown + blacklist on loss + accumulates daily loss', () => {
  const obs = demoObservations()[0]!;
  const now = obs.state.observedAt;
  const state = {
    version: 1 as const,
    positions: [{ ...makeLivePosition(), id: 'p' }],
    transactions: [],
    cooldowns: {} as Record<string, number>,
    blacklist: {} as Record<string, { until: number; reason: string }>,
    lessons: [] as Array<{ at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string }>,
    dailyRealizedLossUsd: {} as Record<string, number>,
  };
  recordClosedOutcome(state, obs, 'p', 'market down', now, DEFAULT_POLICY, -10);
  assert.ok(state.cooldowns[poolIdOf()]! > now);
  assert.equal(state.lessons[0]!.outcome, 'loss');
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  assert.equal(state.dailyRealizedLossUsd[day], 10);
});

test('recordClosedOutcome on a winning close does not blacklist tokens', () => {
  const obs = demoObservations()[0]!;
  const now = obs.state.observedAt;
  const state = {
    version: 1 as const,
    positions: [{ ...makeLivePosition(), id: 'p' }],
    transactions: [],
    cooldowns: {} as Record<string, number>,
    blacklist: {} as Record<string, { until: number; reason: string }>,
    lessons: [] as Array<{ at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string }>,
    dailyRealizedLossUsd: {} as Record<string, number>,
  };
  recordClosedOutcome(state, obs, 'p', 'profit take', now, DEFAULT_POLICY, 5);
  assert.equal(state.blacklist[tokenKey(0)], undefined);
  assert.equal(state.lessons[0]!.outcome, 'win');
});

test('FAR_ABOVE_RANGE close within the configured loss grace does not blacklist the token', () => {
  const obs = demoObservations()[0]!;
  const now = obs.state.observedAt;
  const state = {
    version: 1 as const, positions: [{ ...makeLivePosition(), id: 'p' }], transactions: [], cooldowns: {} as Record<string, number>,
    blacklist: {} as Record<string, { until: number; reason: string }>,
    lessons: [] as Array<{ at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string }>,
    dailyRealizedLossUsd: {} as Record<string, number>,
  };
  recordClosedOutcome(state, obs, 'p', 'FAR_ABOVE_RANGE', now, DEFAULT_POLICY, -0.2);
  assert.equal(state.blacklist[tokenKey(0)], undefined);
  assert.equal(state.blacklist[tokenKey(1)], undefined);
});

test('FAR_ABOVE_RANGE close beyond the configured loss grace still blacklists the token', () => {
  const obs = demoObservations()[0]!;
  const now = obs.state.observedAt;
  const state = {
    version: 1 as const, positions: [{ ...makeLivePosition(), id: 'p' }], transactions: [], cooldowns: {} as Record<string, number>,
    blacklist: {} as Record<string, { until: number; reason: string }>,
    lessons: [] as Array<{ at: number; chainId: ChainId; poolIdentity: string; outcome: 'win' | 'loss' | 'risk-exit'; pnlUsd: number | null; reason: string }>,
    dailyRealizedLossUsd: {} as Record<string, number>,
  };
  recordClosedOutcome(state, obs, 'p', 'FAR_ABOVE_RANGE', now, DEFAULT_POLICY, -1);
  assert.ok(Object.keys(state.blacklist).length > 0);
});

// ─── liveManagementDecision ───────────────────────────────────

test('liveManagementDecision returns one of the allowed actions for an accepted observation', () => {
  const obs = demoObservations()[0]!;
  const decision = liveManagementDecision(makeLivePosition(), obs, DEFAULT_POLICY, obs.state.observedAt);
  assert.ok(
    ['hold', 'pause', 'close', 'rebalance', 'claim', 'emergency-close'].includes(decision.action),
    `unexpected action: ${decision.action}`,
  );
});

test('FAR_ABOVE_RANGE normalizes inverted human quote/base boundaries', () => {
  const range = normalizeHumanRange(0.05509, 0.02769);
  assert.deepEqual(range, { lower: 0.02769, upper: 0.05509 });
  assert.equal(0.05547 >= range.upper * 1.10, false);
  assert.equal(0.061 >= range.upper * 1.10, true);
});
test('canonical PnL uses percentage points exactly once', () => {
  assert.ok(Math.abs(pnlPctFromValues(100.0416, 100)! - 0.0416) < 1e-10);
  assert.equal(pnlPctFromValues(100.0416, 100)! < 5, true);
  assert.ok(Math.abs(pnlPctFromValues(90, 100)! + 10) < 1e-10);
  assert.equal(pnlPctFromValues(100.0416, 0), null);
});

test('primary-stable quote-only positions use live principal as their PnL baseline', () => {
  const stable = '0x0000000000000000000000000000000000000001';
  const token = '0x0000000000000000000000000000000000000002';
  assert.equal(isPrimaryStableQuoteOnly({ token0Address: token, token1Address: stable, amount0: 0n, amount1: 9_676_100n, primaryStable: stable }), true);
  const baseline = effectivePnlDepositUsd({ persistedDepositUsd: 9.83767, principalValueUsd: 9.6761,
    token0Address: token, token1Address: stable, amount0: 0n, amount1: 9_676_100n, primaryStable: stable });
  assert.equal(baseline, 9.6761);
  assert.equal(pnlPctFromValues(9.6761, baseline), 0);
});

test('post-mint entry principal overrides the transfer budget for every PnL consumer', () => {
  const baseline = effectivePnlDepositUsd({
    persistedDepositUsd: 9.97794,
    entryPrincipalUsd: 9.803367,
    principalValueUsd: 9.803367,
  });
  assert.equal(baseline, 9.803367);
  assert.ok(Math.abs(pnlPctFromValues(9.803367 + 0.000351908, baseline)! - 0.00358966) < 1e-7);
  assert.ok(Math.abs(pnlPctFromValues(9.803367, baseline)!) < 1e-12);
});

test('close notification uses canonical fee-inclusive management PnL instead of a mismatched receipt fallback', () => {
  const obs = demoObservations()[0]!;
  const position = makeLivePosition({ entryPrincipalUsd: 20 });
  const canonical = closeNotificationPnlPct(position, obs, DEFAULT_POLICY, obs.state.observedAt, -1);
  assert.notEqual(canonical, null);
  assert.notEqual(canonical, -5);
  assert.equal(closeNotificationPnlPct(position, obs, DEFAULT_POLICY, obs.state.observedAt, -1), canonical);
});

test('liveManagementDecision refuses claim when lifecycle cost is null (fail-closed)', () => {
  const obs = demoObservations()[0]!;
  obs.estimatedLifecycleCostUsd = null;
  const decision = liveManagementDecision(
    makeLivePosition({ openedAt: obs.state.observedAt - 100 }),
    obs,
    DEFAULT_POLICY,
    obs.state.observedAt,
  );
  assert.notEqual(decision.action, 'claim');
});

test('liveManagementDecision closes after the out-of-range timeout', () => {
  const obs = demoObservations()[0]!;
  // Force the observation tick to be well outside the planned range so
  // Use a tick outside tickLower/tickUpper = [-100, 100).
  obs.state.tick = -200;
  const position = makeLivePosition({
    outOfRangeSince: obs.state.observedAt - DEFAULT_POLICY.outOfRangeTimeoutSeconds - 100,
  });
  const decision = liveManagementDecision(position, obs, DEFAULT_POLICY, obs.state.observedAt);
  assert.equal(decision.action, 'close');
  assert.equal(decision.reason, 'OUT_OF_RANGE_TIMEOUT');
});

// ─── LiveExecutor PnL decoding ────────────────────────────────

test('ERC20 Transfer event signature decodes correctly through the executor path', () => {
  const data = encodeTransferData(1_000_000n);
  const topics = transferTopics(
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
    zeroAddress,
    '0x1111111111111111111111111111111111111111' as Address,
  );
  const log = {
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
    blockHash: null,
    blockNumber: null,
    data,
    logIndex: 0,
    transactionHash: null,
    removed: false,
    topics,
  };
  const decoded = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics });
  assert.equal(decoded.eventName, 'Transfer');
  assert.equal((decoded.args as { value: bigint }).value, 1_000_000n);
});

test('close receipt decoding uses token contract as key and Transfer recipient as wallet filter', () => {
  const wallet = '0x1111111111111111111111111111111111111111' as Address;
  const wrong = '0x2222222222222222222222222222222222222222' as Address;
  const token0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const token1 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
  const log = (token: Address, to: Address, value: bigint, data = encodeTransferData(value)) => ({
    address: token, blockHash: null, blockNumber: null, data, logIndex: 0, transactionHash: null, removed: false,
    topics: transferTopics(token, zeroAddress, to),
  });
  const receipt = { logs: [log(token0, wallet, 10n), log(token0, wallet, 5n), log(token1, wrong, 99n),
    log('0xcccccccccccccccccccccccccccccccccccccccc' as Address, wallet, 77n),
    { ...log(token1, wallet, 1n), topics: ['0x1234' as Hex] }] };
  const received = decodeIncomingErc20Transfers(receipt as never, wallet, [token0, token1]);
  assert.equal(received.get(token0), 15n);
  assert.equal(received.get(token1), undefined);
  assert.equal(received.size, 1);
});

test('STOPPED state suppresses safety close and normalization writes', async () => {
  const observation = demoObservations()[0]!;
  observation.risks[0]!.honeypot = true;
  const position = makeLivePosition();
  const state = { version: 1 as const, positions: [position], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {} };
  const controls: Controls = { globalPaused: true, pausedChains: [position.chainId], botState: 'STOPPED' };
  let saves = 0, closeCalls = 0, normalizeCalls = 0, normalizationFails = true;
  const repo = { async controls() { return controls; }, async setControls() {}, async strategyState() { return state; },
    async setStrategyState() { saves++; }, async initialize() {}, async saveRun() {}, async latest() { return null; }, async history() { return []; }, async findRunById() { return null; }, async close() {} } as unknown as Repository;
  const signer = {
    async close(value: LivePosition) {
      closeCalls++;
      return { value: { ...value, status: 'closed' as const, closeTxHash: '0x' + 'c'.repeat(64) as Hex,
        normalization: { status: 'pending' as const, targetToken: observation.state.token1.address, attempts: 0, lastError: null } }, transactions: [] };
    },
    async normalize(value: LivePosition) {
      normalizeCalls++;
      if (normalizationFails) throw new Error('RELAY_DOWN');
      return { value: { ...value, normalization: { ...value.normalization, status: 'complete' as const, attempts: value.normalization.attempts + 1, lastError: null } }, transactions: [] };
    },
  };
  const agent = new Agent(DEFAULT_POLICY, repo, undefined, signer as never);
  agent.observePoolLightweight = async () => observation;
  await agent.manageLive(observation.state.observedAt);
  assert.equal(closeCalls, 0); assert.equal(state.positions[0]!.status, 'open');
  assert.equal(state.positions[0]!.normalization.status, 'not-required');
  assert.ok(saves >= 0);
  controls.botState = 'STOPPED';
  normalizationFails = false;
  await agent.manageLive(observation.state.observedAt + 1);
  assert.equal(normalizeCalls, 0); assert.equal(state.positions[0]!.normalization.status, 'not-required');
  await agent.manageLive(observation.state.observedAt + 2);
  assert.equal(normalizeCalls, 0, 'STOPPED must never normalize');
});

test('close reconciliation detects zero liquidity and burned V3 NFT without a second transaction', async () => {
  const position = makeLivePosition();
  let reads = 0;
  const zero = await inspectCloseLiquidity({ async readContract() {
    reads++;
    return [0n, zeroAddress, zeroAddress, 0, 0, 0, 0, 0n] as const;
  } }, position);
  assert.deepEqual(zero, { liquidity: 0n, missing: false });
  const missing = await inspectCloseLiquidity({ async readContract() {
    reads++;
    throw new Error('Invalid token ID');
  } }, position);
  assert.deepEqual(missing, { liquidity: 0n, missing: true });
  assert.equal(reads, 2);
  const recovered = reconcileClosedWithoutReceipt({ ...position, status: 'closing', closeReason: 'TAKE_PROFIT' }, 123);
  assert.equal(recovered.status, 'closed'); assert.equal(recovered.realizedPnlUsd, null);
  assert.equal(recovered.normalization.status, 'blocked'); assert.match(recovered.normalization.lastError ?? '', /RECEIPT_UNAVAILABLE/);
});

test('stale CLOSING without broadcast evidence is reconciled back to OPEN without retry', async () => {
  const observation = demoObservations()[0]!;
  observation.risks[0]!.honeypot = true;
  const position = makeLivePosition();
  const state = { version: 1 as const, positions: [position], transactions: [], cooldowns: {}, blacklist: {}, lessons: [], dailyRealizedLossUsd: {} };
  const controls: Controls = { globalPaused: false, pausedChains: [], botState: 'RUNNING' };
  let saves = 0, closeRequests = 0, decreaseTransactions = 0, normalizeCalls = 0, simulateCrash = true;
  const repo = { async controls() { return controls; }, async setControls() {}, async strategyState() { return state; },
    async setStrategyState() { saves++; }, async initialize() {}, async saveRun() {}, async latest() { return null; }, async history() { return []; }, async findRunById() { return null; }, async close() {} } as unknown as Repository;
  const signer = {
    async close(value: LivePosition) {
      closeRequests++;
      if (simulateCrash) { decreaseTransactions++; throw new Error('CONNECTION_LOST_AFTER_CONFIRMED_CLOSE'); }
      assert.equal(value.status, 'closing');
      return { value: { ...value, status: 'closed' as const, realizedPnlUsd: null, claimed0: 0n, claimed1: 0n,
        normalization: { status: 'blocked' as const, targetToken: observation.state.token1.address, attempts: 0,
          lastError: 'CLOSE_RECEIPT_UNAVAILABLE_REVIEW_REQUIRED' } }, transactions: [] };
    },
    async normalize() { normalizeCalls++; throw new Error('must not normalize blocked recovery'); },
  };
  const agent = new Agent(DEFAULT_POLICY, repo, undefined, signer as never);
  agent.observePoolLightweight = async () => observation;
  await agent.manageLive(observation.state.observedAt);
  assert.equal(state.positions[0]!.status, 'open');
  assert.equal(closeRequests, 0);
  assert.equal(decreaseTransactions, 0);
  assert.ok(saves >= 1);
  assert.equal(normalizeCalls, 0);
});

// ─── analysisContext enrichment ───────────────────────────────

test('contextFromRetrievedCandidate pulls risks out of the matching observation', () => {
  const obs = demoObservations()[0]!;
  const candidate = makeApprovedCandidate();
  const ctx: AnalysisContext | null = contextFromRetrievedCandidate(
    {
      run: { id: 'r1', startedAt: obs.state.observedAt - 100, finishedAt: obs.state.observedAt, mode: 'live-readonly', status: 'ok' },
      chainId: candidate.pool.chainId,
      chainName: 'TestChain',
      candidate,
    },
    {
      id: 'r1',
      mode: 'live-readonly',
      startedAt: obs.state.observedAt - 100,
      finishedAt: obs.state.observedAt,
      configVersion: 'paper-policy-1',
      deploymentVersion: 'test',
      policy: {},
      observations: [obs],
      candidates: [candidate],
      discoveries: [],
      decisions: [],
      positions: [],
      health: [],
      providerObservations: [],
      errors: [],
      status: 'ok',
    },
  );
  assert.ok(ctx);
  assert.ok(ctx!.risks.length > 0);
});

// ─── invariants ──────────────────────────────────────────────

test('LivePosition invariants: status open implies tokenId > 0n', () => {
  const p = makeLivePosition();
  assert.equal(p.status, 'open');
  assert.ok(p.tokenId > 0n);
});

test('LivePosition invariants: closed positions carry a closeTxHash', () => {
  const p = makeLivePosition({ status: 'closed', closeTxHash: '0x' + 'c'.repeat(64) as Hex });
  assert.equal(p.status, 'closed');
  assert.ok(p.closeTxHash);
});

// ─── helpers ─────────────────────────────────────────────────

function encodeTransferData(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}
function transferTopics(token: Address, from: Address, to: Address): [Hex, Hex, Hex] {
  const sig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const t = (a: Address) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex;
  return [sig as Hex, t(from), t(to)];
}
