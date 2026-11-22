/**
 * Enrichment of labels from entity registers. A label's entity name is linked to a register record (ESMA LEI or
 * Polish register number) through the entity map; the lookup fills `euAuthorised`, `fiatCapable` and `plRegistered`
 * only where the label left them undefined, from records valid at the lookup date. Only positive facts are filled:
 * a missing register record does not make an entity unauthorised.
 */
import type { AddressLabel, AddressRef, IsoDateTime, LabelLookup } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { recordValidAt, type EntityRecord } from './entities.ts';

export interface EntityMapEntry {
  entity: string;
  lei?: string;
  rdww?: string;
}
export type EntityMap = readonly EntityMapEntry[];

export interface EntityLookup {
  get(registry: EntityRecord['registry'], key: string): readonly EntityRecord[];
}

export function loadEntityMap(yamlText: string): EntityMap {
  const doc = parseYaml(yamlText) as { entities?: unknown };
  if (!Array.isArray(doc?.entities)) throw new Error('entity map: entities must be a list');
  const entries: EntityMapEntry[] = [];
  for (const [i, e] of (doc.entities as Record<string, unknown>[]).entries()) {
    if (typeof e['entity'] !== 'string' || e['entity'] === '')
      throw new Error(`entity map entities[${i}].entity missing`);
    entries.push({
      entity: e['entity'],
      ...(typeof e['lei'] === 'string' ? { lei: e['lei'].toUpperCase() } : {}),
      ...(typeof e['rdww'] === 'string' ? { rdww: e['rdww'].toUpperCase() } : {}),
    });
  }
  return entries;
}

export class MemoryEntityLookup implements EntityLookup {
  private readonly records = new Map<string, EntityRecord[]>();

  constructor(records: readonly EntityRecord[]) {
    for (const r of records) {
      const key = `${r.registry}:${r.key}`;
      this.records.set(key, [...(this.records.get(key) ?? []), r]);
    }
  }

  get(registry: EntityRecord['registry'], key: string): readonly EntityRecord[] {
    return this.records.get(`${registry}:${key}`) ?? [];
  }
}

export function enrichLabel(label: AddressLabel, entities: EntityLookup, map: EntityMap, date: string): AddressLabel {
  const links = map.filter((m) => m.entity === label.entity);
  if (links.length === 0) return label;
  const valid: EntityRecord[] = [];
  for (const m of links) {
    if (m.lei) valid.push(...entities.get('esma_casps', m.lei));
    if (m.rdww) valid.push(...entities.get('pl_vasp', m.rdww));
  }
  const inForce = valid.filter((r) => recordValidAt(r, date));
  const attributes = { ...label.attributes };
  if (attributes.euAuthorised === undefined && inForce.some((r) => r.registry === 'esma_casps'))
    attributes.euAuthorised = true;
  if (attributes.plRegistered === undefined && inForce.some((r) => r.registry === 'pl_vasp'))
    attributes.plRegistered = true;
  if (attributes.fiatCapable === undefined && inForce.some((r) => r.fiatCapable)) attributes.fiatCapable = true;
  return { ...label, attributes };
}

export function createEnrichedLabelLookup(
  inner: LabelLookup,
  entities: EntityLookup,
  map: EntityMap,
  options: { now?: () => Date } = {},
): LabelLookup {
  const now = options.now ?? ((): Date => new Date());
  return {
    async labelsFor(address: AddressRef, at?: IsoDateTime): Promise<AddressLabel[]> {
      const date = (at ?? now().toISOString()).slice(0, 10);
      const labels = await inner.labelsFor(address, at);
      return labels.map((l) => enrichLabel(l, entities, map, date));
    },
  };
}

/** The entity records an import wrote (`<dir>/<registry>.json`), so they can be loaded without a database table. */
export interface EntityFile {
  registry: EntityRecord['registry'];
  datasetId: string;
  version: string;
  retrievedAt: IsoDateTime;
  contentSha256: string;
  license: string;
  records: EntityRecord[];
}
