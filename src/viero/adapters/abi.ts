import { parseAbi, parseAbiItem } from 'viem';

export const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
export const poolCreatedEvent = parseAbiItem('event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)');
export const v3Abi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
  'function feeGrowthGlobal0X128() view returns (uint256)', 'function feeGrowthGlobal1X128() view returns (uint256)',
]);
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getTickBitmap(bytes32,int16) view returns (uint256)',
  'function getTickLiquidity(bytes32,int24) view returns (uint128,int128)',
  'function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)',
  'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)',
]);
export const v3SwapEvent = parseAbiItem('event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)');
export const pancakeV3SwapEvent = parseAbiItem('event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)');
export const v4SwapEvent = parseAbiItem('event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)');
export const v3ProtocolFeeEvent = parseAbiItem('event SetFeeProtocol(uint8 feeProtocol0Old,uint8 feeProtocol1Old,uint8 feeProtocol0New,uint8 feeProtocol1New)');
export const v4ProtocolFeeEvent = parseAbiItem('event ProtocolFeeUpdated(bytes32 indexed id,uint24 protocolFee)');
export const initializeEvent = parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
export const nftAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
]);
export const erc20ExecutionAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export const erc20TransferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
export const permit2Abi = parseAbi([
  'function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
export const v3PositionManagerAbi = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)',
  'function burn(uint256 tokenId) payable',
]);
export const v4PositionManagerAbi = parseAbi([
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
/** Read-only pool-key recovery exposed by the deployed V4 PositionManager. */
export const v4PositionManagerPoolKeyAbi = parseAbi([
  'function poolKeys(bytes25 poolId) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)',
]);
export const erc721TransferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
