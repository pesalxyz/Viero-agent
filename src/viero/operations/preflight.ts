import { DEPLOYMENT_VERSION } from '../config/chains.js';
import { errorMessage, type ChainId } from '../domain.js';

export type PreflightCheck = { name: string; ok: boolean; detail: string };
export type PreflightResult = {
  ok: boolean;
  readOnly: true;
  deploymentVersion: string;
  checkedAt: number;
  checks: PreflightCheck[];
};

const walletEnvironmentKeys = [
  'PRIVATE_KEY', 'MNEMONIC', 'EVM_PRIVATE_KEY', 'EVM_MNEMONIC', 'VIERO_PRIVATE_KEY', 'VIERO_MNEMONIC',
] as const;

export async function deploymentPreflight(options: {
  chains: ChainId[];
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  storageDetail?: string;
  smoke: (chainId: ChainId) => Promise<{ ok: boolean; blockNumber?: bigint; checks?: Array<{ ok: boolean }> }>;
  gmgn: (chainId: ChainId) => Promise<unknown[]>;
}): Promise<PreflightResult> {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  const checks: PreflightCheck[] = [{
    name: 'node', ok: Number.isInteger(major) && major >= 20,
    detail: `Node ${nodeVersion}; version 20 or newer is required`,
  }, {
    name: 'storage', ok: true, detail: options.storageDetail ?? (env.DATABASE_URL ? 'PostgreSQL initialized' : 'file repository initialized'),
  }];

  const walletKeys = walletEnvironmentKeys.filter(key => Boolean(env[key]));
  checks.push({
    name: 'read-only-environment', ok: walletKeys.length === 0,
    detail: walletKeys.length ? `Forbidden wallet variables are set: ${walletKeys.join(', ')}` : 'No wallet private key or mnemonic variables are set',
  });

  // GMGN is a discovery-time dependency only. The Telegram bot is an
  // operator / report interface and must not trigger GMGN discovery or
  // authenticated GMGN checks at startup. When VIERO_SKIP_GMGN_PREFLIGHT
  // is set (the Telegram unit sets this unconditionally) we record a
  // single explicit "skipped" entry and skip every per-chain GMGN call.
  const skipGmgn = env.VIERO_SKIP_GMGN_PREFLIGHT === '1';
  if (skipGmgn) {
    checks.push({
      name: 'gmgn-discovery-skipped', ok: true,
      detail: 'GMGN preflight skipped via VIERO_SKIP_GMGN_PREFLIGHT=1 (Telegram / operator surface only)',
    });
  } else {
    checks.push({
      name: 'gmgn-credential', ok: Boolean(env.GMGN_API_KEY),
      detail: env.GMGN_API_KEY ? 'GMGN_API_KEY is configured' : 'GMGN_API_KEY is missing',
    });
  }

  for (const chainId of options.chains) {
    try {
      const result = await options.smoke(chainId);
      const passed = result.checks?.filter(check => check.ok).length ?? 0;
      const total = result.checks?.length ?? 0;
      checks.push({ name: `rpc-${chainId}`, ok: result.ok,
        detail: result.ok ? `chain ID and ${passed}/${total} deployment contracts verified at block ${result.blockNumber}` : `${passed}/${total} deployment contracts verified` });
    } catch (error) {
      checks.push({ name: `rpc-${chainId}`, ok: false, detail: errorMessage(error) });
    }
    if (skipGmgn) continue;
    if (!env.GMGN_API_KEY) {
      checks.push({ name: `gmgn-${chainId}`, ok: false, detail: 'Skipped because GMGN_API_KEY is missing' });
      continue;
    }
    try {
      const tokens = await options.gmgn(chainId);
      checks.push({ name: `gmgn-${chainId}`, ok: tokens.length > 0,
        detail: tokens.length > 0 ? `Authenticated discovery returned ${tokens.length} token(s)` : 'Authenticated discovery returned no tokens' });
    } catch (error) {
      checks.push({ name: `gmgn-${chainId}`, ok: false, detail: errorMessage(error) });
    }
  }

  return { ok: checks.every(check => check.ok), readOnly: true, deploymentVersion: DEPLOYMENT_VERSION,
    checkedAt: Date.now() / 1000, checks };
}
