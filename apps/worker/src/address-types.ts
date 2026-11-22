/**
 * Address types of the chain analysis: the classifier of `@olcys/labels` starts from the code the chain fetch read
 * and probes through the provider that served it, so every probe goes through the run's egress client like the fetch
 * itself (logged, identifying). An address whose fetch failed stays `unknown` without further requests.
 */
import type { AssetRegistry } from '@olcys/analytics';
import type { ChainFetchResult, ChainProviderRegistry } from '@olcys/chain-adapters';
import type { AddressRef, AddressTypeClassification, LabelLookup, RunContext } from '@olcys/core';
import { addressKey } from '@olcys/core';
import { classifyAddress } from '@olcys/labels';

export interface AddressTypeDeps {
  providers: ChainProviderRegistry;
  labels: LabelLookup;
  assets: AssetRegistry;
  safeSingletons: ReadonlyMap<string, ReadonlySet<string>>;
  entryPoints: ReadonlySet<string>;
}

/** Token contracts of the asset registry, identified by chain and contract. */
export function tokenContracts(assets: AssetRegistry): { isToken(address: AddressRef): boolean } {
  return {
    isToken: (a) => assets.resolve({ chain: a.chain, symbol: '', decimals: 0, contract: a.address }) !== undefined,
  };
}

/** One classification per address as fetched (keyed by `addressKey`), in the order given. */
export async function classifyFetched(
  addresses: readonly AddressRef[],
  fetched: Pick<ChainFetchResult, 'codes'>,
  deps: AddressTypeDeps,
  ctx: RunContext,
): Promise<Map<string, AddressTypeClassification>> {
  const assets = tokenContracts(deps.assets);
  const out = new Map<string, AddressTypeClassification>();
  for (const address of addresses) {
    const key = addressKey(address);
    if (out.has(key)) continue;
    const code = fetched.codes.find((c) => addressKey(c.address) === key);
    const provider = code ? deps.providers.get(code.providerId) : undefined;
    // Sequential on purpose: the probes of one address follow each other, so the egress log stays in order.
    // oxlint-disable-next-line no-await-in-loop
    const classification = await classifyAddress(
      address,
      {
        ...(provider ? { provider } : {}),
        labels: deps.labels,
        assets,
        safeSingletons: deps.safeSingletons,
        entryPoints: deps.entryPoints,
        ...(code ? { code: { code: code.code, fetchId: code.fetchId } } : {}),
      },
      ctx,
    );
    out.set(key, classification);
  }
  return out;
}
