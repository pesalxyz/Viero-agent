import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { SignerOperationStore } from '../src/viero/storage/signerOperationStore.js';
import { LiveExecutor } from '../src/viero/execution/executor.js';
import { emptyStrategyState } from '../src/viero/execution/liveState.js';
import { poolIdentity } from '../src/viero/domain.js';
import { repairStrategyProjection } from '../src/viero/storage/projectionRepair.js';

const key = `0x${'11'.repeat(32)}`;
const signer = `0x${'11'.repeat(20)}`;
const pool = { chainId: 4663 as const, protocol: 'v3' as const, dex: 'uniswap' as const, poolAddress: `0x${'22'.repeat(20)}` };

test('startup recovery is READY with a valid empty store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-phase433d-'));
  const executor = new LiveExecutor({ VIERO_SIGNER_PRIVATE_KEY: key, VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: join(root, 'operations.db') });
  try { assert.deepEqual(await executor.startupRecovery(), { state: 'READY', reason: null, unresolved: 0 }); }
  finally { executor.operationStore.close(); await rm(root, { recursive: true, force: true }); }
});

test('startup recovery blocks a signer-identity mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-phase433d-')), db = join(root, 'operations.db');
  const store = new SignerOperationStore(db);
  store.create({ idempotencyKey: 'mismatch', type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: 'a'.repeat(64), signerAddress: `0x${'33'.repeat(20)}`, nonce: null, transactionHash: null });
  store.close();
  const executor = new LiveExecutor({ VIERO_SIGNER_PRIVATE_KEY: key, VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: db });
  try { assert.equal((await executor.startupRecovery()).state, 'BLOCKED'); }
  finally { executor.operationStore.close(); await rm(root, { recursive: true, force: true }); }
});

test('projection repair applies a confirmed close once and preserves normalization', () => {
  const position = { id: `${poolIdentity(pool)}:1`, chainId: 4663 as const, pool, tokenId: 1n, positionManager: `0x${'44'.repeat(20)}`, plan: { depositAssets: [], expectedTransfers: [], pool, mode: 'live', chainId: 4663, createdAt: 1, deadline: 2, sourceBlock: 1n, sourceBlockHash: `0x${'55'.repeat(32)}`, tickLower: 0, tickUpper: 1, liquidity: 1n, poolFee: 100, slippageBps: 50, maximumGasCostUsd: 1, depositUsd: 10 } as any, openedAt: 1, updatedAt: 1, status: 'open' as const, entryTxHash: `0x${'66'.repeat(32)}`, lastAction: 'open' as const, outOfRangeSince: null, claimed0: 0n, claimed1: 0n, realizedPnlUsd: null, normalization: { status: 'pending' as const, targetToken: `0x${'77'.repeat(20)}`, attempts: 0, lastError: null }, closeReason: null };
  const state = { ...emptyStrategyState(), positions: [position] };
  const operation = { schemaVersion: 1 as const, operationId: 'close-op', idempotencyKey: 'close', type: 'CLOSE' as const, chainId: 4663, positionId: position.id, poolIdentity: poolIdentity(pool), requestFingerprint: 'a'.repeat(64), signerAddress: signer, nonce: '1', transactionHash: `0x${'88'.repeat(32)}`, broadcastStatus: 'KNOWN' as const, receipt: { blockHash: `0x${'99'.repeat(32)}`, blockNumber: '9', status: 'success' as const, confirmations: 3 }, finality: 'CONFIRMED' as const, reconciliation: 'COMPLETE' as const, state: 'TERMINAL' as const, createdAt: 1, updatedAt: 9 };
  const once = repairStrategyProjection(state, [operation]);
  const twice = repairStrategyProjection(once.state, [operation]);
  assert.deepEqual(once.applied, ['close-op']); assert.equal(once.state.positions[0]!.status, 'closed'); assert.deepEqual(twice.applied, []); assert.deepEqual(twice.skipped, ['close-op']);
});
