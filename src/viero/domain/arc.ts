export type ArcNativeUsdc18 = bigint & { readonly __unit: 'arc-native-usdc-18' };
export type ArcErc20Usdc6 = bigint & { readonly __unit: 'arc-erc20-usdc-6' };
const SCALE = 10n ** 12n;
export function nativeUsdc(value: bigint): ArcNativeUsdc18 {
  if (value < 0n) throw new Error('Negative native balance');
  return value as ArcNativeUsdc18;
}
export function erc20Usdc(value: bigint): ArcErc20Usdc6 {
  if (value < 0n) throw new Error('Negative ERC20 balance');
  return value as ArcErc20Usdc6;
}
export function arcNativeToErc20(value: ArcNativeUsdc18): ArcErc20Usdc6 {
  return erc20Usdc(value / SCALE);
}
export function arcErc20ToNative(value: ArcErc20Usdc6): ArcNativeUsdc18 {
  return nativeUsdc(value * SCALE);
}
export function arcBalance(native: ArcNativeUsdc18, erc20: ArcErc20Usdc6, reserve: ArcNativeUsdc18) {
  if (arcNativeToErc20(native) !== erc20) throw new Error('Arc interfaces disagree at the same block');
  return { chainId: 5042 as const, native, erc20, canonicalNative: native,
    spendableErc20: arcNativeToErc20(nativeUsdc(native > reserve ? native - reserve : 0n)), dustNative: native % SCALE };
}
