/**
 * Pure parts of the Wayback adapter: the CDX and Availability request URLs, CDX JSON parsing, deterministic snapshot
 * selection, timestamps and the digest format. No I/O here.
 */
import { createHash } from 'node:crypto';
import { waybackTimestampToIso } from '@olcys/core';

export { waybackTimestampToIso };
export const DEFAULT_CDX_URL = 'https://web.archive.org/cdx/search/cdx';
export const DEFAULT_AVAILABILITY_URL = 'https://archive.org/wayback/available';
export const DEFAULT_REPLAY_BASE_URL = 'https://web.archive.org/web';
export const CDX_FIELDS = ['timestamp', 'original', 'statuscode', 'digest', 'length', 'mimetype'] as const;
export const CDX_PAGE_LIMIT = 500;

export interface CdxEntry {
  timestamp: string;
  original: string;
  statuscode: string;
  digest: string;
  length: string;
  mimetype: string;
}

const enc = encodeURIComponent;

/** `GET {availabilityUrl}?url=<url>`: the cheap "is there any capture at all" check (one request). */
export function availabilityRequestUrl(availabilityUrl: string, url: string): string {
  return `${availabilityUrl}?url=${enc(url)}`;
}

/**
 * The CDX listing of one URL: only 200 captures, adjacent identical digests collapsed (so only captures in which the
 * content changed are listed). The parameter order is fixed so recorded cassettes keep matching.
 */
export function cdxRequestUrl(
  cdxUrl: string,
  url: string,
  options: { from?: string; resumeKey?: string } = {},
): string {
  const parts = [
    `url=${enc(url)}`,
    'output=json',
    `fl=${enc(CDX_FIELDS.join(','))}`,
    `filter=${enc('statuscode:200')}`,
    'collapse=digest',
    `limit=${CDX_PAGE_LIMIT}`,
    'showResumeKey=true',
    ...(options.from ? [`from=${enc(options.from)}`] : []),
    ...(options.resumeKey ? [`resumeKey=${enc(options.resumeKey)}`] : []),
  ];
  return `${cdxUrl}?${parts.join('&')}`;
}

/** `…/web/<timestamp>id_/<original>`: `id_` returns the archived bytes without the archive's rewriting. */
export function rawSnapshotUrl(
  timestamp: string,
  original: string,
  replayBaseUrl: string = DEFAULT_REPLAY_BASE_URL,
): string {
  return `${replayBaseUrl.replace(/\/+$/, '')}/${timestamp}id_/${original}`;
}

/**
 * Rows of a CDX JSON answer (row 0 names the fields). With `showResumeKey` a continuation is an empty row followed by a
 * row holding the key. Throws for anything that is not that shape, so a changed API never reads as "no captures".
 */
export function parseCdxJson(body: unknown): { entries: CdxEntry[]; resumeKey?: string } {
  if (!Array.isArray(body)) throw new Error('CDX answer is not a JSON array');
  const [header, ...rows] = body as unknown[];
  if (header === undefined) return { entries: [] };
  if (!Array.isArray(header)) throw new Error('CDX answer has no field-name row');
  const names = header.map(String);
  const index = Object.fromEntries(CDX_FIELDS.map((field) => [field, names.indexOf(field)]));
  const missing = CDX_FIELDS.filter((field) => (index[field] ?? -1) < 0);
  if (missing.length) throw new Error(`CDX answer lacks fields: ${missing.join(', ')}`);
  const entries: CdxEntry[] = [];
  let resumeKey: string | undefined;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) throw new Error('CDX answer contains a row that is not an array');
    if (row.length === 0) {
      const next = rows[i + 1];
      if (Array.isArray(next) && typeof next[0] === 'string' && next[0]) resumeKey = next[0];
      break;
    }
    const cell = (field: (typeof CDX_FIELDS)[number]): string => String(row[index[field] ?? -1] ?? '');
    entries.push({
      timestamp: cell('timestamp'),
      original: cell('original'),
      statuscode: cell('statuscode'),
      digest: cell('digest'),
      length: cell('length'),
      mimetype: cell('mimetype'),
    });
  }
  return { entries, ...(resumeKey ? { resumeKey } : {}) };
}

/**
 * At most `max` entries, always the first and the last, the rest evenly spaced by index; ascending and deterministic.
 * Entries are returned unchanged when there are at most `max`.
 */
export function selectSnapshots(entries: readonly CdxEntry[], max: number): CdxEntry[] {
  if (max <= 0) return [];
  if (entries.length <= max) return [...entries];
  if (max === 1) return entries.slice(-1);
  const last = entries.length - 1;
  const picked = new Set<number>();
  for (let i = 0; i < max; i += 1) picked.add(Math.round((i * last) / (max - 1)));
  return [...picked].toSorted((a, b) => a - b).flatMap((i) => (entries[i] ? [entries[i] as CdxEntry] : []));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The CDX digest format: SHA-1 of the bytes, RFC 4648 base32 without padding (always 32 characters). */
export function sha1Base32(bytes: Uint8Array): string {
  const hash = createHash('sha1').update(bytes).digest();
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of hash) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}
