import { createWalletClient, defineChain, fallback, http, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { getChain } from '../config/chains.js';
import { type ChainId } from '../domain.js';

export class WalletClients {
  readonly account: PrivateKeyAccount;
  private clients = new Map<ChainId, WalletClient>();
  constructor(private env: NodeJS.ProcessEnv = process.env) {
    const value = env.VIERO_SIGNER_PRIVATE_KEY;
    if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('VIERO_SIGNER_PRIVATE_KEY_MISSING_OR_INVALID');
    this.account = privateKeyToAccount(value as `0x${string}`);
  }
  get(id: ChainId): WalletClient {
    if (!this.clients.has(id)) {
      const c = getChain(id), override = this.env[`VIERO_RPC_${id}`];
      const urls = override ? override.split(',').map(v => v.trim()).filter(Boolean) : c.rpcUrls;
      const chain = defineChain({ id, name: c.name, nativeCurrency: { name: c.native.symbol, ...c.native }, rpcUrls: { default: { http: urls } } });
      this.clients.set(id, createWalletClient({ account: this.account, chain,
        transport: fallback(urls.map(url => http(url, { timeout: 20_000, retryCount: 2, retryDelay: 750 }))) }));
    }
    return this.clients.get(id)!;
  }
}
