import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MAINNET_RELAY_API } from '@relayprotocol/relay-sdk';
import { keccak256, toHex } from 'viem';
import { relayChains, RelayBalancer } from '../src/viero/execution/relay.js';
import { WalletClients } from '../src/viero/execution/walletClients.js';

const PRIVATE_KEY = keccak256(toHex('viero-public-test-wallet'));
const TEST_RPC = 'http://127.0.0.1:18545';

test('Relay SDK registers Robinhood Chain 4663 with Viero metadata', () => {
  const client = createClient({
    baseApiUrl: MAINNET_RELAY_API,
    apiKey: 'test-key',
    source: 'viero-tests',
    chains: relayChains({ VIERO_RPC_4663: TEST_RPC }),
  });
  const chain = client.chains.find(item => item.id === 4663);
  assert.ok(chain);
  assert.equal(chain.httpRpcUrl, TEST_RPC);
  assert.equal(chain.viemChain?.id, 4663);
  assert.equal(chain.explorerUrl, 'https://robinhoodchain.blockscout.com');
});

test('Relay SDK still rejects an unsupported chain locally', () => {
  const client = createClient({
    baseApiUrl: MAINNET_RELAY_API,
    apiKey: 'test-key',
    source: 'viero-tests',
    chains: relayChains({ VIERO_RPC_4663: TEST_RPC }),
  });
  assert.equal(client.chains.some(item => item.id === 999999), false);
});

test('RelayBalancer exposes 4663 as executable without making a transaction', () => {
  const wallets = new WalletClients({ VIERO_SIGNER_PRIVATE_KEY: PRIVATE_KEY });
  const publicClients = { get: () => { throw new Error('network access is not expected in this test'); } } as never;
  const prior = process.env.VIERO_RPC_4663;
  process.env.VIERO_RPC_4663 = TEST_RPC;
  const relay = new RelayBalancer(wallets, publicClients, 'test-key');
  if (prior === undefined) delete process.env.VIERO_RPC_4663; else process.env.VIERO_RPC_4663 = prior;
  assert.equal(relay.supportsChain(4663), true);
  assert.equal(relay.supportsChain(999999), false);
});
