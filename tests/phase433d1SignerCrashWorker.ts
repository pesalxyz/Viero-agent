import { LiveExecutor } from '../src/viero/execution/executor.js';
import { type OperationState } from '../src/viero/storage/operationStore.js';

const database = process.argv[2];
const boundary = process.argv[3];
if (!database || !boundary) throw new Error('WORKER_ARGS_REQUIRED');
const signer = `0x${'11'.repeat(20)}` as `0x${string}`;
const txHash = `0x${'22'.repeat(32)}` as `0x${string}`;
const receipt = { status: 'success' as const, blockNumber: 42n, blockHash: `0x${'33'.repeat(32)}` as `0x${string}`, logs: [] };
const env = { ...process.env, VIERO_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, VIERO_RPC_4663: 'http://127.0.0.1:9', VIERO_SIGNER_OPERATION_STORE: database, VIERO_SIGNER_TX_JOURNAL: `${database}.journal` };
const executor = new LiveExecutor(env);
const fakeAccount = { address: signer, signTransaction: async () => '0x1234' as `0x${string}` };
let sends = 0;
const fakeWallet = { prepareTransactionRequest: async () => ({ nonce: 7, to: signer, data: '0x1234' as `0x${string}` }), account: fakeAccount };
const fakeClient = {
  sendRawTransaction: async () => {
    sends += 1;
    if (boundary === 'ambiguous-broadcast') throw new Error('transport timeout');
    if (boundary === 'before-broadcast' || boundary === 'after-broadcast-ack') process.exit(17);
    return txHash;
  },
  waitForTransactionReceipt: async () => {
    if (boundary === 'during-receipt') process.exit(17);
    return receipt;
  },
};
(executor as any).wallets = { account: fakeAccount, get: () => fakeWallet };
(executor as any).publicClients = { get: () => fakeClient };
const store = executor.operationStore as any;
const originalCreate = store.createExclusive.bind(store);
const originalReserve = store.reserveNonce.bind(store);
const originalTransition = store.transition.bind(store);
if (boundary === 'before-prepared') store.createExclusive = () => process.exit(17);
if (boundary === 'after-prepared') store.createExclusive = (...args: any[]) => { const value = originalCreate(...args); process.exit(17); return value; };
if (boundary === 'after-nonce') store.reserveNonce = (...args: any[]) => { const value = originalReserve(...args); process.exit(17); return value; };
if (boundary === 'after-signed') store.transition = (...args: any[]) => { const value = originalTransition(...args); if (args[2] === 'SIGNED') process.exit(17); return value; };
if (boundary === 'after-confirmed') store.transition = (...args: any[]) => { const value = originalTransition(...args); if (args[2] === 'CONFIRMED') process.exit(17); return value; };

if (boundary === 'recovery') {
  const readiness = await executor.startupRecovery();
  console.log(JSON.stringify({ readiness, unresolved: store.unresolved().map((item: any) => ({ id: item.operationId, state: item.state })) }));
  store.close();
  process.exit(0);
}

try {
  await (executor as any).write(4663, { to: signer, data: '0x1234' }, 'OPEN');
  console.log(JSON.stringify({ sends, state: store.all()[0]?.state ?? null }));
  store.close();
  process.exit(boundary === 'normal' || boundary === 'ambiguous-broadcast' ? 0 : 17);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (boundary === 'ambiguous-broadcast') {
    console.log(JSON.stringify({ sends, state: store.all()[0]?.state ?? null }));
    store.close();
    process.exit(17);
  }
  store.close();
  process.exit(1);
}
