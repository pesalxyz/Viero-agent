import { decodeEventLog, encodeFunctionData, keccak256, maxUint128, maxUint160, zeroAddress, type Address, type Hex, type Log, type TransactionReceipt } from 'viem';
import { randomUUID } from 'node:crypto';
import { erc20ExecutionAbi, erc20TransferEvent, erc721TransferEvent, permit2Abi, v3PositionManagerAbi, v4PositionManagerAbi, wrappedNativeAbi } from '../adapters/abi.js';
import { verifyPool } from '../adapters/pools.js';
import { PublicClients, assertChain } from '../clients/publicClients.js';
import { getChain } from '../config/chains.js';
import { usesSingleSidedQuoteExecution } from '../config/policy.js';
import { poolIdentity, type ChainId, type Observation } from '../domain.js';
import { type Policy } from '../config/policy.js';
import { canonicalPrice } from '../screening/pipeline.js';
import { amount0Delta, amount1Delta, sqrtAtTick, tokenValue } from '../screening/math.js';
import { assertPlanIdentity, refreshFixedRangePlan, type PositionPlan } from './planner.js';
import { UINT128_MAX, v3MintArgs, v4CollectData, v4DecreaseData, v4MintData } from './calldata.js';
import { type ExecutionTransaction, type LivePosition } from './liveState.js';
import { WalletClients } from './walletClients.js';
import { RelayBalancer } from './relay.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SignerOperationStore } from '../storage/signerOperationStore.js';
import { type OperationRecord, type OperationType } from '../storage/operationStore.js';

export type ExecutionResult<T> = { value: T; transactions: ExecutionTransaction[] };
export type SignerRecoveryReadiness = 'READY' | 'RECONCILIATION_REQUIRED' | 'BLOCKED';
export function contractRequestToTransactionRequest(request: any): any {
  if (!request?.address || !request?.abi || !request?.functionName) return request;
  const { address, abi, functionName, args, ...tx } = request;
  return { ...tx, to: address, data: encodeFunctionData({ abi, functionName, args }) };
}
export function decodeIncomingErc20Transfers(receipt: Pick<TransactionReceipt, 'logs'>, recipient: Address,
  allowedTokens?: Iterable<Address>): Map<string, bigint> {
  const out = new Map<string, bigint>(), recipientLc = recipient.toLowerCase();
  const allowed = allowedTokens ? new Set([...allowedTokens].map(token => token.toLowerCase())) : null;
  for (const log of receipt.logs) {
    const token = log.address.toLowerCase();
    if (allowed && !allowed.has(token)) continue;
    try {
      const decoded = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as { to?: Address; value?: bigint };
      if (args.to?.toLowerCase() !== recipientLc || typeof args.value !== 'bigint' || args.value < 0n) continue;
      out.set(token, (out.get(token) ?? 0n) + args.value);
    } catch { /* malformed or unrelated log */ }
  }
  return out;
}

/** Decode ERC20 Transfer events sent by `sender` in a transaction receipt. */
export function decodeOutgoingErc20Transfers(receipt: Pick<TransactionReceipt, 'logs'>, sender: Address,
  allowedTokens?: Iterable<Address>): Map<string, bigint> {
  const out = new Map<string, bigint>(), senderLc = sender.toLowerCase();
  const allowed = allowedTokens ? new Set([...allowedTokens].map(token => token.toLowerCase())) : null;
  for (const log of receipt.logs) {
    const token = log.address.toLowerCase();
    if (allowed && !allowed.has(token)) continue;
    try {
      const decoded = decodeEventLog({ abi: [erc20TransferEvent], data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as { from?: Address; value?: bigint };
      if (args.from?.toLowerCase() !== senderLc || typeof args.value !== 'bigint' || args.value < 0n) continue;
      out.set(token, (out.get(token) ?? 0n) + args.value);
    } catch { /* malformed or unrelated log */ }
  }
  return out;
}

export function isMissingV3PositionError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /invalid token id|nonexistent token|owner query for nonexistent|erc721.*invalid token/i.test(message);
}

/** Validate the quote-only invariant immediately before a V4 mint. */
export function assertFreshV4QuotePlan(plan: PositionPlan, state: Awaited<ReturnType<typeof verifyPool>>): void {
  if (!state.verified) throw new Error('POOL_UNVERIFIED');
  const chain = getChain(plan.chainId);
  const stable = chain.primaryStable.toLowerCase(), wrapped = chain.wrappedNative?.toLowerCase();
  const quote = plan.depositAssets.find(a => a.token.toLowerCase() === stable || a.token.toLowerCase() === wrapped);
  const opposite = plan.depositAssets.find(a => a.token.toLowerCase() !== quote?.token.toLowerCase());
  if (!quote || !opposite || quote.amount <= 0n || opposite.amount !== 0n || plan.liquidity <= 0n) throw new Error('FIXED_RANGE_ZERO_OR_NON_QUOTE_DEPOSIT');
  const quoteIs0 = state.token0.address.toLowerCase() === quote.token.toLowerCase();
  if (!quoteIs0 && state.token1.address.toLowerCase() !== quote.token.toLowerCase()) throw new Error('UNSUPPORTED_QUOTE_ASSET');
  const singleSided = quoteIs0 ? state.tick < plan.tickLower : state.tick >= plan.tickUpper;
  if (!singleSided || plan.tickLower >= plan.tickUpper) throw new Error('FIXED_RANGE_NOT_SINGLE_SIDED_QUOTE');
}

export async function inspectCloseLiquidity(client: { readContract(args: unknown): Promise<unknown> }, position: LivePosition): Promise<{ liquidity: bigint; missing: boolean }> {
  if (position.pool.protocol === 'v4') {
    const liquidity = await client.readContract({ address: position.positionManager, abi: v4PositionManagerAbi,
      functionName: 'getPositionLiquidity', args: [position.tokenId] });
    return { liquidity: liquidity as bigint, missing: false };
  }
  try {
    const raw = await client.readContract({ address: position.positionManager, abi: v3PositionManagerAbi,
      functionName: 'positions', args: [position.tokenId] }) as readonly unknown[];
    return { liquidity: raw[7] as bigint, missing: false };
  } catch (error) {
    if (isMissingV3PositionError(error)) return { liquidity: 0n, missing: true };
    throw error;
  }
}

export function reconcileClosedWithoutReceipt(position: LivePosition, now = Date.now() / 1000): LivePosition {
  return { ...position, status: 'closed', updatedAt: now, realizedPnlUsd: null, claimed0: 0n, claimed1: 0n,
    normalization: { status: 'blocked', targetToken: getChain(position.chainId).primaryStable,
      attempts: position.normalization.attempts, lastError: 'CLOSE_RECEIPT_UNAVAILABLE_REVIEW_REQUIRED' } };
}
export class LiveExecutor {
  readonly publicClients: PublicClients;
  readonly wallets: WalletClients;
  readonly relay: RelayBalancer | null;
  readonly operationStore: SignerOperationStore;
  private readonly env: NodeJS.ProcessEnv;
  private queues = new Map<ChainId, Promise<unknown>>();
  private policy: Policy | null = null;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.publicClients = new PublicClients(env); this.wallets = new WalletClients(env);
    this.operationStore = new SignerOperationStore(env.VIERO_SIGNER_OPERATION_STORE ?? '/var/lib/viero-signer/operations.db');
    this.relay = env.RELAY_API_KEY ? new RelayBalancer(this.wallets, this.publicClients, env.RELAY_API_KEY,
      env.VIERO_SIGNER_RELAY_OPERATION_STORE ?? '/var/lib/viero-signer/relay-operations.db') : null;
  }
  /**
   * Set the policy reference used for canonical-price validation when
   * computing realized PnL. Optional — when unset, PnL computation falls
   * back to null (still records the close, but no USD-denominated PnL).
   */
  setPolicy(policy: Policy | null) { this.policy = policy; }
  acknowledgePositionProjection(transactionHash: Hex, positionId: string) {
    const operation = this.operationStore.findByTransactionHash(transactionHash);
    if (!operation || !operation.positionEvidence || operation.positionEvidence.positionId !== positionId) throw new Error('PROJECTION_ACK_EVIDENCE_MISMATCH');
    const digest = keccak256(new TextEncoder().encode(JSON.stringify(operation.positionEvidence)) as Uint8Array).slice(2);
    return this.operationStore.acknowledgePositionProjection(operation.operationId, positionId, digest);
  }
  private serialize<T>(chainId: ChainId, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(chainId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.queues.set(chainId, next.finally(() => { if (this.queues.get(chainId) === next) this.queues.delete(chainId); }));
    return next;
  }
  async balances(chainId: ChainId, tokens: Address[]) {
    const client = this.publicClients.get(chainId), owner = this.wallets.account.address;
    const native = await client.getBalance({ address: owner });
    const entries = await Promise.all(tokens.map(async token => [token, await client.readContract({ address: token, abi: erc20ExecutionAbi, functionName: 'balanceOf', args: [owner] })] as const));
    return { native, tokens: new Map(entries) };
  }
  private tx(chainId: ChainId, action: ExecutionTransaction['action'], hash: Hex, receipt: TransactionReceipt, detail: string, positionId?: string): ExecutionTransaction {
    return { id: randomUUID(), chainId, ...(positionId ? { positionId } : {}), action, hash, at: Date.now() / 1000,
      status: receipt.status === 'success' ? 'confirmed' : 'failed', blockNumber: receipt.blockNumber, detail };
  }
  private async write(chainId: ChainId, request: any, type: OperationType = 'OPEN', positionId: string | null = null, poolIdentityValue: string | null = null, context: Record<string, unknown> | null = null) {
    const wallet = this.wallets.get(chainId);
    // Never delegate signing to the RPC (eth_sendTransaction). Prepare and
    // sign locally with the configured private-key account, then submit only
    // the serialized transaction through eth_sendRawTransaction.
    // simulateContract returns a contract-write request (address/abi/functionName/args),
    // while transaction preparation requires a raw request (to/data). Encode it here
    // so every approve/mint/close/normalization write signs the exact simulated call.
    const rawRequest = contractRequestToTransactionRequest(request);
    const fingerprint = keccak256(new TextEncoder().encode(canonicalRequest(rawRequest)) as Uint8Array).slice(2);
    const idempotencyKey = `${chainId}:${type}:${fingerprint}`;
    if (type === 'OPEN' && this.operationStore.unacknowledgedOpenOperations().length) throw new Error('OPEN_PROJECTION_ACK_REQUIRED');
    const existing = this.operationStore.createExclusive({ idempotencyKey, type, chainId, positionId, poolIdentity: poolIdentityValue,
      requestFingerprint: fingerprint, signerAddress: this.wallets.account.address, nonce: null, transactionHash: null, context });
    let prepared: any;
    try {
      prepared = await wallet.prepareTransactionRequest({ ...rawRequest, account: this.wallets.account });
      if (prepared.nonce === undefined) throw new Error('NONCE_UNAVAILABLE');
      this.operationStore.reserveNonce(existing.operationId, String(prepared.nonce));
    } catch (error) {
      if (this.operationStore.get(existing.operationId)?.state === 'PREPARED') this.operationStore.transition(existing.operationId, 'PREPARED', 'BLOCKED', { reconciliation: 'REQUIRED' });
      throw error;
    }
    let serialized: Hex;
    try {
      serialized = await this.wallets.account.signTransaction(prepared as any);
      const signedHash = keccak256(serialized);
      this.operationStore.transition(existing.operationId, 'PREPARED', 'SIGNED', { transactionHash: signedHash, broadcastStatus: 'NOT_ATTEMPTED' });
    } catch (error) {
      if (this.operationStore.get(existing.operationId)?.state === 'PREPARED') this.operationStore.transition(existing.operationId, 'PREPARED', 'BLOCKED', { reconciliation: 'REQUIRED' });
      throw error;
    }
    let hash: Hex;
    try {
      hash = await this.publicClients.get(chainId).sendRawTransaction({ serializedTransaction: serialized });
    } catch (error) {
      this.operationStore.transition(existing.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN' });
      this.journal({ status: 'broadcast-unknown', chainId, operationId: existing.operationId, at: Date.now() / 1000 });
      throw new Error(`BROADCAST_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The hash is committed before any receipt request. A storage failure here
    // is fatal and must never result in an automatic second submission.
    this.operationStore.transition(existing.operationId, 'SIGNED', 'BROADCAST_KNOWN', { transactionHash: hash, broadcastStatus: 'KNOWN' });
    this.journal({ status: 'broadcast', chainId, operationId: existing.operationId, hash, at: Date.now() / 1000 });
    this.operationStore.transition(existing.operationId, 'BROADCAST_KNOWN', 'RECEIPT_PENDING');
    let receipt: TransactionReceipt;
    try {
      receipt = await this.publicClients.get(chainId).waitForTransactionReceipt({ hash, confirmations: getChain(chainId).confirmations, timeout: 180_000 });
    } catch (error) {
      this.journal({ status: 'receipt-pending', chainId, operationId: existing.operationId, hash, at: Date.now() / 1000 });
      throw error;
    }
    const evidence = { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), status: receipt.status === 'success' ? 'success' as const : 'reverted' as const, confirmations: getChain(chainId).confirmations };
    if (receipt.status !== 'success') {
      this.operationStore.transition(existing.operationId, 'RECEIPT_PENDING', 'FAILED', { receipt: evidence, finality: 'CONFIRMED', reconciliation: 'COMPLETE' });
      this.operationStore.transition(existing.operationId, 'FAILED', 'TERMINAL');
      throw new Error('EXECUTION_TRANSACTION_REVERTED');
    }
    this.operationStore.transition(existing.operationId, 'RECEIPT_PENDING', 'CONFIRMED', { receipt: evidence, finality: 'CONFIRMED', reconciliation: 'COMPLETE' });
    if (type === 'OPEN' && context?.kind === 'MINT') {
      const manager = String(context.positionManager) as Address;
      const tokenId = this.mintedTokenId(receipt, manager);
      this.operationStore.recordPositionEvidence(existing.operationId, { ...context, positionId: `${String(context.poolIdentity)}:${tokenId.toString()}`, tokenId: tokenId.toString(), entryTxHash: hash });
    }
    this.operationStore.transition(existing.operationId, 'CONFIRMED', 'TERMINAL');
    this.journal({ status: 'confirmed', chainId, operationId: existing.operationId, hash, blockNumber: receipt.blockNumber.toString(), receiptStatus: receipt.status, at: Date.now() / 1000 });
    return { hash, receipt };
  }
  private journal(record: Record<string, unknown>) {
    try {
      const file = this.env.VIERO_SIGNER_TX_JOURNAL ?? '/var/lib/viero-signer/transactions.jsonl';
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) { console.error(`[viero.execution] transaction journal write failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** Reconcile only durable operations; this method never signs or submits. */
  async reconcileDurableOperations(chainId: ChainId): Promise<OperationRecord[]> {
    return this.serialize(chainId, async () => {
      const client = this.publicClients.get(chainId);
      const transition = (operationId: string, expected: any, next: any, patch: any = {}) => {
        try { return this.operationStore.transition(operationId, expected, next, patch); }
        catch (error) {
          // A concurrent signer process may have won the compare-and-set. This
          // is not a safety failure: re-read durable state and let the winner
          // own reconciliation; unresolved state still gates readiness.
          if (error instanceof Error && error.message === 'OPERATION_COMPARE_AND_SET_FAILED') return this.operationStore.get(operationId);
          throw error;
        }
      };
      for (const operation of this.operationStore.unresolved().filter(item => item.chainId === chainId)) {
        if (!operation.transactionHash) {
          if (operation.state === 'BROADCAST_UNKNOWN') transition(operation.operationId, 'BROADCAST_UNKNOWN', 'RECONCILIATION_REQUIRED', { reconciliation: 'REQUIRED' });
          continue;
        }
        let receipt: TransactionReceipt;
        try {
          receipt = await client.waitForTransactionReceipt({ hash: operation.transactionHash as Hex, confirmations: getChain(chainId).confirmations, timeout: 1_000 });
        } catch { continue; }
        const evidence = { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), status: receipt.status === 'success' ? 'success' as const : 'reverted' as const, confirmations: getChain(chainId).confirmations };
        const current = this.operationStore.get(operation.operationId);
        if (!current) continue;
        if (current.state === 'SIGNED') {
          transition(operation.operationId, 'SIGNED', 'BROADCAST_UNKNOWN', { broadcastStatus: 'UNKNOWN', reconciliation: 'REQUIRED' });
        }
        const afterSigned = this.operationStore.get(operation.operationId);
        if (!afterSigned) continue;
        if (afterSigned.state === 'CONFIRMED') {
          if (receipt.status === 'success' && afterSigned.receipt?.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
            && afterSigned.receipt.blockNumber === receipt.blockNumber.toString()) transition(operation.operationId, 'CONFIRMED', 'TERMINAL', { finality: 'CONFIRMED', reconciliation: 'COMPLETE' });
          else transition(operation.operationId, 'CONFIRMED', 'RECONCILIATION_REQUIRED', { finality: 'REORG_SUSPECTED', reconciliation: 'REQUIRED' });
          continue;
        }
        if (afterSigned.state === 'RECONCILIATION_REQUIRED' && afterSigned.finality === 'REORG_SUSPECTED') continue;
        if (afterSigned.state === 'BROADCAST_UNKNOWN') transition(operation.operationId, 'BROADCAST_UNKNOWN', 'RECEIPT_PENDING', { reconciliation: 'IN_PROGRESS' });
        else if (afterSigned.state === 'BROADCAST_KNOWN' || afterSigned.state === 'RECONCILIATION_REQUIRED') transition(operation.operationId, afterSigned.state, 'RECEIPT_PENDING', { reconciliation: 'IN_PROGRESS' });
        const pending = this.operationStore.get(operation.operationId);
        if (!pending || pending.state !== 'RECEIPT_PENDING') continue;
        transition(operation.operationId, 'RECEIPT_PENDING', receipt.status === 'success' ? 'CONFIRMED' : 'FAILED', { receipt: evidence, finality: 'CONFIRMED', reconciliation: 'COMPLETE' });
        const settled = this.operationStore.get(operation.operationId);
        if (settled?.state === 'CONFIRMED') transition(operation.operationId, 'CONFIRMED', 'TERMINAL');
        else if (settled?.state === 'FAILED') transition(operation.operationId, 'FAILED', 'TERMINAL');
      }
      // Advance only durable, receipt-backed V3 close steps. This never signs
      // or submits; the next close request still performs fresh identity and
      // authorization checks before collecting.
      for (const workflow of this.operationStore.closeWorkflows().filter(item => item.chainId === chainId && item.state !== 'COMPLETE')) {
        const related = this.operationStore.all().filter(item => item.context?.workflowId === workflow.workflowId && item.state === 'TERMINAL' && item.receipt?.status === 'success');
        const removed = related.find(item => item.context?.step === 'remove');
        const collected = related.find(item => item.context?.step === 'collect');
        if (collected) this.operationStore.updateCloseWorkflow(workflow.workflowId, { removeOperationId: removed?.operationId ?? workflow.removeOperationId, collectOperationId: collected.operationId, state: 'COMPLETE' });
        else if (removed) this.operationStore.updateCloseWorkflow(workflow.workflowId, { removeOperationId: removed.operationId, state: 'REMOVE_CONFIRMED' });
      }
      return this.operationStore.unresolved().filter(item => item.chainId === chainId);
    });
  }
  async startupRecovery(): Promise<{ state: SignerRecoveryReadiness; reason: string | null; unresolved: number }> {
    try {
      this.operationStore.validate(this.wallets.account.address);
      const chains = [...new Set(this.operationStore.unresolved().map(operation => operation.chainId as ChainId))];
      for (const chainId of chains) await this.reconcileDurableOperations(chainId);
      const unresolved = this.operationStore.unresolved();
      // A mint can reach a confirmed receipt before its ERC-721 token ID and
      // complete position are projected by the agent. In that crash window,
      // treating the terminal transaction as startup-ready could authorize a
      // second mint. Keep the signer closed until independent recovery proves
      // the missing position identity; a receipt alone is insufficient.
      // Auxiliary approvals/wraps use the legacy OPEN type but have no pool
      // identity. A real mint always carries its canonical pool identity.
      const incompleteOpens = this.operationStore.all().filter(operation => operation.type === 'OPEN'
        && operation.poolIdentity && operation.state === 'TERMINAL'
        && operation.receipt?.status === 'success' && (!operation.positionId || !operation.positionEvidence || !operation.projectionAckAt));
      if (incompleteOpens.length) return { state: 'RECONCILIATION_REQUIRED', reason: 'UNPROJECTED_OPEN_IDENTITY',
        unresolved: unresolved.length + incompleteOpens.length };
      const incompleteCloses = this.operationStore.closeWorkflows().filter(workflow => workflow.state !== 'COMPLETE');
      if (incompleteCloses.length) return { state: 'RECONCILIATION_REQUIRED', reason: 'V3_CLOSE_STEP_RECONCILIATION_REQUIRED', unresolved: unresolved.length + incompleteCloses.length };
      return { state: unresolved.length ? 'RECONCILIATION_REQUIRED' : 'READY', reason: unresolved.length ? 'UNRESOLVED_OPERATION_EVIDENCE' : null, unresolved: unresolved.length };
    } catch (error) {
      return { state: 'BLOCKED', reason: error instanceof Error ? error.message : String(error), unresolved: this.operationStore.unresolved().length };
    }
  }
  private async approveErc20(chainId: ChainId, token: Address, spender: Address, amount: bigint, transactions: ExecutionTransaction[]) {
    const client = this.publicClients.get(chainId), owner = this.wallets.account.address;
    const allowance = await client.readContract({ address: token, abi: erc20ExecutionAbi, functionName: 'allowance', args: [owner, spender] });
    if (allowance >= amount) return;
    for (const value of allowance > 0n ? [0n, amount] : [amount]) {
      const simulation = await client.simulateContract({ account: owner, address: token, abi: erc20ExecutionAbi, functionName: 'approve', args: [spender, value] });
      const sent = await this.write(chainId, simulation.request);
      transactions.push(this.tx(chainId, 'approve', sent.hash, sent.receipt, `Exact ERC20 allowance for ${spender}`));
    }
  }
  private mintedTokenId(receipt: TransactionReceipt, manager: Address) {
    const managerLc = manager.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== managerLc) continue;
      try {
        const decoded = decodeEventLog({ abi: [erc721TransferEvent], data: log.data, topics: log.topics });
        if (decoded.eventName === 'Transfer' && decoded.args.from === zeroAddress && decoded.args.to.toLowerCase() === this.wallets.account.address.toLowerCase()) return decoded.args.tokenId;
      } catch { /* unrelated log */ }
    }
    throw new Error('MINT_TOKEN_ID_NOT_FOUND');
  }
  /**
   * Decode ERC20 Transfer events from a receipt and accumulate amounts
   * sent to `recipient`. Returns a map keyed by token address (lowercase)
   * → total amount received by that recipient in this receipt.
   *
   * Safe: returns an empty map on any decode error rather than throwing,
   * so a single bad log never aborts the calling flow.
   */
  private decodeIncomingTransfers(receipt: TransactionReceipt, recipient: Address): Map<string, bigint> {
    return decodeIncomingErc20Transfers(receipt, recipient);
  }
  private entryPrincipalFromReceipt(plan: PositionPlan, observation: Observation, receipt: TransactionReceipt): number | null {
    if (!this.policy) return null;
    const owner = this.wallets.account.address;
    const allowed = plan.depositAssets.map(asset => asset.token);
    const sent = decodeOutgoingErc20Transfers(receipt, owner, allowed);
    if (!sent.size) return null;
    let total = 0;
    for (const asset of plan.depositAssets) {
      const amount = sent.get(asset.token.toLowerCase()) ?? 0n;
      if (amount <= 0n) continue;
      const token = asset.token.toLowerCase() === observation.state.token0.address.toLowerCase() ? observation.state.token0 : observation.state.token1;
      const price = canonicalPrice(observation.prices, token.address, observation.state.observedAt, this.policy);
      if (!price) return null;
      total += tokenValue(amount, token.decimals, price.usd);
    }
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  /**
   * Compute realized PnL (in USD) for a closed position by comparing
   * the observed close-time prices against the original deposit amounts
   * and the amounts that flowed back to the wallet during the close tx.
   *
   * Returns null when prices are unavailable or any required input is
   * missing. Never throws.
   */
  private computeRealizedPnl(position: LivePosition, observation: Observation, closeTxHash: Hex): Promise<number | null> {
    return this.publicClients.get(position.chainId).getTransactionReceipt({ hash: closeTxHash })
      .then((receipt) => this.realizedPnlFromReceipt(position, observation, receipt))
      .catch(() => null);
  }
  private realizedPnlFromReceipt(position: LivePosition, observation: Observation, receipt: TransactionReceipt): number | null {
    const policy = this.policy;
    const t0 = observation.state.token0;
    const t1 = observation.state.token1;
    // Older quote-only positions may not have the post-mint entryPrincipalUsd
    // baseline. Their persisted transfer budget is not a reliable realized
    // cost basis (the mint can consume less), so a receipt delta must not be
    // classified as a loss or used to blacklist the token. New positions have
    // entryPrincipalUsd and retain exact receipt accounting.
    if (position.entryPrincipalUsd == null || !Number.isFinite(position.entryPrincipalUsd) || position.entryPrincipalUsd <= 0) return null;
    const received = this.decodeIncomingTransfers(receipt, this.wallets.account.address);
    const amount0Received = received.get(t0.address.toLowerCase()) ?? 0n;
    const amount1Received = received.get(t1.address.toLowerCase()) ?? 0n;
    if (received.size === 0) return null;
    if (!policy) return null;
    const now = observation.state.observedAt;
    const p0 = canonicalPrice(observation.prices, t0.address, now, policy);
    const p1 = canonicalPrice(observation.prices, t1.address, now, policy);
    if (!p0 || !p1) return null;
    // New positions persist the operator-selected size as entry principal.
    // Use it as the receipt PnL basis so close accounting matches Telegram
    // and does not drift because tick rounding minted slightly less than the
    // transfer budget.
    const initial = position.entryPrincipalUsd;
    const final = tokenValue(amount0Received, t0.decimals, p0.usd) + tokenValue(amount1Received, t1.decimals, p1.usd);
    if (!Number.isFinite(initial) || !Number.isFinite(final)) return null;
    return final - initial;
  }
  async open(plan: PositionPlan, observation: Observation): Promise<ExecutionResult<LivePosition>> {
    if (plan.mode !== 'live') throw new Error('LIVE_PLAN_REQUIRED');
    return this.serialize(plan.chainId, async () => {
      if (Date.now() / 1000 > plan.deadline) throw new Error('LIVE_PLAN_EXPIRED');
      assertPlanIdentity(plan, observation);
      const chain = getChain(plan.chainId), client = this.publicClients.get(plan.chainId), owner = this.wallets.account.address;
      await assertChain(client, plan.chainId);
      const latest = await verifyPool(client, plan.pool);
      if (!latest.verified) throw new Error('POOL_UNVERIFIED');
      if (usesSingleSidedQuoteExecution(plan.chainId)) Object.assign(plan, refreshFixedRangePlan(plan, latest, observation.prices, this.policy ?? undefined));
      else if (latest.tick < plan.tickLower || latest.tick >= plan.tickUpper) throw new Error('ENTRY_STATE_MOVED_OUTSIDE_PLANNED_RANGE');
      if (usesSingleSidedQuoteExecution(plan.chainId) && plan.pool.protocol === 'v4') assertFreshV4QuotePlan(plan, latest);
      let balances = await this.balances(plan.chainId, plan.depositAssets.map(a => a.token));
      if (balances.native < chain.minimumGasReserve) throw new Error('GAS_RESERVE');
      const transactions: ExecutionTransaction[] = [];
      // Native quote selection is represented by the wrapped token in the
      // PositionManager call. Wrap only the exact shortfall before checking
      // balances; stable-token entries never touch this path.
      if (plan.quoteAsset === 'NATIVE' && chain.wrappedNative) {
        const wrapped = chain.wrappedNative.toLowerCase();
        const nativeAsset = plan.depositAssets.find(asset => asset.token.toLowerCase() === wrapped && asset.amount > 0n);
        const held = nativeAsset ? (balances.tokens.get(nativeAsset.token) ?? 0n) : 0n;
        const shortfall = nativeAsset ? nativeAsset.amount - held : 0n;
        if (shortfall > 0n) {
          if (balances.native < shortfall + chain.minimumGasReserve) throw new Error('INSUFFICIENT_NATIVE_QUOTE_BALANCE');
          const simulation = await client.simulateContract({ account: owner, address: chain.wrappedNative, abi: wrappedNativeAbi, functionName: 'deposit', args: [], value: shortfall });
          const wrappedTx = await this.write(plan.chainId, simulation.request);
          transactions.push(this.tx(plan.chainId, 'wrap', wrappedTx.hash, wrappedTx.receipt, `Wrapped native quote ${shortfall.toString()}`));
          balances = await this.balances(plan.chainId, plan.depositAssets.map(item => item.token));
        }
      }
      for (const asset of plan.depositAssets) {
        const held = balances.tokens.get(asset.token) ?? 0n;
        if (held >= asset.amount) continue;
        if (!this.relay) throw new Error(`ASSET_BALANCE_SHORTFALL:${asset.token}`);
        transactions.push(...await this.relay.acquire(plan, asset.token, asset.amount - held));
        balances = await this.balances(plan.chainId, plan.depositAssets.map(item => item.token));
      }
      for (const asset of plan.depositAssets) if ((balances.tokens.get(asset.token) ?? 0n) < asset.amount) throw new Error(`ASSET_BALANCE_SHORTFALL:${asset.token}`);
      const manager = plan.pool.protocol === 'v3' ? chain.v3[plan.pool.dex]!.positionManager : chain.v4.positionManager;
      if (plan.pool.protocol === 'v3') {
        for (const asset of plan.depositAssets) await this.approveErc20(plan.chainId, asset.token, manager, asset.amount, transactions);
        const args = v3MintArgs(plan, owner);
        const simulation = await client.simulateContract({ account: owner, address: manager, abi: v3PositionManagerAbi, functionName: 'mint', args });
        const sent = await this.write(plan.chainId, simulation.request, 'OPEN', null, poolIdentity(plan.pool), { kind: 'MINT', positionManager: manager, poolIdentity: poolIdentity(plan.pool), plan: JSON.stringify(plan, bigintJson) });
        console.info(`[viero.execution] confirmed mint tx=${sent.hash} chain=${plan.chainId} manager=${manager}`);
        const tokenId = this.mintedTokenId(sent.receipt, manager);
        const id = `${poolIdentity(plan.pool)}:${tokenId}`;
        const durable = this.operationStore.findByTransactionHash(sent.hash);
        if (durable) this.operationStore.annotate(durable.operationId, { positionId: id, poolIdentity: poolIdentity(plan.pool) });
        transactions.push(this.tx(plan.chainId, 'mint', sent.hash, sent.receipt, 'Verified v3 position mint', id));
        return { value: { id, chainId: plan.chainId, pool: plan.pool, tokenId, positionManager: manager, plan, openedAt: Date.now() / 1000,
          updatedAt: Date.now() / 1000, status: 'open', entryTxHash: sent.hash, lastAction: 'open', outOfRangeSince: null,
          entryPrincipalUsd: this.entryPrincipalFromReceipt(plan, observation, sent.receipt),
          claimed0: 0n, claimed1: 0n, realizedPnlUsd: null, peakPnlPct: null, trailingTakeProfitArmed: false,
          normalization: { status: 'not-required', targetToken: chain.primaryStable, attempts: 0, lastError: null }, closeReason: null }, transactions };
      }
      if (plan.pool.poolKey.hooks !== zeroAddress) throw new Error('V4_HOOK_EXECUTION_DISABLED');
      for (const asset of plan.depositAssets) {
        await this.approveErc20(plan.chainId, asset.token, chain.v4.permit2, asset.amount, transactions);
        const permit = await client.readContract({ address: chain.v4.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, asset.token, manager] });
        if (permit[0] < asset.amount || Number(permit[1]) <= Math.floor(plan.deadline)) {
          const simulation = await client.simulateContract({ account: owner, address: chain.v4.permit2, abi: permit2Abi, functionName: 'approve',
            args: [asset.token, manager, asset.amount > maxUint160 ? maxUint160 : asset.amount, Math.floor(plan.deadline + 3600)] });
          const sent = await this.write(plan.chainId, simulation.request);
          transactions.push(this.tx(plan.chainId, 'approve', sent.hash, sent.receipt, 'Permit2 allowance for v4 PositionManager'));
        }
      }
      // Approvals may take a block. Re-read the pool immediately before the
      // mint simulation and rebuild the quote-only plan from the fresh tick.
      // Never submit calldata built from the earlier discovery snapshot.
      if (plan.pool.protocol === 'v4') {
        const beforeMint = await verifyPool(client, plan.pool);
        const priorAssets = plan.depositAssets.map(asset => `${asset.token.toLowerCase()}:${asset.amount.toString()}`).join('|');
        if (usesSingleSidedQuoteExecution(plan.chainId)) {
          Object.assign(plan, refreshFixedRangePlan(plan, beforeMint, observation.prices, this.policy ?? undefined));
          assertFreshV4QuotePlan(plan, beforeMint);
        } else if (beforeMint.tick < plan.tickLower || beforeMint.tick >= plan.tickUpper) {
          throw new Error('ENTRY_STATE_MOVED_OUTSIDE_PLANNED_RANGE');
        }
        const nextAssets = plan.depositAssets.map(asset => `${asset.token.toLowerCase()}:${asset.amount.toString()}`).join('|');
        if (nextAssets !== priorAssets) {
          const finalBalances = await this.balances(plan.chainId, plan.depositAssets.map(asset => asset.token));
          for (const asset of plan.depositAssets) if ((finalBalances.tokens.get(asset.token) ?? 0n) < asset.amount) throw new Error('ENTRY_QUOTE_BALANCE_CHANGED');
          for (const asset of plan.depositAssets) {
            const permit = await client.readContract({ address: chain.v4.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, asset.token, manager] });
            if (permit[0] < asset.amount || Number(permit[1]) <= Math.floor(plan.deadline)) {
              const approval = await client.simulateContract({ account: owner, address: chain.v4.permit2, abi: permit2Abi, functionName: 'approve',
                args: [asset.token, manager, asset.amount > maxUint160 ? maxUint160 : asset.amount, Math.floor(plan.deadline + 3600)] });
              const sent = await this.write(plan.chainId, approval.request);
              transactions.push(this.tx(plan.chainId, 'approve', sent.hash, sent.receipt, 'Refreshed Permit2 allowance for v4 PositionManager'));
            }
          }
        }
      }
      if (Date.now() / 1000 > plan.deadline) throw new Error('LIVE_PLAN_EXPIRED');
      const simulation = await client.simulateContract({ account: owner, address: manager, abi: v4PositionManagerAbi, functionName: 'modifyLiquidities',
        args: [v4MintData(plan, owner), BigInt(Math.floor(plan.deadline))] });
      const sent = await this.write(plan.chainId, simulation.request, 'OPEN', null, poolIdentity(plan.pool), { kind: 'MINT', positionManager: manager, poolIdentity: poolIdentity(plan.pool), plan: JSON.stringify(plan, bigintJson) });
      console.info(`[viero.execution] confirmed mint tx=${sent.hash} chain=${plan.chainId} manager=${manager}`);
      const tokenId = this.mintedTokenId(sent.receipt, manager);
      const id = `${poolIdentity(plan.pool)}:${tokenId}`;
      const durable = this.operationStore.findByTransactionHash(sent.hash);
      if (durable) this.operationStore.annotate(durable.operationId, { positionId: id, poolIdentity: poolIdentity(plan.pool) });
      transactions.push(this.tx(plan.chainId, 'mint', sent.hash, sent.receipt, 'Verified v4 position mint', id));
      return { value: { id, chainId: plan.chainId, pool: plan.pool, tokenId, positionManager: manager, plan, openedAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000, status: 'open', entryTxHash: sent.hash, lastAction: 'open', outOfRangeSince: null,
        entryPrincipalUsd: this.entryPrincipalFromReceipt(plan, observation, sent.receipt),
        claimed0: 0n, claimed1: 0n, realizedPnlUsd: null, peakPnlPct: null, trailingTakeProfitArmed: false,
        normalization: { status: 'not-required', targetToken: chain.primaryStable, attempts: 0, lastError: null }, closeReason: null }, transactions };
    });
  }
  async claim(position: LivePosition): Promise<ExecutionResult<LivePosition>> {
    return this.serialize(position.chainId, async () => {
      const client = this.publicClients.get(position.chainId), owner = this.wallets.account.address, transactions: ExecutionTransaction[] = [];
      let sent: { hash: Hex; receipt: TransactionReceipt };
      if (position.pool.protocol === 'v3') {
        const simulation = await client.simulateContract({ account: owner, address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'collect',
          args: [{ tokenId: position.tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }] });
        sent = await this.write(position.chainId, simulation.request, 'CLAIM', position.id, poolIdentity(position.pool));
        transactions.push(this.tx(position.chainId, 'claim', sent.hash, sent.receipt, 'Collected v3 fees', position.id));
      } else {
        const simulation = await client.simulateContract({ account: owner, address: position.positionManager, abi: v4PositionManagerAbi, functionName: 'modifyLiquidities',
          args: [v4CollectData(position.plan, position.tokenId, owner), BigInt(Math.floor(Date.now() / 1000 + 120))] });
        sent = await this.write(position.chainId, simulation.request, 'CLAIM', position.id, poolIdentity(position.pool));
        transactions.push(this.tx(position.chainId, 'claim', sent.hash, sent.receipt, 'Collected v4 fees', position.id));
      }
      const received = this.decodeIncomingTransfers(sent.receipt, owner);
      const tokens = position.plan.pool.protocol === 'v3'
        ? [(position.plan.pool as { poolAddress: string }).poolAddress]
        : [(position.plan.pool as { poolKey: { currency0: string; currency1: string } }).poolKey.currency0,
           (position.plan.pool as { poolKey: { currency0: string; currency1: string } }).poolKey.currency1];
      return { value: { ...position, updatedAt: Date.now() / 1000, lastAction: 'claim',
        claimed0: received.get(tokens[0]?.toLowerCase() ?? '') ?? 0n,
        claimed1: received.get(tokens[1]?.toLowerCase() ?? '') ?? 0n,
      }, transactions };
    });
  }
  async close(position: LivePosition, observation: Observation, emergency = false): Promise<ExecutionResult<LivePosition>> {
    if (position.status === 'closed') return { value: position, transactions: [] };
    return this.serialize(position.chainId, async () => {
      assertPlanIdentity(position.plan, observation);
      const client = this.publicClients.get(position.chainId), owner = this.wallets.account.address, transactions: ExecutionTransaction[] = [];
      // A position can be out of range while the pool has zero *active*
      // liquidity. Keep identity/price verification fresh without preventing
      // an emergency exit merely because other LPs are inactive.
      const latest = await verifyPool(client, position.pool, undefined, undefined, { allowEmptyActiveLiquidity: true });
      if (!latest.verified || latest.token0.address.toLowerCase() !== observation.state.token0.address.toLowerCase()
        || latest.token1.address.toLowerCase() !== observation.state.token1.address.toLowerCase()) throw new Error('CLOSE_POOL_IDENTITY_MISMATCH');
      const closeWorkflow = position.pool.protocol === 'v3'
        ? (this.operationStore.getCloseWorkflow(`v3-close:${position.id}`) ?? this.operationStore.createCloseWorkflow({ workflowId: `v3-close:${position.id}`, chainId: position.chainId, positionId: position.id, poolIdentity: poolIdentity(position.pool), protocol: 'v3' }))
        : null;
      const inspected = await inspectCloseLiquidity(client, position);
      const collectAfterDurableRemove = closeWorkflow?.state === 'REMOVE_CONFIRMED' || closeWorkflow?.state === 'COLLECT_PENDING';
      if (inspected.missing || (inspected.liquidity === 0n && !collectAfterDurableRemove)) {
        if (closeWorkflow && closeWorkflow.state !== 'COMPLETE') throw new Error('CLOSE_RECONCILIATION_REQUIRED');
        return { value: reconcileClosedWithoutReceipt(position), transactions };
      }
      const lo = sqrtAtTick(position.plan.tickLower), hi = sqrtAtTick(position.plan.tickUpper);
      const current = latest.sqrtPriceX96 < lo ? lo : latest.sqrtPriceX96 > hi ? hi : latest.sqrtPriceX96;
      const minimum = (amount: bigint) => amount * BigInt(10_000 - position.plan.slippageBps) / 10_000n;
      // Marks the position 'closed' in our state as soon as liquidity
      // removal + collect have succeeded on-chain. The subsequent NFT
      // burn is best-effort: if it reverts, the position is already
      // effectively closed (funds are in the wallet) — we don't want to
      // leave the strategy stuck in 'open' state and re-attempt the
      // burn forever.
      let effectivelyClosedOnChain = false;
      let closeTxHash: Hex | undefined;
      if (position.pool.protocol === 'v3') {
        if (!closeWorkflow) throw new Error('CLOSE_WORKFLOW_REQUIRED');
        const liquidity = inspected.liquidity;
        const min0 = minimum(amount0Delta(current, hi, liquidity));
        const min1 = minimum(amount1Delta(lo, current, liquidity));
        let removed: { hash: Hex; receipt: TransactionReceipt } | null = null;
        if (closeWorkflow.state === 'REMOVE_PENDING') {
          const decrease = await client.simulateContract({ account: owner, address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'decreaseLiquidity',
            args: [{ tokenId: position.tokenId, liquidity, amount0Min: min0, amount1Min: min1, deadline: BigInt(Math.floor(Date.now() / 1000 + 120)) }] });
          removed = await this.write(position.chainId, decrease.request, emergency ? 'EMERGENCY_CLOSE' : 'CLOSE', position.id, poolIdentity(position.pool), { kind: 'V3_CLOSE', workflowId: closeWorkflow.workflowId, step: 'remove' });
          const op = this.operationStore.findByTransactionHash(removed.hash);
          this.operationStore.updateCloseWorkflow(closeWorkflow.workflowId, { removeOperationId: op?.operationId ?? null, state: 'REMOVE_CONFIRMED' });
          transactions.push(this.tx(position.chainId, 'decrease', removed.hash, removed.receipt, 'Removed all v3 liquidity', position.id));
        }
        const collect = await client.simulateContract({ account: owner, address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'collect',
          args: [{ tokenId: position.tokenId, recipient: owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }] });
        const collected = await this.write(position.chainId, collect.request, emergency ? 'EMERGENCY_CLOSE' : 'CLOSE', position.id, poolIdentity(position.pool), { kind: 'V3_CLOSE', workflowId: closeWorkflow.workflowId, step: 'collect' });
        const collectOp = this.operationStore.findByTransactionHash(collected.hash);
        this.operationStore.updateCloseWorkflow(closeWorkflow.workflowId, { collectOperationId: collectOp?.operationId ?? null, state: 'COMPLETE' });
        transactions.push(this.tx(position.chainId, 'claim', collected.hash, collected.receipt, 'Collected principal and fees', position.id));
        closeTxHash = collected.hash;
        effectivelyClosedOnChain = true;
        try {
          const burn = await client.simulateContract({ account: owner, address: position.positionManager, abi: v3PositionManagerAbi, functionName: 'burn', args: [position.tokenId] });
          const burned = await this.write(position.chainId, burn.request, emergency ? 'EMERGENCY_CLOSE' : 'CLOSE', position.id, poolIdentity(position.pool));
          transactions.push(this.tx(position.chainId, 'burn', burned.hash, burned.receipt, 'Burned empty v3 NFT', position.id));
        } catch (error) {
          // NFT burn is cosmetic. Funds are already in the wallet.
          transactions.push({ id: randomUUID(), chainId: position.chainId, positionId: position.id,
            action: 'burn', hash: '0x' + '0'.repeat(64) as Hex, at: Date.now() / 1000,
            status: 'failed', detail: `NFT burn reverted (${errorMessage(error)}); position is effectively closed on-chain` });
        }
      } else {
        const liquidity = inspected.liquidity;
        const min0 = minimum(amount0Delta(current, hi, liquidity));
        const min1 = minimum(amount1Delta(lo, current, liquidity));
        const simulation = await client.simulateContract({ account: owner, address: position.positionManager, abi: v4PositionManagerAbi, functionName: 'modifyLiquidities',
          args: [v4DecreaseData(position.plan, position.tokenId, liquidity, min0, min1, owner), BigInt(Math.floor(Date.now() / 1000 + 120))] });
        const sent = await this.write(position.chainId, simulation.request, emergency ? 'EMERGENCY_CLOSE' : 'CLOSE', position.id, poolIdentity(position.pool));
        transactions.push(this.tx(position.chainId, 'decrease', sent.hash, sent.receipt, 'Removed all v4 liquidity and collected fees', position.id));
        closeTxHash = sent.hash;
        effectivelyClosedOnChain = true;
      }
      const closeReceipt = closeTxHash ? await client.getTransactionReceipt({ hash: closeTxHash }).catch(() => null) : null;
      const received = closeReceipt ? decodeIncomingErc20Transfers(closeReceipt, owner,
        [observation.state.token0.address, observation.state.token1.address]) : new Map<string, bigint>();
      const claimed0 = received.get(observation.state.token0.address.toLowerCase()) ?? 0n;
      const claimed1 = received.get(observation.state.token1.address.toLowerCase()) ?? 0n;
      const realizedPnlUsd = (effectivelyClosedOnChain && closeTxHash)
        ? await this.computeRealizedPnl(position, observation, closeTxHash) : null;
      return { value: { ...position, status: 'closed', closeTxHash, updatedAt: Date.now() / 1000,
        lastAction: emergency ? 'emergency-close' : 'close', realizedPnlUsd, claimed0, claimed1,
        normalization: { status: 'pending', targetToken: getChain(position.chainId).primaryStable, attempts: 0, lastError: null } }, transactions };
    });
  }

  async normalize(position: LivePosition): Promise<ExecutionResult<LivePosition>> {
    if (position.status !== 'closed') throw new Error('CLOSED_POSITION_REQUIRED');
    if (position.normalization.status === 'complete') return { value: position, transactions: [] };
    if (position.normalization.status === 'blocked') throw new Error('NORMALIZATION_BLOCKED_PENDING_REVIEW');
    if (!this.relay) throw new Error('RELAY_NOT_CONFIGURED');
    const relay = this.relay;
    return this.serialize(position.chainId, async () => {
      const chain = getChain(position.chainId), target = position.normalization.targetToken ?? chain.primaryStable;
      if (target.toLowerCase() !== chain.primaryStable.toLowerCase()) throw new Error('NORMALIZATION_TARGET_NOT_PRIMARY_STABLE');
      const client = this.publicClients.get(position.chainId), owner = this.wallets.account.address;
      if (await client.getBalance({ address: owner }) < chain.minimumGasReserve) throw new Error('GAS_RESERVE');
      const residuals = position.plan.depositAssets.map((asset, index) => ({ token: asset.token,
        maximum: index === 0 ? position.claimed0 : position.claimed1 })).filter(item => item.token.toLowerCase() !== target.toLowerCase());
      const transactions: ExecutionTransaction[] = [];
      for (const residual of residuals) {
        const held = await client.readContract({ address: residual.token, abi: erc20ExecutionAbi, functionName: 'balanceOf', args: [owner] });
        const amount = held < residual.maximum ? held : residual.maximum;
        if (amount <= 0n) continue;
        transactions.push(...await relay.liquidate(position.plan, residual.token, target, amount, position.id));
      }
      return { value: { ...position, updatedAt: Date.now() / 1000,
        normalization: { status: 'complete', targetToken: target, attempts: position.normalization.attempts + 1, lastError: null } }, transactions };
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]!.slice(0, 240) : String(error).slice(0, 240);
}

function canonicalRequest(value: unknown): string {
  if (typeof value === 'bigint') return `"${value.toString()}n"`;
  if (Array.isArray(value)) return `[${value.map(canonicalRequest).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalRequest((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function bigintJson(_key: string, value: unknown) { return typeof value === 'bigint' ? `${value.toString()}n` : value; }

// Suppress unused-imports for helpers kept for future use.
void ({} as Log);
