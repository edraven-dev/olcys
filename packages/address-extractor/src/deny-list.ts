/**
 * Deny list of addresses that are never evidence about a person (`config/rules/deny-list.v1.yaml`). Extraction
 * rejects test vectors and documentation examples (`documentation_example`); other kinds are left to rule A8.
 */
import {
  chainFamily,
  DenyListSchema,
  parse,
  type ChainId,
  type DenyListConfig,
  type DenyListEntry,
  type DenyListKind,
} from '@olcys/core';
import { parse as parseYaml } from 'yaml';

/** Kinds rejected at extraction time. */
export const EXTRACTION_DENY_KINDS: readonly DenyListKind[] = ['test_vector', 'documentation'];

export interface DenyList {
  readonly version: string;
  readonly size: number;
  /** Entry for a canonical address valid on any of `chains`; EVM entries match every EVM network. */
  find(canonical: string, chains: readonly ChainId[]): DenyListEntry | undefined;
}

function canonicalKey(chain: ChainId, address: string): string {
  return chainFamily(chain) === 'evm' || /^bc1/i.test(address) ? address.toLowerCase() : address;
}

/** Builds a deny list from a validated configuration object. */
export function createDenyList(config: DenyListConfig): DenyList {
  const byAddress = new Map<string, DenyListEntry[]>();
  for (const entry of config.entries) {
    const key = canonicalKey(entry.chain, entry.address);
    byAddress.set(key, [...(byAddress.get(key) ?? []), { ...entry, address: key }]);
  }
  return {
    version: config.version,
    size: config.entries.length,
    find(canonical, chains) {
      const entries = byAddress.get(canonical);
      if (!entries) return undefined;
      return entries.find((entry) =>
        chainFamily(entry.chain) === 'evm'
          ? chains.some((chain) => chainFamily(chain) === 'evm')
          : chains.includes(entry.chain),
      );
    },
  };
}

/** Parses and validates the YAML deny list (throws `ContractError` from `@olcys/core` on invalid content). */
export function parseDenyList(yamlText: string): DenyList {
  return createDenyList(parse(DenyListSchema, parseYaml(yamlText)));
}

export const EMPTY_DENY_LIST: DenyList = createDenyList({ version: 'empty', entries: [] });
