/**
 * Wayback Machine history (read-only): for a known profile URL the Availability API says whether the archive holds the
 * page at all, the CDX API with `collapse=digest` lists exactly the captures in which the content changed, and a
 * bounded, deterministic selection of them is fetched as raw (`id_`) bytes and stored as archived-copy captures. The
 * extraction stage then finds addresses in every snapshot, so a wallet swap that happened before the first run shows up.
 *
 * Strictly sequential (one request in flight, GET only), at most 20 requests a minute (the egress client's token
 * bucket), and a 429 that survives the client's backoff opens a circuit for the rest of the run. Save Page Now is never
 * used (see `guard.ts`). The page URL is disclosed to the archive: every request is `containsIdentifier`.
 */
import type { Capture, CollectorInput, CollectorResult, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { note } from '../framework/status.ts';
import { fetchPage } from '../html/page.ts';
import { asObject, registryFetch } from '../registries/common.ts';
import {
  availabilityRequestUrl,
  cdxRequestUrl,
  DEFAULT_AVAILABILITY_URL,
  DEFAULT_CDX_URL,
  DEFAULT_REPLAY_BASE_URL,
  parseCdxJson,
  rawSnapshotUrl,
  selectSnapshots,
  sha1Base32,
  type CdxEntry,
} from './cdx.ts';
import { assertWaybackReadUrl } from './guard.ts';
import { waybackLocator, WAYBACK_PROPERTIES } from './history.ts';

export const WAYBACK_SOURCE_ID = 'wayback_cdx';
export const WAYBACK_PLATFORM = 'wayback';
export const WAYBACK_PARSER_VERSION = 'wayback.v1';
const SOFTWARE = [{ name: 'parser:wayback', version: WAYBACK_PARSER_VERSION }];
const ARCHIVE_HOST = /(?:^|\.)archive\.org$/i;

export interface WaybackCollectorOptions {
  /** Default `https://web.archive.org/cdx/search/cdx`. */
  cdxUrl?: string;
  /** Default `https://archive.org/wayback/available`. */
  availabilityUrl?: string;
  /** Default `https://web.archive.org/web`. */
  replayBaseUrl?: string;
  /** Snapshots fetched per URL (default 12). */
  maxSnapshotsPerUrl?: number;
  /** CDX result pages per URL, followed by resume key (default 3). */
  maxCdxPages?: number;
  /** Optional CDX lower bound, `YYYY` or `YYYYMMDD`. */
  from?: string;
}

/** Page URLs of the input (one per task): http(s) only, never a URL of the archive itself. */
function pageUrls(input: CollectorInput): string[] {
  const urls: string[] = [];
  for (const value of input.values ?? []) {
    if (value.kind !== 'url') continue;
    try {
      const parsed = new URL(value.value.trim());
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !ARCHIVE_HOST.test(parsed.hostname)) {
        urls.push(parsed.toString());
      }
    } catch {
      // Not a URL: unsupported.
    }
  }
  return [...new Set(urls)];
}

const CIRCUIT_NOTE = 'wayback rate limited (circuit open)';

export function createWaybackCollector(options: WaybackCollectorOptions = {}): CollectorFactory {
  const cdxUrl = options.cdxUrl ?? DEFAULT_CDX_URL;
  const availabilityUrl = options.availabilityUrl ?? DEFAULT_AVAILABILITY_URL;
  const replayBaseUrl = options.replayBaseUrl ?? DEFAULT_REPLAY_BASE_URL;
  const maxSnapshots = options.maxSnapshotsPerUrl ?? 12;
  const maxPages = options.maxCdxPages ?? 3;
  return {
    sourceId: WAYBACK_SOURCE_ID,
    platform: WAYBACK_PLATFORM,
    archiveHistory: true,
    pivotOnAccounts: false,
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => pageUrls(input).length > 0,
        async collect(input, ctx): Promise<CollectorResult> {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const urls = pageUrls(input);
          if (!urls.length) {
            rb.note('unsupported_input', 'no page URL to look up in the archive');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const url of urls) {
            const stop = http.stopped();
            if (stop) {
              // The circuit is shared by all Wayback tasks of the run: no further request, whatever the page.
              rb.addStatus(stop.status);
              rb.note('source_stopped', `${stop.status}: ${stop.reason}`);
              break;
            }
            // Sequential on purpose: one request in flight against the archive.
            // oxlint-disable-next-line no-await-in-loop
            await lookup(http, rb, url);
          }
          if (http.stopped() && /429/.test(http.stopped()?.reason ?? '')) rb.note('rate_limited', CIRCUIT_NOTE);
          return rb.build();
        },
      };
    },
  };

  async function lookup(http: SourceHttp, rb: ResultBuilder, url: string): Promise<void> {
    const availability = availabilityRequestUrl(availabilityUrl, url);
    assertWaybackReadUrl(availability);
    const available = await registryFetch(http, {
      url: availability,
      purpose: 'wayback availability',
      software: SOFTWARE,
      classify: (json, httpStatus) => {
        if (httpStatus < 200 || httpStatus >= 300) return undefined;
        const closest = asObject(asObject(asObject(json)?.['archived_snapshots'])?.['closest']);
        return closest && closest['available'] !== false
          ? undefined
          : { status: 'not_found', reason: `the archive holds no capture of ${url}` };
      },
    });
    rb.addPage({
      status: available.status,
      ...(available.capture ? { capture: available.capture } : {}),
      notes: available.notes,
    });
    if (available.status === 'not_found') rb.affirmNotFound(`archive: ${url}`);
    if (available.status !== 'ok') return;

    const entries: CdxEntry[] = [];
    let resumeKey: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const listing = cdxRequestUrl(cdxUrl, url, {
        ...(options.from ? { from: options.from } : {}),
        ...(resumeKey ? { resumeKey } : {}),
      });
      assertWaybackReadUrl(listing);
      // Sequential on purpose: pages are requested one after the other.
      // oxlint-disable-next-line no-await-in-loop
      const answer = await registryFetch(http, {
        url: listing,
        purpose: 'wayback cdx listing',
        software: SOFTWARE,
      });
      let parsed: ReturnType<typeof parseCdxJson> | undefined;
      let notes = answer.notes;
      let status = answer.status;
      if (status === 'ok') {
        try {
          parsed = parseCdxJson(answer.json);
        } catch (error) {
          status = 'error';
          notes = [...notes, note('unrecognised_markup', error instanceof Error ? error.message : String(error))];
        }
      }
      rb.addPage({ status, ...(answer.capture ? { capture: answer.capture } : {}), notes });
      if (!parsed || !answer.capture) return;
      for (const entry of parsed.entries) {
        const subject = { type: 'page' as const, key: entry.original };
        const locator = waybackLocator(entry.original, entry.timestamp);
        rb.observe(answer.capture, subject, WAYBACK_PROPERTIES.snapshot, entry.timestamp, locator);
        rb.observe(answer.capture, subject, WAYBACK_PROPERTIES.digest, entry.digest, locator);
      }
      entries.push(...parsed.entries);
      resumeKey = parsed.resumeKey;
      if (!resumeKey) break;
      if (page === maxPages - 1) rb.note('truncated', `CDX listing of ${url} limited to ${maxPages} page(s)`);
    }
    if (!entries.length) {
      rb.affirmNotFound(`archive: no 200 capture of ${url}`);
      return;
    }

    const selected = selectSnapshots(entries, maxSnapshots);
    if (selected.length < entries.length) {
      rb.note('truncated', `${entries.length} distinct snapshots of ${url}; ${selected.length} fetched`);
    }
    for (const entry of selected) {
      if (http.stopped()) break;
      // oxlint-disable-next-line no-await-in-loop
      await snapshot(http, rb, entry);
    }
  }

  async function snapshot(http: SourceHttp, rb: ResultBuilder, entry: CdxEntry): Promise<void> {
    const replay = rawSnapshotUrl(entry.timestamp, entry.original, replayBaseUrl);
    assertWaybackReadUrl(replay);
    const page = await fetchPage(http, {
      url: replay,
      purpose: 'wayback snapshot',
      containsIdentifier: true,
      software: SOFTWARE,
      guardUrl: assertWaybackReadUrl,
      archive: {
        provider: 'wayback',
        snapshotTimestamp: entry.timestamp,
        originalUrl: entry.original,
        replayUrl: replay,
        cdxDigest: entry.digest,
      },
    });
    rb.addPage({ status: page.status, ...(page.capture ? { capture: page.capture } : {}), notes: page.notes });
    if (page.status !== 'ok' || !page.capture || !page.bytes) return;
    const actual = sha1Base32(page.bytes);
    const capture: Capture = page.capture;
    // Transfer re-encoding can cause a mismatch: it is recorded as a computation, never an error.
    rb.observe(
      capture,
      { type: 'page', key: entry.original },
      WAYBACK_PROPERTIES.digestCheck,
      actual === entry.digest ? 'match' : 'mismatch',
      waybackLocator(entry.original, entry.timestamp),
    );
  }
}
