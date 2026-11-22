/**
 * Shared pieces of the label importers: the import context (dataset provenance), a small RFC 4180 CSV reader and
 * per-chain address validation. Importers are pure: text in, labels and warnings out, no network and no storage.
 */
import type { AddressLabel, ChainId, EntityCategory, IsoDate, IsoDateTime, LabelSourceType } from '@olcys/core';
import { newId } from '@olcys/core';
import type { LicenseClass } from '../datasets.ts';
import { canonicalAddress } from '../lookup.ts';

export interface ImportContext {
  datasetId: string;
  /** Git commit, snapshot date or report date. */
  version: string;
  sourceType: LabelSourceType;
  license: string;
  licenseClass: LicenseClass;
  deciding: boolean;
  url: string;
  lastmod: IsoDateTime;
  retrievedAt: IsoDateTime;
  synthetic?: boolean;
  /** Datasets published per asset (OFAC): kept in the provenance so each asset has its own history. */
  asset?: string;
}

export interface ImportResult<T> {
  rows: T[];
  /** Skipped or suspicious input; never fatal. */
  warnings: string[];
}

export function toDateTime(value: string): IsoDateTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function makeLabel(
  ctx: ImportContext,
  fields: {
    chain: ChainId;
    address: string;
    entity: string;
    category: EntityCategory;
    confidence: number;
    attributes?: AddressLabel['attributes'];
    lastmod?: IsoDateTime;
    url?: string;
  },
): AddressLabel {
  return {
    id: newId(),
    address: canonicalAddress({ chain: fields.chain, address: fields.address.trim() }),
    entity: fields.entity,
    category: fields.category,
    attributes: fields.attributes ?? {},
    confidence: fields.confidence,
    provenance: {
      datasetId: ctx.datasetId,
      version: ctx.version,
      sourceType: ctx.sourceType,
      deciding: ctx.deciding,
      url: fields.url ?? ctx.url,
      license: ctx.license,
      lastmod: fields.lastmod ?? ctx.lastmod,
      retrievedAt: ctx.retrievedAt,
      ...(ctx.asset ? { asset: ctx.asset } : {}),
      ...(ctx.synthetic ? { synthetic: true } : {}),
    },
  };
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const BECH32 = '[qpzry9x8gf2tvdw0s3jn54khce6mua7l]';

/** Format check per chain family (the importers do not decode checksums; the extractor does for live data). */
export function validAddress(chain: ChainId, address: string): boolean {
  if (chain.startsWith('evm:')) return /^0x[0-9a-fA-F]{40}$/.test(address);
  switch (chain) {
    case 'bitcoin':
      return new RegExp(`^(bc1${BECH32}{8,87}|[13]${BASE58}{25,34})$`).test(address);
    case 'litecoin':
      return new RegExp(`^(ltc1${BECH32}{8,87}|[LM3]${BASE58}{25,34})$`).test(address);
    case 'bitcoincash':
      return new RegExp(`^((bitcoincash:)?[qp]${BECH32}{41}|[13]${BASE58}{25,34})$`).test(address);
    case 'tron':
      return new RegExp(`^T${BASE58}{33}$`).test(address);
    case 'solana':
      return new RegExp(`^${BASE58}{32,44}$`).test(address);
    case 'monero':
      return new RegExp(`^[48]${BASE58}{94}$`).test(address);
    default:
      return address.length > 0;
  }
}

/** Reads CSV text (RFC 4180: quoted fields, doubled quotes, embedded newlines) into rows of cells. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** `dd/mm/yyyy`, `dd.mm.yyyy` or `yyyy-mm-dd` to an ISO date; undefined when empty or invalid. */
export function parseDate(value: string | undefined): IsoDate | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!y || !m || !d) return undefined;
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? undefined : date;
}
