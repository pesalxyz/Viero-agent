import { erc20Abi, zeroAddress, type PublicClient, type Address } from 'viem';
import { getChain } from '../config/chains.js';
import { assertChain, requireCode } from '../clients/publicClients.js';
import { poolSchema, poolId, stateSchema, tokenSchema, type PoolRef, type PoolState, type InitializedTick } from '../domain.js';
import { factoryAbi, v3Abi, stateViewAbi } from './abi.js';
import { onePercentDepthRange } from '../screening/math.js';

export async function readToken(client: PublicClient, chainId: PoolRef['chainId'], address: Address, blockNumber: bigint) {
  if (address === zeroAddress) {
    const c = getChain(chainId);
    return tokenSchema.parse({ chainId, address, symbol: c.native.symbol, decimals: 18 });
  }
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol', blockNumber }).catch(() => 'UNKNOWN'),
  ]);
  return tokenSchema.parse({ chainId, address, decimals, symbol });
}
export async function verifyPool(client: PublicClient, input: PoolRef, atBlock?: bigint): Promise<PoolState> {
  const pool = poolSchema.parse(input), c = getChain(pool.chainId);
  await assertChain(client, pool.chainId);
  const head = atBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  const blockNumber = atBlock ?? (head >= BigInt(c.confirmations) ? head - BigInt(c.confirmations - 1) : 0n);
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error('MISSING_BLOCK_HASH');
  let token0: Address, token1: Address, fee: number, protocolFee: number, tickSpacing: number, sqrtPriceX96: bigint, tick: number, liquidity: bigint;
  let dynamicFee = false;
  const verification = ['rpc-chain-id', 'block-pinned'];
  if (pool.protocol === 'v3') {
    const deployment = c.v3[pool.dex];
    if (!deployment) throw new Error('UNSUPPORTED_VENUE');
    await Promise.all([requireCode(client, pool.poolAddress, blockNumber), requireCode(client, deployment.factory, blockNumber)]);
    [token0, token1, fee, tickSpacing] = await Promise.all([
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'token0', blockNumber }),
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'token1', blockNumber }),
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'fee', blockNumber }),
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'tickSpacing', blockNumber }),
    ]);
    const [canonical, slot, l] = await Promise.all([
      client.readContract({ address: deployment.factory, abi: factoryAbi, functionName: 'getPool', args: [token0, token1, fee], blockNumber }),
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'slot0', blockNumber }),
      client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'liquidity', blockNumber }),
    ]);
    if (canonical.toLowerCase() !== pool.poolAddress) throw new Error('FACTORY_POOL_MISMATCH');
    [sqrtPriceX96, tick] = slot; protocolFee = slot[5]; liquidity = l;
    verification.push('factory-identity', 'pool-bytecode');
  } else {
    if (poolId(pool.poolKey) !== pool.poolId) throw new Error('POOL_ID_MISMATCH');
    const key = pool.poolKey;
    if (pool.chainId === 5042 && key.currency0 === zeroAddress) throw new Error('ARC_NATIVE_SENTINEL_REJECTED');
    if (key.hooks !== zeroAddress && !c.v4.approvedHooks.includes(key.hooks)) throw new Error('UNKNOWN_V4_HOOK');
    await Promise.all([requireCode(client, c.v4.poolManager, blockNumber), requireCode(client, c.v4.stateView, blockNumber)]);
    const [slot, l] = await Promise.all([
      client.readContract({ address: c.v4.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [pool.poolId], blockNumber }),
      client.readContract({ address: c.v4.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [pool.poolId], blockNumber }),
    ]);
    [sqrtPriceX96, tick, protocolFee, fee] = slot; liquidity = l;
    token0 = key.currency0; token1 = key.currency1; tickSpacing = key.tickSpacing;
    dynamicFee = (key.fee & 0x800000) !== 0;
    if (!dynamicFee && key.fee !== fee) throw new Error('V4_FEE_MISMATCH');
    verification.push('pool-id', 'pool-manager-bytecode', 'state-view-bytecode', 'hook-allowlist');
  }
  if (sqrtPriceX96 === 0n || liquidity === 0n) throw new Error('UNINITIALIZED_OR_EMPTY_POOL');
  if (BigInt(token0) >= BigInt(token1)) throw new Error('TOKEN_ORDER_MISMATCH');
  const [t0, t1] = await Promise.all([readToken(client, pool.chainId, token0, blockNumber), readToken(client, pool.chainId, token1, blockNumber)]);
  return stateSchema.parse({ pool, token0: t0, token1: t1, blockNumber, blockHash: block.hash,
    observedAt: Number(block.timestamp), fetchedAt: Date.now() / 1000, sqrtPriceX96, tick, tickSpacing, liquidity, fee, protocolFee,
    dynamicFee, verified: true, verification });
}

export async function readDepthTicks(client: PublicClient, state: PoolState): Promise<InitializedTick[]> {
  const { pool, tickSpacing, blockNumber } = state;
  const target = onePercentDepthRange(state);
  const lower = Math.max(-887272, target.lowerTick), upper = Math.min(887272, target.upperTick);
  const first = Math.floor(Math.floor(lower / tickSpacing) / 256), last = Math.floor(Math.floor(upper / tickSpacing) / 256);
  const result: InitializedTick[] = [];
  for (let word = first; word <= last; word++) {
    const bitmap = pool.protocol === 'v3'
      ? await client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'tickBitmap', args: [word], blockNumber })
      : await client.readContract({ address: getChain(pool.chainId).v4.stateView, abi: stateViewAbi, functionName: 'getTickBitmap', args: [pool.poolId, word], blockNumber });
    const indices: number[] = [];
    for (let bit = 0; bit < 256; bit++) {
      const index = (word * 256 + bit) * tickSpacing;
      if ((bitmap & (1n << BigInt(bit))) !== 0n && index >= lower && index <= upper) indices.push(index);
    }
    const ticks = await Promise.all(indices.map(async index => {
      const data = pool.protocol === 'v3'
        ? await client.readContract({ address: pool.poolAddress, abi: v3Abi, functionName: 'ticks', args: [index], blockNumber })
        : await client.readContract({ address: getChain(pool.chainId).v4.stateView, abi: stateViewAbi, functionName: 'getTickLiquidity', args: [pool.poolId, index], blockNumber });
      return { index, liquidityNet: data[1] };
    }));
    result.push(...ticks);
  }
  return result.sort((a, b) => a.index - b.index);
}
