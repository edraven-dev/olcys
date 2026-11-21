/**
 * Label datasets, their licence policy and the loader for label files such as `fixtures/labels/demo-curated.json`.
 * Whether a dataset may decide an exclusion on its own is policy (licence class + kind), recorded on every label.
 */
import type { AddressLabel, AddressRef, EntityCategory, IsoDateTime, LabelSourceType } from '@olcys/core';
import { ENTITY_CATEGORIES, isChainId, newId } from '@olcys/core';
import { canonicalAddress } from './lookup.ts';

export const LICENSE_CLASSES = [
  'open',
  'public_domain',
  'publisher_disclosure',
  'unknown',
  'non_commercial',
  'source_available',
  'proprietary',
] as const;
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

export interface LabelDatasetMeta {
  datasetId: string;
  version: string;
  sourceType: LabelSourceType;
  license: string;
  licenseClass: LicenseClass;
  /** Requested: the dataset decides exclusions. Refused unless `decidingAllowed`. */
  deciding: boolean;
  synthetic?: boolean;
}

/** Only open, public-domain or self-disclosed data may decide; Etherscan-derived labels only corroborate. */
export function decidingAllowed(meta: Pick<LabelDatasetMeta, 'licenseClass' | 'sourceType'>): boolean {
  if (meta.sourceType === 'etherscan_derived') return false;
  return (
    meta.licenseClass === 'open' ||
    meta.licenseClass === 'public_domain' ||
    meta.licenseClass === 'publisher_disclosure'
  );
}

/**
 * The synthetic demo dataset: the fictional operators self-disclose their wallets like a proof-of-reserves file
 * (kind `por_file`), released as CC0-1.0, so it may decide A1 exclusions.
 */
export const DEMO_CURATED_DATASET: LabelDatasetMeta = {
  datasetId: 'demo-curated',
  version: 'v1',
  sourceType: 'por_file',
  license: 'CC0-1.0',
  licenseClass: 'open',
  deciding: true,
  synthetic: true,
};

interface LabelFileEntry {
  address?: { chain?: unknown; address?: unknown };
  entity?: unknown;
  category?: unknown;
  attributes?: unknown;
  confidence?: unknown;
}

/**
 * Parses a label file `{ dataset: { datasetId, url, license, lastmod }, labels: [{ address, entity, category,
 * attributes, confidence }] }` into labels with full provenance. EVM addresses are lower-cased. Errors name the
 * failing entry and field.
 */
export function loadLabelDataset(
  text: string,
  meta: LabelDatasetMeta,
  options: { retrievedAt: IsoDateTime },
): AddressLabel[] {
  if (meta.deciding && !decidingAllowed(meta)) {
    throw new Error(
      `dataset_licence_refused: ${meta.datasetId} (${meta.licenseClass}, ${meta.sourceType}) may not decide`,
    );
  }
  const doc = JSON.parse(text) as { dataset?: Record<string, unknown>; labels?: unknown };
  const dataset = doc.dataset ?? {};
  if (dataset['datasetId'] !== meta.datasetId) {
    throw new Error(`label file is dataset ${String(dataset['datasetId'])}, expected ${meta.datasetId}`);
  }
  if (!Array.isArray(doc.labels)) throw new Error('label file: labels must be a list');
  const url = typeof dataset['url'] === 'string' ? dataset['url'] : '';
  const lastmod = typeof dataset['lastmod'] === 'string' ? dataset['lastmod'] : options.retrievedAt;
  const license = typeof dataset['license'] === 'string' ? dataset['license'] : meta.license;
  return (doc.labels as LabelFileEntry[]).map((entry, i): AddressLabel => {
    const where = `labels[${i}]`;
    const chain = entry.address?.chain;
    const raw = entry.address?.address;
    if (!isChainId(chain)) throw new Error(`${where}.address.chain: invalid chain ${String(chain)}`);
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${where}.address.address: missing`);
    const address: AddressRef = canonicalAddress({ chain, address: raw.trim() });
    if (chain.startsWith('evm:') && !/^0x[0-9a-f]{40}$/.test(address.address)) {
      throw new Error(`${where}.address.address: malformed EVM address`);
    }
    if (typeof entry.entity !== 'string' || entry.entity === '') throw new Error(`${where}.entity: missing`);
    if (!ENTITY_CATEGORIES.includes(entry.category as EntityCategory)) {
      throw new Error(`${where}.category: unknown category ${String(entry.category)}`);
    }
    const confidence = Number(entry.confidence ?? 100);
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
      throw new Error(`${where}.confidence: must be an integer 0–100`);
    }
    return {
      id: newId(),
      address,
      entity: entry.entity,
      category: entry.category as EntityCategory,
      attributes: (entry.attributes ?? {}) as AddressLabel['attributes'],
      confidence,
      provenance: {
        datasetId: meta.datasetId,
        version: meta.version,
        sourceType: meta.sourceType,
        deciding: meta.deciding,
        url,
        license,
        lastmod,
        retrievedAt: options.retrievedAt,
        ...(meta.synthetic ? { synthetic: true } : {}),
      },
    };
  });
}
