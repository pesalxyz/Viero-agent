import { type PoolState } from '../domain.js';

const PIPS = 1_000_000;

export function directionalProtocolFee(state: Pick<PoolState, 'pool' | 'protocolFee'>, zeroForOne: boolean): number {
  if (state.pool.protocol === 'v4') return zeroForOne ? state.protocolFee & 0xfff : state.protocolFee >> 12;
  if (state.pool.dex === 'pancakeswap') return zeroForOne ? state.protocolFee & 0xffff : state.protocolFee >>> 16;
  return zeroForOne ? state.protocolFee & 0xf : state.protocolFee >> 4;
}

export function lpFeePips(state: Pick<PoolState, 'pool' | 'fee' | 'protocolFee' | 'dynamicFee'>, zeroForOne: boolean): number | null {
  const protocol = directionalProtocolFee(state, zeroForOne);
  if (state.pool.protocol === 'v4') {
    if (state.dynamicFee) return null;
    return state.fee * (PIPS - protocol) / PIPS;
  }
  if (state.pool.dex === 'pancakeswap') return state.fee * (10_000 - protocol) / 10_000;
  return protocol === 0 ? state.fee : state.fee * (protocol - 1) / protocol;
}

export function swapFeeUsd(state: Pick<PoolState, 'pool' | 'fee' | 'protocolFee' | 'dynamicFee'>, zeroForOne: boolean, volumeUsd: number, effectiveFee: number) {
  const grossFeeUsd = volumeUsd * effectiveFee / PIPS;
  const lpPips = lpFeePips(state, zeroForOne);
  return { grossFeeUsd, lpFeeUsd: lpPips === null ? null : volumeUsd * lpPips / PIPS };
}
