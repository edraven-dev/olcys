/**
 * Safe singletons (master copies) per EVM network, from `@safe-global/safe-deployments` (MIT): every released
 * version, Safe and SafeL2, every deployment type (canonical, EIP-155, zkSync), lower-case. A SafeProxy keeps its
 * singleton in storage slot 0, so slot 0 naming one of these on the same network identifies a Safe account.
 */
import type { ChainId } from '@olcys/core';
import { getSafeL2SingletonDeployments, getSafeSingletonDeployments } from '@safe-global/safe-deployments';

/** Released Safe versions shipped by the pinned package (a test compares the list with the package's assets). */
export const SAFE_VERSIONS = ['1.0.0', '1.1.1', '1.2.0', '1.3.0', '1.4.1', '1.5.0'] as const;

/** Singleton addresses by chain (`evm:<chainId>`). */
export function loadSafeSingletons(): ReadonlyMap<ChainId, ReadonlySet<string>> {
  const byChain = new Map<ChainId, Set<string>>();
  for (const version of SAFE_VERSIONS) {
    for (const deployment of [
      getSafeSingletonDeployments({ version, released: true }),
      getSafeL2SingletonDeployments({ version, released: true }),
    ]) {
      if (!deployment) continue;
      for (const [chainId, addresses] of Object.entries(deployment.networkAddresses)) {
        if (!/^\d+$/.test(chainId)) continue;
        const chain: ChainId = `evm:${Number(chainId)}`;
        const set = byChain.get(chain) ?? new Set<string>();
        for (const address of Array.isArray(addresses) ? addresses : [addresses]) set.add(address.toLowerCase());
        byChain.set(chain, set);
      }
    }
  }
  return byChain;
}
