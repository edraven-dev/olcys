/**
 * The dataset registry (`config/labels/datasets.v1.yaml`) and the import policy: refused datasets (non-commercial,
 * source-available, proprietary) never import, a deciding dataset must pass `decidingAllowed`, and Etherscan-derived
 * data needs an analyst justification and never decides.
 */
import type { LabelSourceType, SourceId } from '@olcys/core';
import { LABEL_SOURCE_TYPES } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import { decidingAllowed, LICENSE_CLASSES, type LicenseClass } from '../datasets.ts';
import type { ImportContext } from './common.ts';

export interface DatasetRegistryEntry {
  datasetId: string;
  sourceType?: LabelSourceType;
  kind: 'labels' | 'entities';
  url: string;
  license: string;
  licenseClass: LicenseClass;
  deciding: boolean;
  enabledByDefault: boolean;
  /** Reason the dataset is refused (it is listed so that the refusal is explicit). */
  refused?: string;
  sourceId?: SourceId;
}

export function loadDatasetRegistry(yamlText: string): DatasetRegistryEntry[] {
  const doc = parseYaml(yamlText) as { datasets?: unknown };
  if (!Array.isArray(doc?.datasets)) throw new Error('dataset registry: datasets must be a list');
  const entries: DatasetRegistryEntry[] = [];
  for (const [i, e] of (doc.datasets as Record<string, unknown>[]).entries()) {
    const where = `dataset registry datasets[${i}]`;
    const str = (key: string): string => {
      const v = e[key];
      if (typeof v !== 'string' || v === '') throw new Error(`${where}.${key} missing`);
      return v;
    };
    if (e['kind'] !== 'labels' && e['kind'] !== 'entities') throw new Error(`${where}.kind invalid`);
    if (!LICENSE_CLASSES.includes(e['licenseClass'] as LicenseClass)) throw new Error(`${where}.licenseClass invalid`);
    const sourceType = e['sourceType'];
    if (sourceType !== undefined && !LABEL_SOURCE_TYPES.includes(sourceType as LabelSourceType)) {
      throw new Error(`${where}.sourceType invalid`);
    }
    entries.push({
      datasetId: str('datasetId'),
      kind: e['kind'],
      url: str('url'),
      license: str('license'),
      licenseClass: e['licenseClass'] as LicenseClass,
      deciding: e['deciding'] === true,
      enabledByDefault: e['enabledByDefault'] === true,
      ...(sourceType ? { sourceType: sourceType as LabelSourceType } : {}),
      ...(typeof e['refused'] === 'string' ? { refused: e['refused'] } : {}),
      ...(typeof e['sourceId'] === 'string' ? { sourceId: e['sourceId'] } : {}),
    });
  }
  return entries;
}

export type ImportRefusal =
  | { ok: false; reason: 'unknown_dataset'; message: string }
  | { ok: false; reason: 'dataset_licence_refused'; message: string }
  | { ok: false; reason: 'justification_required'; message: string };

export type ImportPolicyResult = { ok: true; entry: DatasetRegistryEntry } | ImportRefusal;

export function checkImportPolicy(
  registry: readonly DatasetRegistryEntry[],
  datasetId: string,
  options: { justification?: string } = {},
): ImportPolicyResult {
  const entry = registry.find((e) => e.datasetId === datasetId);
  if (!entry) return { ok: false, reason: 'unknown_dataset', message: `unknown dataset ${datasetId}` };
  if (entry.refused) {
    return {
      ok: false,
      reason: 'dataset_licence_refused',
      message: `dataset_licence_refused: ${datasetId} (${entry.license}): ${entry.refused}`,
    };
  }
  if (entry.kind === 'labels') {
    const meta = { licenseClass: entry.licenseClass, sourceType: entry.sourceType ?? 'curated' };
    if (entry.deciding && !decidingAllowed(meta)) {
      return {
        ok: false,
        reason: 'dataset_licence_refused',
        message: `dataset_licence_refused: ${datasetId} (${entry.licenseClass}) may not decide`,
      };
    }
  }
  if (!entry.enabledByDefault && !options.justification?.trim()) {
    return {
      ok: false,
      reason: 'justification_required',
      message: `${datasetId} is disabled by default: import it with a written justification`,
    };
  }
  return { ok: true, entry };
}

/** Import context of a registry entry; the version is a git commit, snapshot date or report date. */
export function importContext(
  entry: DatasetRegistryEntry,
  options: { version: string; retrievedAt: string; lastmod?: string; url?: string; datasetId?: string },
): ImportContext {
  return {
    datasetId: options.datasetId ?? entry.datasetId,
    version: options.version,
    sourceType: entry.sourceType ?? 'curated',
    license: entry.license,
    licenseClass: entry.licenseClass,
    deciding: entry.deciding,
    url: options.url ?? entry.url,
    lastmod: options.lastmod ?? options.retrievedAt,
    retrievedAt: options.retrievedAt,
  };
}
