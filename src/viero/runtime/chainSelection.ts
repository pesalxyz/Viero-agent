import type { ChainId } from '../domain.js';

/**
 * Return the chains allowed by the service's configured universe and the
 * operator's persisted chain selection.  The persisted selection is the
 * source of truth for a running agent; the service universe only limits what
 * the process is allowed to operate on.
 */
export function selectedRuntimeChains(
  serviceChains: readonly ChainId[],
  enabledChains: readonly ChainId[] | null | undefined,
): ChainId[] {
  const enabled = new Set(enabledChains ?? []);
  return [...new Set(serviceChains)].filter(chainId => enabled.has(chainId));
}
