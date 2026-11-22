/**
 * History timelines: the values a page (or a property of an account) showed over time, combining the live runs of a
 * case with the archived copies of the page. Archive points are positioned by the snapshot time the archive reports
 * (never by when we retrieved the copy) and stay labelled as archive. A point without a statement about the page (an
 * unreadable capture, a copy not fetched, a digest that did not match) is a gap: it never closes an interval and never
 * creates a change. Pure and deterministic: callers load the rows.
 */
import type {
  Capture,
  ChangeEvent,
  ExtractionResult,
  Id,
  IsoDateTime,
  Observation,
  OnlineAccount,
  PropertyTimeline,
  TimelineChange,
  TimelineInterval,
  TimelinePoint,
} from '@olcys/core';
import { addressKey, canonicalJson, waybackTimestampToIso } from '@olcys/core';
import { isWalletProperty } from './diff.ts';

/** Property of the timeline of the addresses found on a page. */
export const PAGE_ADDRESS_PROPERTY = 'page.address';

/** One snapshot of the archive history (structurally identical to the Wayback adapter's history entry). */
export interface ArchiveSnapshotEntry {
  originalUrl: string;
  snapshotTimestamp: string;
  at: IsoDateTime;
  digest: string;
  fetched: boolean;
  captureId?: Id;
  digestCheck: 'match' | 'mismatch' | 'not_checked';
}

export interface TimelineInput {
  captures: (Pick<Capture, 'id' | 'runId' | 'url' | 'status' | 'collectedAt' | 'archive'> &
    Partial<Pick<Capture, 'technical'>>)[];
  /** One extraction result per capture (see `latestExtractions`); a capture without one has not been extracted yet. */
  extractions: Pick<ExtractionResult, 'captureId' | 'candidates'>[];
  archive: ArchiveSnapshotEntry[];
  /** Live property-level observations (e.g. `profile.bitcoin_address`). */
  observations?: Observation[];
  /**
   * Accounts the collectors found. The capture that read an account's profile (`profileCaptureId`) stands for the
   * account's canonical profile page (e.g. a profile fetched by nickname is the page `…profile;u=<id>` the archive
   * lists), whatever URL it was requested under. The page that merely linked to the account is not that capture.
   */
  accounts?: Pick<OnlineAccount, 'profileUrl' | 'profileCaptureId'>[];
}

export interface TimelineFilter {
  url?: string;
  property?: string;
  walletOnly?: boolean;
}

/** Snapshot rows with an invalid timestamp are skipped; `warn` is told about each. */
export interface TimelineOptions {
  warn?: (message: string) => void;
}

/**
 * `http`/`https` alike, lower-case host, default port, fragment and trailing slash dropped, query kept. A value that is
 * not an absolute URL is returned trimmed.
 */
export function normalisePageUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return trimmed;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${parsed.host}${path}${parsed.search}`;
}

/** `20250915083000` → `2025-09-15T08:30:00.000Z`; anything but a valid 14-digit UTC timestamp → `undefined`. */
export function snapshotTimestampToIso(timestamp: string): IsoDateTime | undefined {
  try {
    return waybackTimestampToIso(timestamp);
  } catch {
    return undefined;
  }
}

type TimelineCapture = TimelineInput['captures'][number];
type Raw = { point: TimelinePoint; sortId: string };

const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

/**
 * The page a live capture stands for: the canonical profile page of the account it read, else its logical
 * URL (offline mode) or the requested URL.
 */
function pageResolver(input: TimelineInput): (c: TimelineCapture) => string {
  const profiles = new Map<Id, string>();
  for (const account of input.accounts ?? []) {
    const captureId = account.profileCaptureId;
    if (captureId && !profiles.has(captureId)) profiles.set(captureId, normalisePageUrl(account.profileUrl));
  }
  return (c) => profiles.get(c.id) ?? normalisePageUrl(c.technical?.logicalUrl ?? c.url);
}

function sortPoints(raws: Raw[]): TimelinePoint[] {
  return raws
    .toSorted(
      (a, b) =>
        a.point.observedAt.localeCompare(b.point.observedAt) ||
        (a.point.provenance === b.point.provenance ? 0 : a.point.provenance === 'archive' ? -1 : 1) ||
        a.sortId.localeCompare(b.sortId),
    )
    .map((r) => r.point);
}

function shape(key: ChangeEvent['key'], points: TimelinePoint[]): PropertyTimeline {
  const intervals: TimelineInterval[] = [];
  for (const point of points) {
    if (point.values === null) continue;
    const last = intervals.at(-1);
    if (last && sameValues(last.values, point.values)) last.to = point;
    else intervals.push({ values: point.values, from: point, to: point });
  }
  const wallet = isWalletProperty(key.property);
  const changes: TimelineChange[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const previous = intervals[i - 1]!;
    const next = intervals[i]!;
    changes.push({
      before: previous.values,
      after: next.values,
      lastSeenBefore: previous.to,
      firstSeenAfter: next.from,
      wallet,
    });
  }
  return { key, points, intervals, changes };
}

/** `values: undefined` = the capture was read but no extraction result exists yet: a gap, never an empty page. */
function livePoint(capture: TimelineCapture, values: string[] | undefined): Raw {
  const ok = capture.status === 'ok' && values !== undefined;
  const gapReason = capture.status === 'ok' ? 'extraction_pending' : capture.status;
  return {
    sortId: capture.id,
    point: {
      observedAt: capture.collectedAt,
      values: ok ? values : null,
      captureId: capture.id,
      runId: capture.runId,
      provenance: 'live',
      ...(ok ? {} : { gapReason }),
    },
  };
}

/** Address keys per extracted capture; a capture without an extraction result is absent (not empty). */
function extractedValues(extractions: TimelineInput['extractions']): Map<Id, Set<string>> {
  const values = new Map<Id, Set<string>>();
  for (const result of extractions) {
    const set = values.get(result.captureId) ?? new Set<string>();
    for (const c of result.candidates) set.add(addressKey(c.address));
    values.set(result.captureId, set);
  }
  return values;
}

/**
 * One extraction result per capture: the newest analysis wins, because a rescore re-extracts saved captures and its
 * result replaces the earlier one (an address it rejected must not survive from an older run). `rounds` are the results
 * of each run, oldest run first.
 */
export function latestExtractions<T extends { captureId: Id }>(rounds: readonly (readonly T[])[]): T[] {
  const newest = new Map<Id, T>();
  for (const round of rounds) for (const result of round) newest.set(result.captureId, result);
  return [...newest.values()];
}

function pageTimelines(
  input: TimelineInput,
  options: TimelineOptions,
): { urls: string[]; timeline: PropertyTimeline }[] {
  const liveUrl = pageResolver(input);
  const byId = new Map(input.captures.map((c) => [c.id, c]));
  const valuesOf = extractedValues(input.extractions);
  const entriesByUrl = new Map<string, ArchiveSnapshotEntry[]>();
  for (const entry of input.archive) {
    const at = snapshotTimestampToIso(entry.snapshotTimestamp);
    if (at === undefined) {
      options.warn?.(`skipped archive snapshot with invalid timestamp "${entry.snapshotTimestamp}"`);
      continue;
    }
    const url = normalisePageUrl(entry.originalUrl);
    entriesByUrl.set(url, [...(entriesByUrl.get(url) ?? []), { ...entry, at }]);
  }
  const results: { urls: string[]; timeline: PropertyTimeline }[] = [];
  for (const [url, entries] of [...entriesByUrl].toSorted(([a], [b]) => a.localeCompare(b))) {
    // A fetched copy that can be trusted: the values another row with the same digest (identical bytes) inherits.
    const usable = (e: ArchiveSnapshotEntry): TimelineCapture | undefined => {
      const capture = e.captureId ? byId.get(e.captureId) : undefined;
      return e.fetched && e.digestCheck !== 'mismatch' && capture?.status === 'ok' && valuesOf.has(capture.id)
        ? capture
        : undefined;
    };
    const raws: Raw[] = [];
    for (const entry of entries) {
      const capture = entry.captureId ? byId.get(entry.captureId) : undefined;
      const base = (values: string[] | null, inferred: boolean, gap?: TimelinePoint['gapReason']): Raw => ({
        sortId: entry.captureId ?? entry.snapshotTimestamp,
        point: {
          observedAt: entry.at,
          values,
          ...(capture ? { captureId: capture.id, runId: capture.runId } : {}),
          provenance: 'archive',
          ...(gap ? { gapReason: gap } : {}),
          archive: {
            snapshotTimestamp: entry.snapshotTimestamp,
            digest: entry.digest,
            inferredFromDigest: inferred,
            ...(capture ? { collectedAt: capture.collectedAt } : {}),
          },
        },
      });
      if (entry.fetched && capture) {
        if (entry.digestCheck === 'mismatch') raws.push(base(null, false, 'digest_mismatch'));
        else if (capture.status !== 'ok') raws.push(base(null, false, capture.status));
        else if (!valuesOf.has(capture.id)) raws.push(base(null, false, 'extraction_pending'));
        else raws.push(base(sortedUnique(valuesOf.get(capture.id) ?? []), false));
        continue;
      }
      // Not fetched: identical digest means identical bytes, so the nearest earlier trusted copy speaks for it.
      const donors = entries
        .filter((e) => e !== entry && e.digest !== '' && e.digest === entry.digest && usable(e))
        .toSorted((a, b) => {
          const sideA = a.at <= entry.at ? 0 : 1;
          const sideB = b.at <= entry.at ? 0 : 1;
          if (sideA !== sideB) return sideA - sideB;
          return sideA === 0 ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at);
        });
      const donor = donors[0] ? usable(donors[0]) : undefined;
      raws.push(donor ? base(sortedUnique(valuesOf.get(donor.id) ?? []), true) : base(null, false, 'not_fetched'));
    }
    for (const capture of input.captures) {
      if (capture.archive || liveUrl(capture) !== url) continue;
      const values = valuesOf.get(capture.id);
      raws.push(livePoint(capture, values ? sortedUnique(values) : undefined));
    }
    const key = { platform: 'web', locator: `web:${url}#${PAGE_ADDRESS_PROPERTY}`, property: PAGE_ADDRESS_PROPERTY };
    results.push({ urls: [url], timeline: shape(key, sortPoints(raws)) });
  }
  return results;
}

function propertyTimelines(input: TimelineInput): { urls: string[]; timeline: PropertyTimeline }[] {
  const liveUrl = pageResolver(input);
  const live = input.captures.filter((c) => !c.archive);
  const byId = new Map(live.map((c) => [c.id, c]));
  const groups = new Map<string, { key: ChangeEvent['key']; byCapture: Map<Id, Set<string>> }>();
  for (const o of input.observations ?? []) {
    if (o.property.startsWith('archive.') || !byId.has(o.captureId)) continue;
    const key = { platform: o.sourceId, locator: o.locator, property: o.property };
    const id = canonicalJson(key);
    const group = groups.get(id) ?? { key, byCapture: new Map<Id, Set<string>>() };
    const values = group.byCapture.get(o.captureId) ?? new Set<string>();
    values.add(o.value);
    group.byCapture.set(o.captureId, values);
    groups.set(id, group);
  }
  const results: { urls: string[]; timeline: PropertyTimeline }[] = [];
  for (const { key, byCapture } of groups.values()) {
    const urls = sortedUnique([...byCapture.keys()].map((id) => liveUrl(byId.get(id)!)));
    // Every live capture of the same page is a point: one that read the page without the property shows `[]`.
    const raws = live
      .filter((c) => urls.includes(liveUrl(c)))
      .map((c) => livePoint(c, sortedUnique(byCapture.get(c.id) ?? [])));
    results.push({ urls, timeline: shape(key, sortPoints(raws)) });
  }
  return results.toSorted(
    (a, b) =>
      a.timeline.key.locator.localeCompare(b.timeline.key.locator) ||
      a.timeline.key.property.localeCompare(b.timeline.key.property),
  );
}

/**
 * Timelines of every page with archived copies (`page.address`: the addresses the extraction found on it) and of every
 * live property-level observation. Page timelines come first; both groups are ordered by locator.
 */
export function buildPropertyTimelines(
  input: TimelineInput,
  filter: TimelineFilter = {},
  options: TimelineOptions = {},
): PropertyTimeline[] {
  const wanted = filter.url === undefined ? undefined : normalisePageUrl(filter.url);
  return [...pageTimelines(input, options), ...propertyTimelines(input)]
    .filter(
      ({ urls, timeline }) =>
        (wanted === undefined || urls.includes(wanted)) &&
        (filter.property === undefined || timeline.key.property === filter.property) &&
        (!filter.walletOnly || isWalletProperty(timeline.key.property)),
    )
    .map(({ timeline }) => timeline);
}
