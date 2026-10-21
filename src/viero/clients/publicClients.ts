import { createPublicClient, defineChain, fallback, http, type PublicClient, type Address, type Transport } from 'viem';
import { getChain } from '../config/chains.js';
import { type ChainId, errorMessage } from '../domain.js';
import { RpcTelemetry, defaultRpcTelemetry, type RpcScopeContext } from '../observability/rpcTelemetry.js';

export class PublicClients {
  private clients = new Map<string, PublicClient>();
  constructor(private env: NodeJS.ProcessEnv = process.env, readonly telemetry: RpcTelemetry = defaultRpcTelemetry) {}
  get(id: ChainId): PublicClient {
    const c = getChain(id);
    const override = this.env[`VIERO_RPC_${id}`];
    const urls = override ? override.split(',').map(url => url.trim()).filter(Boolean) : c.rpcUrls;
    if (urls.length === 0) throw new Error(`NO_RPC_ENDPOINTS: ${id}`);
    const key = `${id}:${urls.join('|')}`;
    if (!this.clients.has(key)) {
      const chain = defineChain({ id, name: c.name, nativeCurrency: { name: c.native.symbol, ...c.native }, rpcUrls: { default: { http: urls } } });
      const transports = urls.map((url, index) => instrumentedHttp(url, id, index, this.telemetry));
      this.clients.set(key, createPublicClient({ chain, transport: fallback(transports) }));
    }
    return this.clients.get(key)!;
  }
}

function instrumentedHttp(url: string, chainId: ChainId, index: number, telemetry: RpcTelemetry): Transport {
  const pending: Array<{ methods: string[]; contexts: RpcScopeContext[]; startedAt: number }> = [];
  const requestContexts: RpcScopeContext[] = [];
  const base = http(url, {
    timeout: 20000, retryCount: 2, retryDelay: 750, batch: true,
    onFetchRequest: (_request, init) => {
      const methods = rpcMethods(init.body);
      // viem's fetch callbacks run outside the caller's AsyncLocalStorage scope.
      // Pair the envelope with the contexts captured at request() time instead.
      const contexts = requestContexts.splice(0, methods.length);
      const context = contexts[0] ?? telemetry.context();
      pending.push({ methods, contexts, startedAt: Date.now() });
      telemetry.physicalEnvelope(chainId, methods, index, contexts);
      if (index > 0) telemetry.retry(chainId, methods[0] ?? 'unknown', context.workflow);
    },
    onFetchResponse: response => {
      const attempt = pending.shift();
      if (attempt) telemetry.physicalEnvelopeResult(chainId, attempt.methods, response.ok, Date.now() - attempt.startedAt, attempt.contexts);
    },
  });
  return ({ chain }) => {
    const transport = base({ chain });
    return { ...transport, request: async (args: Parameters<typeof transport.request>[0]) => {
      const requestContext = telemetry.context();
      requestContexts.push(requestContext);
      telemetry.logical(chainId, args.method);
      try { return await transport.request(args); }
      catch (error) { telemetry.physicalResult(chainId, telemetry.workflow(), false, 0, args.method); throw error; }
    } } as ReturnType<typeof base>;
  };
}

function rpcMethods(body: unknown): string[] {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    return requests.map(request => typeof request?.method === 'string' ? request.method : 'unknown');
  } catch { return ['unknown']; }
}
export async function assertChain(client: PublicClient, id: ChainId) {
  if (await client.getChainId() !== id) throw new Error(`RPC_CHAIN_MISMATCH: expected ${id}`);
}
export async function requireCode(client: PublicClient, address: Address, blockNumber?: bigint) {
  const code = await client.getBytecode({ address, blockNumber });
  if (!code || code === '0x') throw new Error(`MISSING_BYTECODE: ${address}`);
  return code;
}
export async function smokeTest(clients: PublicClients, id: ChainId) {
  const c = getChain(id), client = clients.get(id);
  await assertChain(client, id);
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const deployments = [
    ...Object.values(c.v3).flatMap(d => [d.factory, d.positionManager, d.quoter]),
    c.v4.poolManager, c.v4.positionManager, c.v4.stateView, c.v4.permit2,
  ];
  const checks = await Promise.all(deployments.map(async address => {
    try { await requireCode(client, address, blockNumber); return { address, ok: true }; }
    catch (e) { return { address, ok: false, error: errorMessage(e) }; }
  }));
  return { chainId: id, blockNumber, ok: checks.every(c => c.ok), checks };
}
