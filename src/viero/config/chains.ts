import { type Address } from 'viem';
import { CHAIN_IDS, chainIdSchema, type ChainId } from '../domain.js';

export type V3Deployment = { factory: Address; positionManager: Address; quoter: Address; feeTiers: number[] };
export type V4Deployment = { poolManager: Address; positionManager: Address; stateView: Address; permit2: Address; approvedHooks: Address[] };
export type ChainConfig = {
  id: ChainId; name: string; slug: string; rpcUrls: string[]; explorerUrl: string;
  sources: { gmgn: string; gecko: string; dexScreener: string };
  native: { symbol: string; decimals: 18; isErc20Backed: boolean };
  primaryStable: Address; stableTokens: Address[]; wrappedNative?: Address; quoteTokens: Address[];
  v3: Partial<Record<'uniswap' | 'pancakeswap', V3Deployment>>; v4: V4Deployment;
  minimumGasReserve: bigint; confirmations: number;
};
const a = (value: string) => value.toLowerCase() as Address;
const usdcArc = a('0x3600000000000000000000000000000000000000');
const wethBase = a('0x4200000000000000000000000000000000000006');
const usdcBase = a('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const wbnb = a('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
const usdt = a('0x55d398326f99059fF775485246999027B3197955');
const usdcBsc = a('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
const wethRh = a('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const usdg = a('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const v3 = (factory: string, positionManager: string, quoter: string, feeTiers = [100, 500, 3000, 10000]): V3Deployment =>
  ({ factory: a(factory), positionManager: a(positionManager), quoter: a(quoter), feeTiers });
const permit2 = a('0x000000000022D473030F116dDEE9F6B43aC78BA3');
const v4 = (poolManager: string, positionManager: string, stateView: string): V4Deployment =>
  ({ poolManager: a(poolManager), positionManager: a(positionManager), stateView: a(stateView), permit2, approvedHooks: [] });

export const DEPLOYMENT_VERSION = 'uniswap-37936185-2026-09-18';
export const DEPLOYMENT_SOURCES = [
  'https://developers.uniswap.org/deployments.json',
  'https://developer.pancakeswap.finance/contracts/v3/addresses',
  'https://docs.robinhood.com/chain/contracts/',
  'https://docs.arc.io/integrate/connect-to-arc',
] as const;
export const CHAINS: Record<ChainId, ChainConfig> = {
  4663: {
    id: 4663, name: 'Robinhood Chain', slug: 'robinhood', rpcUrls: [],
    explorerUrl: 'https://robinhoodchain.blockscout.com', sources: { gmgn: 'robinhood', gecko: 'robinhood', dexScreener: 'robinhood' },
    native: { symbol: 'ETH', decimals: 18, isErc20Backed: false }, primaryStable: usdg, stableTokens: [usdg], wrappedNative: wethRh, quoteTokens: [usdg, wethRh],
    v3: { uniswap: v3('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3', '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7') },
    v4: v4('0x8366a39cc670b4001a1121b8f6a443a643e40951', '0x58daec3116aae6d93017baaea7749052e8a04fa7', '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
    minimumGasReserve: 10n ** 15n, confirmations: 3,
  },
  56: {
    id: 56, name: 'BNB Smart Chain', slug: 'bsc', rpcUrls: [], explorerUrl: 'https://bscscan.com',
    sources: { gmgn: 'bsc', gecko: 'bsc', dexScreener: 'bsc' }, native: { symbol: 'BNB', decimals: 18, isErc20Backed: false },
    primaryStable: usdt, stableTokens: [usdt, usdcBsc], wrappedNative: wbnb, quoteTokens: [usdt, usdcBsc, wbnb],
    v3: {
      uniswap: v3('0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613', '0x78D78E420Da98ad378D7799bE8f4AF69033EB077'),
      pancakeswap: v3('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', [100, 500, 2500, 10000]),
    },
    v4: v4('0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b', '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4'),
    minimumGasReserve: 5n * 10n ** 15n, confirmations: 3,
  },
  8453: {
    id: 8453, name: 'Base', slug: 'base', rpcUrls: [], explorerUrl: 'https://basescan.org',
    sources: { gmgn: 'base', gecko: 'base', dexScreener: 'base' }, native: { symbol: 'ETH', decimals: 18, isErc20Backed: false },
    primaryStable: usdcBase, stableTokens: [usdcBase], wrappedNative: wethBase, quoteTokens: [usdcBase, wethBase],
    v3: { uniswap: v3('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a') },
    v4: v4('0x498581ff718922c3f8e6a244956af099b2652b2b', '0x7c5f5a4bbd8fd63184577525326123b519429bdc', '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71'),
    minimumGasReserve: 10n ** 15n, confirmations: 3,
  },
  5042: {
    id: 5042, name: 'Arc', slug: 'arc', rpcUrls: [], explorerUrl: 'https://explorer.arc.io',
    sources: { gmgn: 'arc', gecko: 'arc', dexScreener: 'arc' }, native: { symbol: 'USDC', decimals: 18, isErc20Backed: true },
    primaryStable: usdcArc, stableTokens: [usdcArc], quoteTokens: [usdcArc],
    v3: { uniswap: v3('0xf0db7b58379503491d857dB50AC9ece64c653918', '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377', '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468') },
    v4: v4('0x8366a39cc670b4001a1121b8f6a443a643e40951', '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b', '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
    minimumGasReserve: 2n * 10n ** 18n, confirmations: 1,
  },
};
export function getChain(id: number): ChainConfig {
  return CHAINS[chainIdSchema.parse(id)];
}
export function sourceSlug(id: number, source: keyof ChainConfig['sources']): string {
  const slug = getChain(id).sources[source];
  if (!slug) throw new Error(`Missing ${source} mapping for ${id}`);
  return slug;
}
export { CHAIN_IDS };
