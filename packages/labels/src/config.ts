/**
 * Loaders for `config/rules/deny-list.v1.yaml` and `config/rules/exclusion.v1.yaml`. Every parameter the rules use
 * comes from these files; the SHA-256 of the rule file is recorded with each run.
 */
import { createHash } from 'node:crypto';
import type { AddressRef, DecimalString, Sha256Hex } from '@olcys/core';
import { isChainId, isDecimalString } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { canonicalAddress, chainMatches } from './lookup.ts';

export const DENY_KINDS = ['test_vector', 'documentation', 'burn', 'token_contract'] as const;
export type DenyKind = (typeof DENY_KINDS)[number];

/** Same shape as the core deny-list schema: `{ chain, address, kind, name, source }`. */
export interface DenyEntry {
  chain: AddressRef['chain'];
  address: string;
  kind: DenyKind;
  name: string;
  source: string;
}

export interface DenyList {
  version: string;
  entries: readonly DenyEntry[];
  /** Exact canonical match; EVM entries apply to every EVM network (and to `evm:unknown`). */
  match(address: AddressRef): DenyEntry | undefined;
}

const evm = (chain: string): boolean => chain.startsWith('evm:');
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function loadDenyList(yamlText: string): DenyList {
  const doc = parseYaml(yamlText) as { version?: unknown; entries?: unknown };
  if (typeof doc?.version !== 'string') throw new Error('deny list: missing version');
  if (!Array.isArray(doc.entries)) throw new Error('deny list: entries must be a list');
  const entries = (doc.entries as Record<string, unknown>[]).map((e, i): DenyEntry => {
    const where = `deny list entries[${i}]`;
    if (!isChainId(e['chain'])) throw new Error(`${where}.chain invalid`);
    if (typeof e['address'] !== 'string' || e['address'] === '') throw new Error(`${where}.address missing`);
    if (!DENY_KINDS.includes(e['kind'] as DenyKind)) throw new Error(`${where}.kind ${String(e['kind'])} unknown`);
    const ref = canonicalAddress({ chain: e['chain'], address: e['address'] });
    return {
      chain: ref.chain,
      address: ref.address,
      kind: e['kind'] as DenyKind,
      name: typeof e['name'] === 'string' ? e['name'] : '',
      source: typeof e['source'] === 'string' ? e['source'] : '',
    };
  });
  return {
    version: doc.version,
    entries,
    match(address: AddressRef): DenyEntry | undefined {
      const query = canonicalAddress(address);
      return entries.find(
        (e) =>
          e.address === query.address && (chainMatches(query.chain, e.chain) || (evm(e.chain) && evm(query.chain))),
      );
    },
  };
}

export interface ExclusionRulesConfig {
  version: string;
  sha256: Sha256Hex;
  a1: { trustOrder: string[] };
  a2: { keepAttributable: string[] };
  /** Record the delegate of an EIP-7702 delegated account; flag delegates listed as sweepers. */
  a3: { recordDelegate: boolean; flagKnownSweepers: boolean };
  a4: { tauBlocks: number; alpha: DecimalString };
}

export function loadExclusionRules(yamlText: string): ExclusionRulesConfig {
  const doc = parseYaml(yamlText) as { version?: unknown; rules?: Record<string, Record<string, unknown>> };
  if (typeof doc?.version !== 'string' || !doc.rules) throw new Error('exclusion rules: missing version or rules');
  const rule = (key: string): Record<string, unknown> => {
    const found = doc.rules?.[key];
    if (!found) throw new Error(`exclusion rules: ${key} missing`);
    return found;
  };
  const a3 = rule('A3_delegated_eoa');
  const flag = (key: string): boolean => {
    const value = a3[key];
    if (value === undefined) return true;
    if (typeof value !== 'boolean') throw new Error(`exclusion rules: A3 ${key} must be true or false`);
    return value;
  };
  const a4 = rule('A4_exchange_deposit');
  const tauBlocks = Number(a4['tauBlocks']);
  const alpha = String(a4['alphaMaxAmountDiff']);
  if (!Number.isInteger(tauBlocks) || tauBlocks <= 0) throw new Error('exclusion rules: A4 tauBlocks invalid');
  if (!isDecimalString(alpha)) throw new Error('exclusion rules: A4 alphaMaxAmountDiff invalid');
  return {
    version: doc.version,
    sha256: createHash('sha256').update(yamlText).digest('hex'),
    a1: { trustOrder: list(rule('A1_labelled_service')['trustOrder']) },
    a2: { keepAttributable: list(rule('A2_service_contract')['keepAttributable']) },
    a3: { recordDelegate: flag('recordDelegate'), flagKnownSweepers: flag('flagKnownSweepers') },
    a4: { tauBlocks, alpha },
  };
}
