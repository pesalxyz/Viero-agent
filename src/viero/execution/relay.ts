import { createClient, MAINNET_RELAY_API, type RelayChain, type RelayClient, convertViemChainToRelayChain } from '@relayprotocol/relay-sdk';
import { defineChain, type Address, type TransactionReceipt } from 'viem';
import { mainnet } from 'viem/chains';
import { getChain } from '../config/chains.js';
import { type ChainId } from '../domain.js';
import { type PositionPlan } from './planner.js';
import { type ExecutionTransaction } from './liveState.js';
import { WalletClients } from './walletClients.js';
import { PublicClients } from '../clients/publicClients.js';
import { randomUUID } from 'node:crypto';

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
  constructor(readonly wallets: WalletClients, readonly publicClients: PublicClients, apiKey: string) {
    if (!apiKey) throw new Error('RELAY_API_KEY_REQUIRED');
    this.client = createClient({ baseApiUrl: MAINNET_RELAY_API, apiKey, source: 'viero-agent', pollingInterval: 3000, maxPollingAttemptsBeforeTimeout: 60, chains: relayChains() });
  }
  supportsChain(chainId: number): boolean { return this.client.chains.some(chain => chain.id === chainId); }
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
    const completed = await this.client.actions.execute({ quote, wallet: this.wallets.get(chainId), disableCapabilitiesCheck: true });
    const transactions: ExecutionTransaction[] = [];
    for (const step of completed.data.steps) for (const item of step.items) for (const tx of item.txHashes ?? []) {
      if (tx.chainId !== chainId || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) throw new Error('RELAY_EXECUTION_HASH_MISMATCH');
      let receipt = item.receipt as TransactionReceipt | undefined;
      if (!receipt || !('blockNumber' in receipt)) receipt = await this.publicClients.get(chainId).waitForTransactionReceipt({ hash: tx.txHash as `0x${string}`, confirmations: chain.confirmations, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error('RELAY_SWAP_REVERTED');
      transactions.push({ id: randomUUID(), chainId, action: step.id === 'approve' ? 'approve' : 'swap', hash: tx.txHash as `0x${string}`,
        at: Date.now() / 1000, status: 'confirmed', blockNumber: receipt.blockNumber, detail: `Relay ${step.id}` });
    }
    const balance = await this.publicClients.get(chainId).readContract({ address: token, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
      inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [owner] });
    if (balance < amount) throw new Error('RELAY_SWAP_RECONCILIATION_FAILED');
    return transactions;
  }

  async liquidate(plan: PositionPlan, token: Address, target: Address, amount: bigint): Promise<ExecutionTransaction[]> {
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
    const completed = await this.client.actions.execute({ quote, wallet: this.wallets.get(chainId), disableCapabilitiesCheck: true });
    const transactions: ExecutionTransaction[] = [];
    for (const step of completed.data.steps) for (const item of step.items) for (const tx of item.txHashes ?? []) {
      if (tx.chainId !== chainId || !/^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) throw new Error('RELAY_EXECUTION_HASH_MISMATCH');
      let receipt = item.receipt as TransactionReceipt | undefined;
      if (!receipt || !('blockNumber' in receipt)) receipt = await this.publicClients.get(chainId).waitForTransactionReceipt({ hash: tx.txHash as `0x${string}`, confirmations: chain.confirmations, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error('RELAY_SWAP_REVERTED');
      transactions.push({ id: randomUUID(), chainId, action: step.id === 'approve' ? 'approve' : 'swap', hash: tx.txHash as `0x${string}`,
        at: Date.now() / 1000, status: 'confirmed', blockNumber: receipt.blockNumber, detail: `Relay post-close ${step.id}` });
    }
    return transactions;
  }
}
