/**
 * Exchange proof-of-reserves CSV files (self-disclosed by the publisher, versioned by report date). The address table
 * follows a per-coin totals block, so it starts at the header row that contains the address column. Signatures are
 * not verified.
 */
import type { AddressLabel, ChainId, EntityCategory } from '@olcys/core';
import { addressKey, ENTITY_CATEGORIES } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { makeLabel, parseCsv, validAddress, type ImportContext, type ImportResult } from './common.ts';

export interface PorProfile {
  entity: string;
  category: EntityCategory;
  confidence: number;
  addressColumn: string;
  networkColumn: string;
  /** Network column value to chain; any other network is skipped. */
  networks: Record<string, ChainId>;
}

export function loadPorProfiles(yamlText: string): Record<string, PorProfile> {
  const doc = parseYaml(yamlText) as { profiles?: Record<string, Record<string, unknown>> };
  if (!doc?.profiles) throw new Error('PoR profiles: profiles missing');
  const out: Record<string, PorProfile> = {};
  for (const [name, p] of Object.entries(doc.profiles)) {
    const category = p['category'] as EntityCategory;
    if (typeof p['entity'] !== 'string' || !ENTITY_CATEGORIES.includes(category)) {
      throw new Error(`PoR profile ${name}: entity or category invalid`);
    }
    out[name] = {
      entity: p['entity'],
      category,
      confidence: Number(p['confidence'] ?? 95),
      addressColumn: String(p['addressColumn'] ?? 'address'),
      networkColumn: String(p['networkColumn'] ?? 'Network'),
      networks: (p['networks'] ?? {}) as Record<string, ChainId>,
    };
  }
  return out;
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

export function parsePorCsv(csv: string, profile: PorProfile, ctx: ImportContext): ImportResult<AddressLabel> {
  const table = parseCsv(csv);
  const headerAt = table.findIndex((row) => row.some((c) => norm(c) === norm(profile.addressColumn)));
  if (headerAt < 0) throw new Error(`PoR file: no header row with column ${profile.addressColumn}`);
  const header = table[headerAt] as string[];
  const addressCol = header.findIndex((c) => norm(c) === norm(profile.addressColumn));
  const networkCol = header.findIndex((c) => norm(c) === norm(profile.networkColumn));
  if (networkCol < 0) throw new Error(`PoR file: column ${profile.networkColumn} missing`);
  const rows: AddressLabel[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const skipped = new Map<string, number>();
  for (const row of table.slice(headerAt + 1)) {
    const network = (row[networkCol] ?? '').trim();
    const address = (row[addressCol] ?? '').trim();
    if (!address) continue;
    const chain = profile.networks[network];
    if (!chain) {
      skipped.set(network || '(none)', (skipped.get(network || '(none)') ?? 0) + 1);
      continue;
    }
    if (!validAddress(chain, address)) {
      warnings.push(`PoR ${profile.entity}: invalid ${chain} address ${address}, skipped`);
      continue;
    }
    const label = makeLabel(ctx, {
      chain,
      address,
      entity: profile.entity,
      category: profile.category,
      confidence: profile.confidence,
      attributes: { custodial: true },
    });
    if (seen.has(addressKey(label.address))) continue;
    seen.add(addressKey(label.address));
    rows.push(label);
  }
  for (const [network, count] of skipped)
    warnings.push(`PoR ${profile.entity}: ${count} row(s) on unsupported network ${network} skipped`);
  return { rows, warnings };
}
