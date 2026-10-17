import { poolIdentity } from '../domain.js';
import { type OperationRecord } from './operationStore.js';
import { type EvidenceHandoffRecord } from './evidenceHandoff.js';
import { type StrategyState } from '../execution/liveState.js';

export type ProjectionRepairResult = { state: StrategyState; applied: string[]; skipped: string[]; blocked: Array<{ operationId: string; reason: string }> };

type ProjectionEvidence = OperationRecord | EvidenceHandoffRecord;
function confirmed(operation: ProjectionEvidence): boolean {
  return operation.state === 'TERMINAL' && operation.broadcastStatus === 'KNOWN' && Boolean(operation.transactionHash)
    && operation.receipt?.status === 'success' && operation.finality === 'CONFIRMED' && operation.reconciliation === 'COMPLETE';
}

/**
 * Apply only receipt-backed, terminal signer evidence to the agent projection.
 * This function never opens the signer database and never authorizes a write.
 */
export function repairStrategyProjection(input: StrategyState, operations: ProjectionEvidence[]): ProjectionRepairResult {
  const state: StrategyState = {
    ...input,
    positions: input.positions.map(position => ({
      ...position,
      plan: {
        ...position.plan,
        depositAssets: position.plan.depositAssets.map(asset => ({ ...asset })),
        expectedTransfers: position.plan.expectedTransfers.map(asset => ({ ...asset })),
      },
    })),
    transactions: [...input.transactions],
  };
  const applied: string[] = [], skipped: string[] = [], blocked: Array<{ operationId: string; reason: string }> = [];
  for (const operation of operations) {
    if (!confirmed(operation)) continue;
    if (!operation.positionId || !operation.poolIdentity || !operation.transactionHash) { blocked.push({ operationId: operation.operationId, reason: 'INCOMPLETE_OPERATION_IDENTITY' }); continue; }
    const position = state.positions.find(item => item.id === operation.positionId);
    if (operation.type === 'OPEN') {
      if (position?.entryTxHash.toLowerCase() === operation.transactionHash.toLowerCase() && poolIdentity(position.pool) === operation.poolIdentity) skipped.push(operation.operationId);
      else blocked.push({ operationId: operation.operationId, reason: 'OPEN_PROJECTION_REQUIRES_COMPLETE_POSITION_EVIDENCE' });
      continue;
    }
    if (!position) { blocked.push({ operationId: operation.operationId, reason: 'POSITION_NOT_FOUND' }); continue; }
    if (poolIdentity(position.pool) !== operation.poolIdentity) { blocked.push({ operationId: operation.operationId, reason: 'POOL_IDENTITY_MISMATCH' }); continue; }
    if (state.transactions.some(transaction => transaction.hash.toLowerCase() === operation.transactionHash!.toLowerCase())) { skipped.push(operation.operationId); continue; }
    if (operation.type === 'CLOSE' || operation.type === 'EMERGENCY_CLOSE') {
      if (position.status === 'closed') { skipped.push(operation.operationId); continue; }
      const index = state.positions.findIndex(item => item.id === position.id);
      state.positions[index] = { ...position, status: 'closed', closeTxHash: operation.transactionHash as `0x${string}`, updatedAt: operation.updatedAt, lastAction: operation.type === 'EMERGENCY_CLOSE' ? 'emergency-close' : 'close', realizedPnlUsd: null, normalization: { ...position.normalization, status: position.normalization.status === 'not-required' ? 'not-required' : 'pending' } };
      state.transactions.push({ id: `recovery:${operation.operationId}`, chainId: operation.chainId as StrategyState['positions'][number]['chainId'], positionId: position.id, action: 'decrease', hash: operation.transactionHash as `0x${string}`, at: operation.updatedAt, status: 'confirmed', blockNumber: operation.receipt?.blockNumber ? BigInt(operation.receipt.blockNumber) : undefined, detail: 'Recovered from signer operation receipt' });
      applied.push(operation.operationId);
      continue;
    }
    if (operation.type === 'CLAIM') {
      state.transactions.push({ id: `recovery:${operation.operationId}`, chainId: operation.chainId as StrategyState['positions'][number]['chainId'], positionId: position.id, action: 'claim', hash: operation.transactionHash as `0x${string}`, at: operation.updatedAt, status: 'confirmed', blockNumber: operation.receipt?.blockNumber ? BigInt(operation.receipt.blockNumber) : undefined, detail: 'Recovered claim from signer operation receipt' });
      applied.push(operation.operationId);
      continue;
    }
    blocked.push({ operationId: operation.operationId, reason: 'OPERATION_TYPE_NOT_PROJECTION_SAFE' });
  }
  return { state, applied, skipped, blocked };
}
