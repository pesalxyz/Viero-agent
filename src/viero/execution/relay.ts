import { createClient, MAINNET_RELAY_API, type RelayChain, type RelayClient, convertViemChainToRelayChain } from '@relayprotocol/relay-sdk';
import { defineChain, type Address, type TransactionReceipt } from 'viem';
import { mainnet } from 'viem/chains';
import { getChain } from '../config/chains.js';
import { poolIdentity, type ChainId } from '../domain.js';
import { type PositionPlan } from './planner.js';
import { type ExecutionTransaction } from './liveState.js';
import { WalletClients } from './walletClients.js';
import { PublicClients } from '../clients/publicClients.js';
import { createHash, randomUUID } from 'node:crypto';
import { RelayOperationStore } from '../storage/relayOperationStore.js';

/** Register a Viero chain in Relay's local SDK registry. */
function vieroRelayChain(chainId: 4663 | 56, env: NodeJS.ProcessEnv): RelayChain {
  const chain = getChain(chainId);
  const rpcUrls = (env[`VIERO_RPC_${chainId}`] ?? '').split(',').map(url => url.trim()).filter(Boolean);
  if (rpcUrls.length === 0) throw new Error(`NO_RPC_ENDPOINTS: ${chainId}`);
  const viemChain = defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: {
      name: chain.native.symbol,
      symbol: chain.native.symbol,
      decimals: chain.native.decimals,
    },
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: { default: { name: chain.name, url: chain.explorerUrl } },
  });
  return convertViemChainToRelayChain(viemChain);
}

export function robinhoodRelayChain(env: NodeJS.ProcessEnv = process.env): RelayChain {
  return vieroRelayChain(4663, env);
}

export function bnbRelayChain(env: NodeJS.ProcessEnv = process.env): RelayChain {
  return vieroRelayChain(56, env);
}

export function relayChains(env: NodeJS.ProcessEnv = process.env): RelayChain[] {
  const chains = [convertViemChainToRelayChain(mainnet), robinhoodRelayChain(env)];
  // BNB is optional for hosts that only run Robinhood. When its configured
  // RPC is present, register it with the same metadata used by Viero's public
  // clients so post-close normalization can resolve chain 56 locally.
  if ((env.VIERO_RPC_56 ?? '').split(',').some(url => url.trim())) chains.push(bnbRelayChain(env));
  return chains;
}

export class RelayBalancer {
  private client: RelayClient;
  private operationStore: RelayOperationStore | null = null;
  constructor(readonly wallets: WalletClients, readonly publicClients: PublicClients, apiKey: string,
    private readonly storePath = process.env.VIERO_SIGNER_RELAY_OPERATION_STORE ?? '/var/lib/viero-signer/relay-operations.db') {
    if (!apiKey) throw new Error('RELAY_API_KEY_REQUIRED');
    this.client = createClient({ baseApiUrl: MAINNET_RELAY_API, apiKey, source: 'viero-agent', pollingInterval: 3000, maxPollingAttemptsBeforeTimeout: 60, chains: relayChains() });
  }
  supportsChain(chainId: number): boolean { return this.client.chains.some(chain => chain.id === chainId); }
  private store(): RelayOperationStore { return this.operationStore ??= new RelayOperationStore(this.storePath); }
  unresolvedOperations() { return this.store().unresolved(); }
  recoveryStatus(): { state: 'READY' | 'RECONCILIATION_REQUIRED' | 'BLOCKED'; unresolved: number } {
    try {
      const unresolved = this.unresolvedOperations().length;
      return { state: unresolved ? 'RECONCILIATION_REQUIRED' : 'READY', unresolved };
    } catch { return { state: 'BLOCKED', unresolved: -1 }; }
  }
  closeStore() { this.operationStore?.close(); this.operationStore = null; }
  private async executeDurably(kind: 'ACQUIRE' | 'NORMALIZE', plan: PositionPlan, token: Address, target: Address,
    amount: bigint, context: string, quote: Parameters<RelayClient['actions']['execute']>[0]['quote']) {
    const chainId = plan.chainId, signer = this.wallets.account.address;
    const fingerprint = createHash('sha256').update(JSON.stringify(quote, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
    const key = createHash('sha256').update([kind, chainId, signer.toLowerCase(), poolIdentity(plan.pool), context,
      token.toLowerCase(), target.toLowerCase(), amount.toString()].join(':')).digest('hex');
    const requestIds = quote.steps.map(step => step.requestId).filter((id): id is string => typeof id === 'string');
    const store = this.store();
    const operation = store.begin({ key, kind, chainId, signer, quoteFingerprint: fingerprint, requestIds,
      context, tokenIn: token, tokenOut: target, amountRaw: amount.toString() });
    store.transition(operation.operationId, 'PREPARED', 'EXECUTING');
    try {
      const completed = await this.client.actions.execute({ quote, wallet: this.wallets.get(chainId), disableCapabilitiesCheck: true,
        onProgress: data => {
          const hashes = data.steps.flatMap(step => step.items.flatMap(item => (item.txHashes ?? []).map(tx => tx.txHash)));
          if (hashes.length) store.recordHashes(operation.operationId, hashes);
        } });
      const hashes = completed.data.steps.flatMap(step => step.items.flatMap(item => (item.txHashes ?? []).map(tx => tx.txHash)));
      if (hashes.length) store.recordHashes(operation.operationId, hashes);
      // A fulfilled SDK promise is not by itself proof that every quoted
      // economic step completed. A truncated/reordered result stays unresolved
      // for operator reconciliation; it must never become a successful swap.
      if (completed.data.steps.length !== quote.steps.length || quote.steps.some((step, index) => {
        const actual = completed.data.steps[index];
        return !actual || actual.id !== step.id || actual.requestId !== step.requestId;
      })) throw new Error('RELAY_EXECUTION_STEPS_INCOMPLETE');
      return { completed, operationId: operation.operationId };
    } catch (error) {
      try { store.transition(operation.operationId, 'EXECUTING', 'UNKNOWN'); } catch { /* EXECUTING remains unresolved on storage failure. */ }
      throw new Error(`RELAY_OUTCOME_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private completeDurably(operationId: string) { this.store().transition(operationId, 'EXECUTING', 'COMPLETE'); }
  async acquire(plan: PositionPlan, token: Address, amount: bigint): Promise<ExecutionTransaction[]> {
    const chainId = plan.chainId, chain = getChain(chainId), owner = this.wallets.account.address;
    if (token === chain.primaryStable) throw new Error('PRIMARY_STABLE_BALANCE_SHORTFALL');
    const quote = await this.client.actions.getQuote({ chainId, toChainId: chainId, currency: chain.primaryStable, toCurrency: token,
      tradeType: 'EXACT_OUTPUT', amount: amount.toString(), user: owner, recipient: owner,
      options: { slippageTolerance: plan.slippageBps.toString() }, wallet: this.wallets.get(chainId), disableCapabilitiesCheck: true });
    const details = quote.details, input = details?.currencyIn, output = details?.currencyOut;
    if (details?.operation !== 'swap' || details.sender?.toLowerCase() !== owner.toLowerCase() || details.recipient?.toLowerCase() !== owner.toLowerCase()) throw new Error('RELAY_QUOTE_IDENTITY_MISMATCH');
    if (input?.currency?.chainId !== chainId || input.currency.address?.toLowerCase() !== chain.primaryStable || output?.currency?.chainId !== chainId || output.currency.address?.toLowerCase() !== token) throw new Error('RELAY_QUOTE_CURRENCY_MISMATCH');
    if (BigInt(output.amount ?? 0) < amount) throw new Error('RELAY_QUOTE_OUTPUT_SHORTFALL');
    const inputUsd = Number(input.amountUsd ?? NaN);
    if (!Number.isFinite(inputUsd) || inputUsd <= 0 || inputUsd > plan.depositUsd * 1.02) throw new Error('RELAY_QUOTE_BUDGET_EXCEEDED');
    const { completed, operationId } = await this.executeDurably('ACQUIRE', plan, chain.primaryStable, token, amount,
      String(plan.createdAt), quote);
    const transactions: ExecutionTransaction[] = [];
    for (const step of completed.data.steps) for (const item of step.items) for (const tx of item.txHashes ?? []) {
      if (tx.chainId !== chainId || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) throw new Error('RELAY_EXECUTION_HASH_MISMATCH');
      const receipt = await this.publicClients.get(chainId).waitForTransactionReceipt({ hash: tx.txHash as `0x${string}`,
        confirmations: chain.confirmations, timeout: 180_000 });
      const sdkReceipt = item.receipt as TransactionReceipt | undefined;
      if (sdkReceipt?.blockHash && sdkReceipt.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('RELAY_RECEIPT_CANONICALITY_MISMATCH');
      if (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== tx.txHash.toLowerCase()) throw new Error('RELAY_RECEIPT_HASH_MISMATCH');
      this.store().recordReceipt(operationId, { hash: tx.txHash, blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash, status: receipt.status === 'success' ? 'success' : 'reverted' });
      if (receipt.status !== 'success') throw new Error('RELAY_SWAP_REVERTED');
      transactions.push({ id: randomUUID(), chainId, action: step.id === 'approve' ? 'approve' : 'swap', hash: tx.txHash as `0x${string}`,
        at: Date.now() / 1000, status: 'confirmed', blockNumber: receipt.blockNumber, detail: `Relay ${step.id}` });
    }
    if (!transactions.length) throw new Error('RELAY_NO_CONFIRMED_TRANSACTIONS');
    const balance = await this.publicClients.get(chainId).readContract({ address: token, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
      inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [owner] });
    if (balance < amount) throw new Error('RELAY_SWAP_RECONCILIATION_FAILED');
    this.completeDurably(operationId);
    return transactions;
  }

  async liquidate(plan: PositionPlan, token: Address, target: Address, amount: bigint, positionId: string): Promise<ExecutionTransaction[]> {
    const chainId = plan.chainId, chain = getChain(chainId), owner = this.wallets.account.address;
    if (target.toLowerCase() !== chain.primaryStable.toLowerCase() || token.toLowerCase() === target.toLowerCase() || amount <= 0n) throw new Error('INVALID_NORMALIZATION_SWAP');
    const quote = await this.client.actions.getQuote({ chainId, toChainId: chainId, currency: token, toCurrency: target,
      tradeType: 'EXACT_INPUT', amount: amount.toString(), user: owner, recipient: owner,
      options: { slippageTolerance: plan.slippageBps.toString() }, wallet: this.wallets.get(chainId), disableCapabilitiesCheck: true });
    const details = quote.details, input = details?.currencyIn, output = details?.currencyOut;
    if (details?.operation !== 'swap' || details.sender?.toLowerCase() !== owner.toLowerCase() || details.recipient?.toLowerCase() !== owner.toLowerCase()) throw new Error('RELAY_QUOTE_IDENTITY_MISMATCH');
    if (input?.currency?.chainId !== chainId || input.currency.address?.toLowerCase() !== token.toLowerCase()
      || output?.currency?.chainId !== chainId || output.currency.address?.toLowerCase() !== target.toLowerCase()) throw new Error('RELAY_QUOTE_CURRENCY_MISMATCH');
    if (BigInt(input.amount ?? 0) !== amount || BigInt(output.amount ?? 0) <= 0n) throw new Error('RELAY_QUOTE_AMOUNT_INVALID');
    const { completed, operationId } = await this.executeDurably('NORMALIZE', plan, token, target, amount, positionId, quote);
    const transactions: ExecutionTransaction[] = [];
    for (const step of completed.data.steps) for (const item of step.items) for (const tx of item.txHashes ?? []) {
      if (tx.chainId !== chainId || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) throw new Error('RELAY_EXECUTION_HASH_MISMATCH');
      const receipt = await this.publicClients.get(chainId).waitForTransactionReceipt({ hash: tx.txHash as `0x${string}`,
        confirmations: chain.confirmations, timeout: 180_000 });
      const sdkReceipt = item.receipt as TransactionReceipt | undefined;
      if (sdkReceipt?.blockHash && sdkReceipt.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('RELAY_RECEIPT_CANONICALITY_MISMATCH');
      if (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== tx.txHash.toLowerCase()) throw new Error('RELAY_RECEIPT_HASH_MISMATCH');
      this.store().recordReceipt(operationId, { hash: tx.txHash, blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash, status: receipt.status === 'success' ? 'success' : 'reverted' });
      if (receipt.status !== 'success') throw new Error('RELAY_SWAP_REVERTED');
      transactions.push({ id: randomUUID(), chainId, action: step.id === 'approve' ? 'approve' : 'swap', hash: tx.txHash as `0x${string}`,
        at: Date.now() / 1000, status: 'confirmed', blockNumber: receipt.blockNumber, detail: `Relay post-close ${step.id}` });
    }
    if (!transactions.length) throw new Error('RELAY_NO_CONFIRMED_TRANSACTIONS');
    this.completeDurably(operationId);
    return transactions;
  }
}
