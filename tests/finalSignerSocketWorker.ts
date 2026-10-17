import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { encodeEventTopics, keccak256, zeroAddress, type Hex } from 'viem';
import { LiveExecutor } from '../src/viero/execution/executor.js';
import { createSignerApp } from '../src/viero/execution/signerServer.js';
import { demoObservations } from '../src/viero/fixtures/demo.js';
import { screen } from '../src/viero/screening/pipeline.js';
import { planPosition } from '../src/viero/execution/planner.js';
import { DEFAULT_POLICY } from '../src/viero/config/policy.js';
import { getChain } from '../src/viero/config/chains.js';
import { erc721TransferEvent } from '../src/viero/adapters/abi.js';
import { json } from '../src/viero/domain.js';

const [socket, database, payloadFile, boundary = 'normal'] = process.argv.slice(2);
if (!socket || !database || !payloadFile) throw new Error('SOCKET_WORKER_ARGUMENTS');
const chain = getChain(4663), now = Math.floor(Date.now() / 1000);
let observation = demoObservations(now).find(item => item.state.pool.chainId === 4663
  && item.state.pool.protocol === (boundary.startsWith('v4-') ? 'v4' : 'v3'))!;
if (boundary === 'wrap-normal') {
  const previous = observation.state.token1.address, next = chain.wrappedNative!;
  observation = {
    ...observation,
    state: { ...observation.state, token0: { ...observation.state.token0, decimals: 18 },
      token1: { ...observation.state.token1, address: next, symbol: 'WETH', decimals: 18 },
      liquidity: 6_000_000n * 10n ** 18n },
    prices: observation.prices.map(price => price.token.toLowerCase() === previous.toLowerCase()
      ? { ...price, token: next, usd: 3000 } : { ...price, usd: 3000 }),
    risks: observation.risks.map(risk => risk.token.toLowerCase() === previous.toLowerCase()
      ? { ...risk, token: next } : risk),
  };
}
const candidate = screen(observation, DEFAULT_POLICY, now);
if (!candidate.approved) throw new Error(`FIXTURE_NOT_APPROVED:${json(candidate)}`);
const plan = planPosition(observation, candidate, 10, DEFAULT_POLICY,
  { totalExposureUsd: 0, chainExposureUsd: {}, dailyLossUsd: 0 }, now, undefined, 'live');
if (boundary === 'wrap-normal') plan.quoteAsset = 'NATIVE';
writeFileSync(payloadFile, json({ plan, observation, policy: DEFAULT_POLICY }));
const env = { ...process.env, VIERO_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: database,
  VIERO_SIGNER_TX_JOURNAL: `${database}.journal` };
const executor = new LiveExecutor(env);
const owner = `0x${'22'.repeat(20)}` as `0x${string}`;
let nonce = 1, action = '', sends = 0, minted = false, wrapped = false;
const receipts = new Map<string, any>();
const pool = observation.state.pool.protocol === 'v3' ? observation.state.pool.poolAddress : undefined;
const manager = observation.state.pool.protocol === 'v3' ? chain.v3.uniswap!.positionManager : chain.v4.positionManager;
const transferTopics = encodeEventTopics({ abi: [erc721TransferEvent], eventName: 'Transfer',
  args: { from: zeroAddress, to: owner, tokenId: 101n } });
const chainFile = `${database}.fake-chain.json`;
const confirmed = existsSync(chainFile) ? JSON.parse(readFileSync(chainFile, 'utf8')) as Array<{ hash: string; action: string }> : [];
nonce = confirmed.length + 1;
minted = confirmed.some(transaction => transaction.action === 'mint');
for (const [index, transaction] of confirmed.entries()) receipts.set(transaction.hash, {
  status: 'success', blockNumber: BigInt(1001 + index), blockHash: `0x${'33'.repeat(32)}`,
  logs: transaction.action === 'mint' ? [{ address: manager, data: '0x', topics: transferTopics }] : [],
});
const fakeClient = {
  getChainId: async () => 4663,
  getBlockNumber: async () => observation.state.blockNumber + 10n,
  getBlock: async () => ({ hash: observation.state.blockHash, timestamp: BigInt(now) }),
  getBytecode: async () => '0x6000',
  getBalance: async () => 10n ** 18n,
  readContract: async (args: any) => {
    switch (args.functionName) {
      case 'token0': return boundary === 'close-identity-mismatch' && minted
        ? `0x${'03'.repeat(20)}` : observation.state.token0.address;
      case 'token1': return observation.state.token1.address;
      case 'fee': return observation.state.fee;
      case 'tickSpacing': return observation.state.tickSpacing;
      case 'getPool': return pool;
      case 'slot0': return [observation.state.sqrtPriceX96, observation.state.tick, 0, 0, 0, 0, false];
      case 'liquidity': return boundary === 'zero-active-liquidity' && minted ? 0n : observation.state.liquidity;
      case 'getSlot0': return [observation.state.sqrtPriceX96, observation.state.tick, 0, observation.state.fee];
      case 'getLiquidity': return observation.state.liquidity;
      case 'getPositionLiquidity': return plan.liquidity;
      case 'decimals': return args.address.toLowerCase() === observation.state.token0.address.toLowerCase() ? observation.state.token0.decimals : observation.state.token1.decimals;
      case 'symbol': return args.address.toLowerCase() === observation.state.token0.address.toLowerCase() ? observation.state.token0.symbol : observation.state.token1.symbol;
      case 'balanceOf': return boundary === 'wrap-normal' && args.address.toLowerCase() === chain.wrappedNative!.toLowerCase() && !wrapped
        ? 0n : 10n ** 20n;
      case 'allowance': return args.address.toLowerCase() === chain.v4.permit2.toLowerCase()
        ? [0n, 0, 0] : 0n;
      case 'positions': return [0n, owner, observation.state.token0.address, observation.state.token1.address, 3000, -120, 120, plan.liquidity, 0n, 0n, 0n, 0n];
      default: throw new Error(`UNEXPECTED_READ:${args.functionName}`);
    }
  },
  simulateContract: async (request: any) => {
    action = request.functionName === 'modifyLiquidities'
      ? minted ? 'decrease' : 'mint' : request.functionName;
    return { request };
  },
  sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    if (boundary === 'before-broadcast') process.exit(17);
    sends++;
    if (action === 'mint') minted = true;
    if (action === 'deposit') wrapped = true;
    const hash = keccak256(serializedTransaction);
    if (boundary === 'broadcast-unknown' && sends === 1) throw new Error('fake acknowledgement loss');
    const logs = action === 'mint' ? [{ address: manager, data: '0x', topics: transferTopics }] : [];
    receipts.set(hash, { status: 'success', blockNumber: BigInt(1000 + sends), blockHash: `0x${'33'.repeat(32)}`, logs });
    confirmed.push({ hash, action }); writeFileSync(chainFile, JSON.stringify(confirmed));
    if (boundary === 'after-broadcast-ack') process.exit(17);
    return hash;
  },
  waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    if (boundary === 'receipt-timeout') throw new Error('fake receipt timeout');
    if (boundary === 'receipt-crash') process.exit(17);
    const receipt = receipts.get(hash); if (!receipt) throw new Error('RECEIPT_NOT_FOUND'); return receipt;
  },
  getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash) ?? null,
};
const fakeAccount = { address: owner, signTransaction: async ({ nonce: txNonce }: { nonce: number }) =>
  `0x${BigInt(txNonce).toString(16).padStart(64, '0')}` as Hex };
(executor as any).wallets = { account: fakeAccount, get: () => ({ prepareTransactionRequest: async (request: any) => ({ ...request, nonce: nonce++ }) }) };
(executor as any).publicClients = { get: () => fakeClient };
if (['before-prepared', 'after-prepared', 'after-nonce', 'after-signed', 'after-confirmed', 'mint-after-confirmed', 'after-position-evidence'].includes(boundary)) {
  const store = executor.operationStore as any, original = store.createExclusive.bind(store);
  const originalReserve = store.reserveNonce.bind(store), originalTransition = store.transition.bind(store);
  const originalRecord = store.recordPositionEvidence.bind(store);
  if (boundary === 'before-prepared') store.createExclusive = () => process.exit(17);
  if (boundary === 'after-prepared') store.createExclusive = (...args: any[]) => { const result = original(...args); process.exit(17); return result; };
  if (boundary === 'after-nonce') store.reserveNonce = (...args: any[]) => { const result = originalReserve(...args); process.exit(17); return result; };
  if (boundary === 'after-signed' || boundary === 'after-confirmed' || boundary === 'mint-after-confirmed') store.transition = (...args: any[]) => {
    const result = originalTransition(...args);
    if (args[2] === (boundary === 'after-signed' ? 'SIGNED' : 'CONFIRMED')
      && (boundary !== 'mint-after-confirmed' || result.poolIdentity)) process.exit(17);
    return result;
  };
  if (boundary === 'after-position-evidence') store.recordPositionEvidence = (...args: any[]) => { const result = originalRecord(...args); process.exit(17); return result; };
}
const readiness = await executor.startupRecovery();
await unlink(socket).catch(() => undefined);
const server = createSignerApp(executor, readiness).listen(socket, () => {
  chmodSync(socket, 0o600);
  console.log(`SIGNER_SOCKET_READY ${readiness.state}`);
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
