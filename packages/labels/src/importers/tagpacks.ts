/**
 * GraphSense TagPacks (MIT) and ActorPacks. Header fields are defaults for each `tags[]` entry; non-public packs are
 * skipped, unsupported currencies are skipped with one warning each, confidence ids map to 0–100 through the pinned
 * `confidence.csv`, and an actor's `end_activity` becomes `activeTo` on its tags.
 */
import type { AddressLabel, ChainId, EntityCategory } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { makeLabel, parseCsv, toDateTime, validAddress, type ImportContext, type ImportResult } from './common.ts';

export interface ActorInfo {
  id: string;
  label: string;
  /** Last day of activity (`end_activity`). */
  endActivity?: string;
}
export type ActorIndex = ReadonlyMap<string, ActorInfo>;

const CHAINS: Record<string, ChainId> = {
  BTC: 'bitcoin',
  ETH: 'evm:1',
  TRX: 'tron',
  LTC: 'litecoin',
  BCH: 'bitcoincash',
};

const P2P_ACTORS = new Set(['bisq', 'hodlhodl', 'paxful', 'localbitcoins', 'noones']);

const CATEGORY: Record<string, EntityCategory> = {
  exchange: 'exchange',
  payment_processor: 'payment_gateway',
  defi_dex: 'defi_dex',
  defi_bridge: 'bridge',
  defi_lending: 'smart_contract',
  defi_derivative: 'smart_contract',
  defi: 'smart_contract',
  mixing_service: 'mixer',
  coinjoin: 'mixer',
  gambling: 'gambling',
  miner: 'mining_pool',
  mining_service: 'mining_pool',
  ransomware: 'scam',
  social_engineering: 'scam',
  hacks: 'scam',
  scam: 'scam',
  wallet_service: 'unknown_service',
};

export function parseActorPack(yamlText: string): ActorIndex {
  const doc = (parseYaml(yamlText) ?? {}) as { actors?: unknown };
  const index = new Map<string, ActorInfo>();
  if (!Array.isArray(doc.actors)) return index;
  for (const raw of doc.actors as Record<string, unknown>[]) {
    if (typeof raw['id'] !== 'string') continue;
    const end = raw['end_activity'];
    index.set(raw['id'], {
      id: raw['id'],
      label: typeof raw['label'] === 'string' ? raw['label'] : raw['id'],
      ...(typeof end === 'string' ? { endActivity: end.slice(0, 10) } : {}),
    });
  }
  return index;
}

/** `confidence.csv` (`id,…,level`) to a map from confidence id to a 0–100 level. */
export function parseConfidenceCsv(csv: string): Map<string, number> {
  const [header, ...rows] = parseCsv(csv);
  const id = header?.findIndex((h) => h.trim() === 'id') ?? -1;
  const level = header?.findIndex((h) => h.trim() === 'level') ?? -1;
  if (id < 0 || level < 0) throw new Error('confidence.csv: id and level columns are required');
  const map = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row[level]);
    if (row[id] && Number.isInteger(n) && n >= 0 && n <= 100) map.set(row[id].trim(), n);
  }
  return map;
}

const UNKNOWN_CONFIDENCE = 10;
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function parseTagPack(
  yamlText: string,
  ctx: ImportContext,
  deps: { actors: ActorIndex; confidence: ReadonlyMap<string, number> },
): ImportResult<AddressLabel> {
  const warnings: string[] = [];
  const doc = parseYaml(yamlText) as Record<string, unknown> | null;
  const title = text(doc?.['title']) ?? 'tagpack';
  if (!doc || !Array.isArray(doc['tags'])) throw new Error(`tagpack ${title}: tags must be a list`);
  if (doc['is_public'] === false) {
    warnings.push(`tagpack ${title}: is_public is false, skipped`);
    return { rows: [], warnings };
  }
  const rows: AddressLabel[] = [];
  const skippedCurrency = new Map<string, number>();
  const unknownConfidence = new Set<string>();
  for (const [i, tag] of (doc['tags'] as Record<string, unknown>[]).entries()) {
    const currency = (
      text(tag['network']) ??
      text(tag['currency']) ??
      text(doc['network']) ??
      text(doc['currency']) ??
      ''
    ).toUpperCase();
    const chain = CHAINS[currency];
    if (!chain) {
      skippedCurrency.set(currency || '(none)', (skippedCurrency.get(currency || '(none)') ?? 0) + 1);
      continue;
    }
    const address = text(tag['address']);
    if (!address || !validAddress(chain, address)) {
      warnings.push(`tagpack ${title}: tags[${i}] has an invalid ${chain} address, skipped`);
      continue;
    }
    const actorId = text(tag['actor']) ?? text(doc['actor']);
    const actor = actorId ? deps.actors.get(actorId) : undefined;
    const categoryKey = text(tag['category']) ?? text(doc['category']) ?? '';
    const category: EntityCategory =
      actorId && P2P_ACTORS.has(actorId) ? 'p2p_exchange' : (CATEGORY[categoryKey] ?? 'unknown_service');
    const entity = actor?.label ?? text(tag['label']) ?? actorId;
    if (!entity) {
      warnings.push(`tagpack ${title}: tags[${i}] has no label or actor, skipped`);
      continue;
    }
    const confidenceId = text(tag['confidence']) ?? text(doc['confidence']) ?? '';
    let confidence = deps.confidence.get(confidenceId);
    if (confidence === undefined) {
      confidence = UNKNOWN_CONFIDENCE;
      unknownConfidence.add(confidenceId || '(none)');
    }
    const lastmod = text(tag['lastmod']) ?? text(doc['lastmod']);
    rows.push(
      makeLabel(ctx, {
        chain,
        address,
        entity,
        category,
        confidence,
        attributes: {
          ...(categoryKey === 'exchange' || categoryKey === 'wallet_service' ? { custodial: true } : {}),
          ...(actor?.endActivity ? { activeTo: actor.endActivity } : {}),
        },
        ...(lastmod ? { lastmod: toDateTime(lastmod) } : {}),
        ...(text(tag['source']) ? { url: text(tag['source']) as string } : {}),
      }),
    );
  }
  for (const [currency, count] of skippedCurrency) {
    warnings.push(`tagpack ${title}: ${count} tag(s) on unsupported currency ${currency} skipped`);
  }
  for (const id of unknownConfidence) {
    warnings.push(`tagpack ${title}: unknown confidence ${id}, using ${UNKNOWN_CONFIDENCE}`);
  }
  return { rows, warnings };
}
