/**
 * Synthetic Internet Archive for the fixture site: Availability and CDX answers and raw (`id_`) snapshots of the
 * persona's forum profile. The snapshots are rendered from templates; the CDX digests are computed from the rendered
 * bytes (SHA-1, RFC 4648 base32 without padding), so the adapter's digest check reports `match`.
 */
import { createHash } from 'node:crypto';
import { SYNTHETIC_MARK, type FixtureRouteOut } from './chain.ts';

/** Live URL of the archived page (the persona's forum profile). */
export const WAYBACK_ORIGINAL = 'https://bitcointalk.org/index.php?action=profile;u=900001';
const ORIGINAL_PATH = '/index.php';
const ORIGINAL_QUERY = 'action=profile;u=900001';
const ORIGINAL_BASE = 'https://bitcointalk.org';

/** Distinct-content captures, ascending: the profile without a wallet, then with BTC-1 (v1 live shows BTC-1 too). */
export const WAYBACK_TIMESTAMPS = ['20240312101500', '20250102030405'] as const;

const snapshotFile = (timestamp: string): string => `wayback/snapshots/profile-900001-${timestamp}.html`;

function sha1Base32(text: string): string {
  const hash = createHash('sha1').update(text).digest();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of hash) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Generated answer files (relative to `public/shared/`), from the rendered snapshot templates. */
export function waybackFiles(rendered: ReadonlyMap<string, string>): Map<string, string> {
  const rows = WAYBACK_TIMESTAMPS.map((timestamp) => {
    const body = rendered.get(`shared/${snapshotFile(timestamp)}`);
    if (body === undefined) throw new Error(`missing snapshot template for ${timestamp}`);
    return [timestamp, WAYBACK_ORIGINAL, '200', sha1Base32(body), String(Buffer.byteLength(body)), 'text/html'];
  });
  const latest = WAYBACK_TIMESTAMPS.at(-1) ?? '';
  const files = new Map<string, string>();
  files.set(
    'shared/wayback/cdx/profile-900001.json',
    json([['timestamp', 'original', 'statuscode', 'digest', 'length', 'mimetype'], ...rows]),
  );
  files.set('shared/wayback/cdx/none.json', '[]\n');
  files.set(
    'shared/wayback/available/profile-900001.json',
    json({
      _synthetic: SYNTHETIC_MARK,
      url: WAYBACK_ORIGINAL,
      archived_snapshots: {
        closest: {
          status: '200',
          available: true,
          url: `http://web.archive.org/web/${latest}/${WAYBACK_ORIGINAL}`,
          timestamp: latest,
        },
      },
    }),
  );
  files.set(
    'shared/wayback/available/none.json',
    json({ _synthetic: SYNTHETIC_MARK, url: '', archived_snapshots: {} }),
  );
  return files;
}

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

/** Routes of the synthetic archive: `web.archive.org` is served under `/wayback`, `archive.org` under `/archive-org`. */
export function waybackRoutes(): FixtureRouteOut[] {
  return [
    {
      path: '/wayback/cdx/search/cdx',
      params: { url: WAYBACK_ORIGINAL },
      headers: JSON_TYPE,
      file: 'wayback/cdx/profile-900001.json',
    },
    // Every other page is unknown to the synthetic archive.
    { path: '/wayback/cdx/search/cdx', headers: JSON_TYPE, file: 'wayback/cdx/none.json' },
    {
      path: '/archive-org/wayback/available',
      params: { url: WAYBACK_ORIGINAL },
      headers: JSON_TYPE,
      file: 'wayback/available/profile-900001.json',
    },
    { path: '/archive-org/wayback/available', headers: JSON_TYPE, file: 'wayback/available/none.json' },
    ...WAYBACK_TIMESTAMPS.map((timestamp) => ({
      path: `/wayback/web/${timestamp}id_/${ORIGINAL_BASE}${ORIGINAL_PATH}`,
      query: ORIGINAL_QUERY,
      file: snapshotFile(timestamp),
    })),
  ];
}
