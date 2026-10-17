import { OperationStore } from '../src/viero/storage/operationStore.js';
import { createHash } from 'node:crypto';
const [, , file, key] = process.argv;
const store = new OperationStore(file!);
store.create({ idempotencyKey: key!, type: 'OPEN', chainId: 4663, positionId: null, poolIdentity: null, requestFingerprint: createHash('sha256').update(key!).digest('hex'), signerAddress: '0x0000000000000000000000000000000000000001', nonce: null, transactionHash: null });
store.close();
