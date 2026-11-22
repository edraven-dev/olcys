/**
 * Reference registries of the address-type classifier and rule A3 (`config/labels/`): the ERC-4337 EntryPoint
 * singletons and the EIP-7702 delegates (wallet implementations and known sweepers). Every entry names its primary
 * source; only synthetic demo entries may go without a URL.
 */
import type { ChainId } from '@olcys/core';
import { addressKey, isChainId } from '@olcys/core';
import { parse as parseYaml } from 'yaml';

export const DELEGATE_KINDS = ['wallet_implementation', 'sweeper'] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

export interface DelegateInfo {
  /** `evm:<chainId>`; `evm:unknown` applies to every EVM network (one deterministic deployment address). */
  chain: ChainId;
  /** Lower-case. */
  address: string;
  kind: DelegateKind;
  name: string;
  /** Primary source (URL), or a note for a synthetic entry. */
  source: string;
  synthetic?: boolean;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const HTTPS = /^https:\/\/\S+$/;

function entriesOf(yamlText: string, what: string, key: string): Record<string, unknown>[] {
  const doc = parseYaml(yamlText) as Record<string, unknown> | null;
  if (typeof doc?.['version'] !== 'string') throw new Error(`${what}: missing version`);
  const entries = doc[key];
  if (!Array.isArray(entries)) throw new Error(`${what}: ${key} must be a list`);
  return entries.map((e: unknown) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : {}));
}

/** Parses `config/labels/eip7702-delegates.v1.yaml`; keys are `addressKey` of chain and lower-case delegate. */
export function loadDelegateRegistry(yamlText: string): ReadonlyMap<string, DelegateInfo> {
  const registry = new Map<string, DelegateInfo>();
  entriesOf(yamlText, 'delegate registry', 'delegates').forEach((e, i) => {
    const where = `delegate registry delegates[${i}]`;
    const chain = e['chain'];
    if (!isChainId(chain) || !chain.startsWith('evm:')) throw new Error(`${where}.chain must be an EVM chain id`);
    const address = typeof e['address'] === 'string' ? e['address'] : '';
    if (!EVM_ADDRESS.test(address)) throw new Error(`${where}.address must be a 20-byte hex address`);
    const kind = e['kind'];
    if (!DELEGATE_KINDS.includes(kind as DelegateKind)) throw new Error(`${where}.kind ${String(kind)} unknown`);
    const name = typeof e['name'] === 'string' ? e['name'].trim() : '';
    if (!name) throw new Error(`${where}.name missing`);
    const synthetic = e['synthetic'] === true;
    const source = typeof e['source'] === 'string' ? e['source'].trim() : '';
    // A real delegate is listed only with its primary source.
    if (!(synthetic ? source !== '' : HTTPS.test(source))) throw new Error(`${where}.source must be an https URL`);
    const info: DelegateInfo = {
      chain,
      address: address.toLowerCase(),
      kind: kind as DelegateKind,
      name,
      source,
      ...(synthetic ? { synthetic } : {}),
    };
    const key = addressKey(info);
    if (registry.has(key)) throw new Error(`${where}: ${key} is listed twice`);
    registry.set(key, info);
  });
  return registry;
}

/** The registry entry of `delegate` on `chain`: the network's own entry first, then one valid on every EVM network. */
export function findDelegate(
  registry: ReadonlyMap<string, DelegateInfo>,
  chain: ChainId,
  delegate: string,
): DelegateInfo | undefined {
  const address = delegate.toLowerCase();
  return registry.get(addressKey({ chain, address })) ?? registry.get(addressKey({ chain: 'evm:unknown', address }));
}

/**
 * Parses `config/labels/erc4337-entrypoints.v1.yaml`: lower-case EntryPoint addresses (deterministic deployments,
 * the same on every EVM network).
 */
export function loadEntryPoints(yamlText: string): ReadonlySet<string> {
  const set = new Set<string>();
  entriesOf(yamlText, 'entry points', 'entryPoints').forEach((e, i) => {
    const where = `entry points entryPoints[${i}]`;
    const address = typeof e['address'] === 'string' ? e['address'] : '';
    if (!EVM_ADDRESS.test(address)) throw new Error(`${where}.address must be a 20-byte hex address`);
    if (typeof e['version'] !== 'string' || e['version'] === '') throw new Error(`${where}.version missing`);
    if (typeof e['source'] !== 'string' || !HTTPS.test(e['source'])) {
      throw new Error(`${where}.source must be an https URL`);
    }
    set.add(address.toLowerCase());
  });
  return set;
}
