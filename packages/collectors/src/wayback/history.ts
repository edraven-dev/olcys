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

export function buildWaybackHistory(
  captures: readonly Capture[],
  observations: readonly Observation[],
): WaybackHistoryEntry[] {
  const byLocator = (property: string): Map<string, Observation> =>
    new Map(observations.filter((o) => o.property === property).map((o) => [o.locator, o]));
  const digests = byLocator(WAYBACK_PROPERTIES.digest);
  const checks = byLocator(WAYBACK_PROPERTIES.digestCheck);
  const snapshots = new Map<string, Capture>();
  for (const c of captures) {
    if (c.archive) snapshots.set(waybackLocator(c.archive.originalUrl, c.archive.snapshotTimestamp), c);
  }
  const entries = new Map<string, WaybackHistoryEntry>();
  for (const o of observations) {
    if (o.property !== WAYBACK_PROPERTIES.snapshot || entries.has(o.locator)) continue;
    const capture = snapshots.get(o.locator);
    const check = checks.get(o.locator)?.value;
    entries.set(o.locator, {
      originalUrl: o.subject.key,
      snapshotTimestamp: o.value,
      at: waybackTimestampToIso(o.value),
      digest: digests.get(o.locator)?.value ?? '',
      fetched: capture !== undefined,
      ...(capture ? { captureId: capture.id } : {}),
      digestCheck: capture && (check === 'match' || check === 'mismatch') ? check : 'not_checked',
    });
  }
  return [...entries.values()].toSorted(
    (a, b) => a.snapshotTimestamp.localeCompare(b.snapshotTimestamp) || a.originalUrl.localeCompare(b.originalUrl),
  );
}
