import type { ChainId, ChainProvider, SourceId } from '@olcys/core';
import type { ChainProviderConfig, ProviderDeps } from './config.ts';
import { createEsploraProvider } from './esplora.ts';
import { createEtherscanProvider } from './etherscan.ts';
import { createTronGridProvider } from './trongrid.ts';

export function createChainProvider(config: ChainProviderConfig, deps: ProviderDeps = {}): ChainProvider {
  switch (config.kind) {
    case 'esplora':
      return createEsploraProvider(config, deps);
    case 'etherscan':
      return createEtherscanProvider(config, deps);
    case 'trongrid':
      return createTronGridProvider(config, deps);
  }
}

/** Providers by chain, in priority order, filtered by the sources enabled for the case. */
export class ChainProviderRegistry {
  private readonly entries: { provider: ChainProvider; config: ChainProviderConfig }[] = [];

  register(provider: ChainProvider, config: ChainProviderConfig): void {
    if (this.entries.some((e) => e.config.id === config.id)) throw new Error(`provider ${config.id} registered twice`);
    this.entries.push({ provider, config });
  }

  forChain(chain: ChainId, enabledSources: readonly SourceId[]): ChainProvider[] {
    return this.entries
      .filter((e) => e.config.chains.includes(chain) && enabledSources.includes(e.config.sourceId))
      .toSorted((a, b) => a.config.priority - b.config.priority)
      .map((e) => e.provider);
  }

  get(id: string): ChainProvider | undefined {
    return this.entries.find((e) => e.config.id === id)?.provider;
  }

  configOf(id: string): ChainProviderConfig | undefined {
    return this.entries.find((e) => e.config.id === id)?.config;
  }
}

export function createChainProviderRegistry(
  configs: readonly ChainProviderConfig[],
  deps: ProviderDeps = {},
): ChainProviderRegistry {
  const registry = new ChainProviderRegistry();
  for (const config of configs) registry.register(createChainProvider(config, deps), config);
  return registry;
}
