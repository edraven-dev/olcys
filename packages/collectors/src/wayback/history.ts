/**
 * The archive history of a case's pages for the timeline: one entry per distinct-content snapshot the CDX listing
 * named, joined with the snapshot capture (when it was fetched) and the digest check. Facts (the listing) and
 * computations (the digest check) stay separate observations; this function only joins them.
 */
import type { Capture, Id, IsoDateTime, Observation } from '@olcys/core';
import { waybackTimestampToIso } from './cdx.ts';

export const WAYBACK_PROPERTIES = {
  snapshot: 'archive.snapshot',
  digest: 'archive.digest',
  digestCheck: 'computed.archive_digest_check',
} as const;

export interface WaybackHistoryEntry {
  originalUrl: string;
  snapshotTimestamp: string;
  at: IsoDateTime;
  /** CDX digest of the snapshot's content. */
  digest: string;
  fetched: boolean;
  captureId?: Id;
  digestCheck: 'match' | 'mismatch' | 'not_checked';
}

/** Locator shared by all observations about one snapshot. */
export const waybackLocator = (originalUrl: string, timestamp: string): string => `wayback:${originalUrl}@${timestamp}`;

/**
 * Which of several fetches of the same snapshot speaks for it: a usable one (status ok, digest not mismatched) beats
 * a failed or untrusted one; among equals the newest wins. Independent of the order of `captures`.
 */
function preferred(a: Capture, b: Capture, mismatched: ReadonlySet<string>): Capture {
  const rank = (c: Capture): number => (c.status === 'ok' ? (mismatched.has(c.id) ? 1 : 2) : 0);
  const order = rank(a) - rank(b) || a.collectedAt.localeCompare(b.collectedAt) || a.id.localeCompare(b.id);
  return order >= 0 ? a : b;
}

export function buildWaybackHistory(
  captures: readonly Capture[],
  observations: readonly Observation[],
): WaybackHistoryEntry[] {
  const digests = new Map<string, string>();
  const checks = new Map<string, string>();
  const mismatched = new Set<string>();
  for (const o of observations) {
    if (o.property === WAYBACK_PROPERTIES.digest && !digests.has(o.locator)) digests.set(o.locator, o.value);
    if (o.property !== WAYBACK_PROPERTIES.digestCheck) continue;
    // A check belongs to the capture it was computed from.
    checks.set(`${o.locator}|${o.captureId}`, o.value);
    if (o.value === 'mismatch') mismatched.add(o.captureId);
  }
  const snapshots = new Map<string, Capture>();
  for (const c of captures) {
    if (!c.archive) continue;
    const locator = waybackLocator(c.archive.originalUrl, c.archive.snapshotTimestamp);
    const known = snapshots.get(locator);
    snapshots.set(locator, known ? preferred(known, c, mismatched) : c);
  }
  const entries = new Map<string, WaybackHistoryEntry>();
  for (const o of observations) {
    if (o.property !== WAYBACK_PROPERTIES.snapshot || entries.has(o.locator)) continue;
    const capture = snapshots.get(o.locator);
    const check = capture ? checks.get(`${o.locator}|${capture.id}`) : undefined;
    entries.set(o.locator, {
      originalUrl: o.subject.key,
      snapshotTimestamp: o.value,
      at: waybackTimestampToIso(o.value),
      digest: digests.get(o.locator) ?? '',
      fetched: capture !== undefined,
      ...(capture ? { captureId: capture.id } : {}),
      digestCheck: capture && (check === 'match' || check === 'mismatch') ? check : 'not_checked',
    });
  }
  return [...entries.values()].toSorted(
    (a, b) => a.snapshotTimestamp.localeCompare(b.snapshotTimestamp) || a.originalUrl.localeCompare(b.originalUrl),
  );
}
