/**
 * Web search as a source collector: one query per task (one subject), the answer preserved as a capture (canonical
 * JSON of the result list) and each result URL as a `search.result_url` observation that the pivot planner follows to
 * the page's own collector. A result list is a pointer, not evidence: the pages are collected (and their addresses
 * extracted) by their collectors, once, whichever way they were found.
 *
 * Every provider request is hash-only: a raw response is neither stored nor recorded, because its snippets are scraped
 * text that may hold secrets and provider terms may forbid keeping it. What the capture keeps follows the terms: with
 * storage rights rank, URL, title and snippet (secrets redacted), without them only the rank and URL of each result.
 */
import type {
  Capture,
  CaptureStatus,
  CollectorInput,
  RunContext,
  SourceCollector,
  SourceDescriptor,
} from '@olcys/core';
import { canonicalJson, newId, nowIso } from '@olcys/core';
import { captureManifestSha256, sha256Hex } from '../framework/capture.ts';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { COLLECTORS_VERSION } from '../framework/config.ts';
import { createSourceHttp, type CollectorDeps } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { note } from '../framework/status.ts';
import { usesFixtures } from '../framework/urls.ts';
import { BRAVE_SEARCH_ID, createBraveSearchProvider, type BraveSearchOptions } from './brave.ts';
import { createMockSearchProvider, MOCK_SEARCH_ID } from './mock.ts';
import { createMojeekSearchProvider, MOJEEK_SEARCH_ID, type MojeekSearchOptions } from './mojeek.ts';
import type { SearchAdapter, SearchStatus } from './provider.ts';
import { buildSearchQuery, DEFAULT_MAX_RESULTS } from './query.ts';

export const SEARCH_RESULTS_SCHEMA = 'olcys.search-results.v1';
export const SEARCH_COLLECTOR_VERSION = 'search.v1';
/** Software entry `search:<provider>` in the technical record of every result-list capture. */
export const SEARCH_SOFTWARE_PREFIX = 'search:';
/** Platform name of the search collectors (they find pages, not accounts). */
export const SEARCH_PLATFORM = 'web_search';

/** Capture status of a result list: a rewritten query or an incomplete index is not a complete answer. */
const CAPTURE_STATUS: Readonly<Record<SearchStatus, CaptureStatus>> = {
  ok: 'ok',
  not_found: 'not_found',
  partial: 'error',
  blocked: 'blocked',
  error: 'error',
};

const EMPTY_INPUT: CollectorInput = { identifiers: [], accounts: [], addresses: [], depth: 0 };

/**
 * True for a result-list capture of a search collector. It points at pages and is not evidence of what they say: the
 * pages are collected (and their addresses extracted) by their own collectors.
 */
export function isSearchResultCapture(capture: Pick<Capture, 'technical'>): boolean {
  return capture.technical?.software.some((s) => s.name.startsWith(SEARCH_SOFTWARE_PREFIX)) ?? false;
}

/** Observation subject of one query: `search:<provider>:<sha256 of the query text>`. */
export function searchSubjectKey(providerId: string, queryText: string): string {
  return `search:${providerId}:${sha256Hex(queryText)}`;
}

export interface SearchCollectorOptions {
  provider: SearchAdapter;
  descriptor: SourceDescriptor;
  deps: CollectorDeps;
  /** False: the capture keeps only `{ rank, url }` per result (no titles or snippets). */
  storesResults: boolean;
  maxResults?: number;
  /** True for providers that read the fixture site (offline and replay only). */
  fixtureOnly?: boolean;
}

export function createSearchCollector(options: SearchCollectorOptions): SourceCollector {
  const { provider, descriptor, deps, storesResults } = options;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const available = (): boolean => !options.fixtureOnly || usesFixtures(deps.mode);
  const safe = (text: string): string => deps.redactor.redact(text).text;
  return {
    descriptor,
    supports: (input) => available() && buildSearchQuery(input, maxResults) !== undefined,
    async collect(input, ctx) {
      const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
      const query = available() ? buildSearchQuery(input, maxResults) : undefined;
      if (!query) {
        rb.note('unsupported_input', available() ? 'nothing to search for' : 'this search reads the fixture site only');
        return rb.build();
      }
      // The URL net marks requests that carry a case value. A provider that never receives the query (the mock
      // builds the same index whatever is searched) gets no case tokens: its fixed page URLs disclose nothing.
      const http = createSourceHttp({
        descriptor,
        ctx,
        deps,
        input: descriptor.sendsIdentifiersExternally ? input : EMPTY_INPUT,
      });
      // Hash-only whatever the provider asks for: the response body is redacted here, in memory, never stored raw.
      const guarded: RunContext = {
        ...ctx,
        http: { fetch: (request) => http.fetch({ ...request, persistBody: false }) },
      };
      const startedAt = nowIso(ctx.clock);
      const run = await provider.run(query, guarded);
      const notes = [...run.notes];
      if (!storesResults) {
        notes.push(note('search_results_not_stored', 'provider terms: only the rank and URL of each result are kept'));
      }
      if (run.status === 'blocked') http.stop('blocked', notes.join('; ') || 'blocked');
      if (!run.provenance) return { status: run.status, captures: [], accounts: [], observations: [], notes };

      const results = run.results.map((r) =>
        storesResults
          ? {
              rank: r.rank,
              url: safe(r.url),
              ...(r.title ? { title: safe(r.title) } : {}),
              ...(r.snippet ? { snippet: safe(r.snippet) } : {}),
              fetchId: r.fetchId,
            }
          : { rank: r.rank, url: safe(r.url) },
      );
      const artifact = canonicalJson({
        schema: SEARCH_RESULTS_SCHEMA,
        provider: provider.id,
        query: query.text,
        exact: query.exact,
        ...(query.subject ? { subject: query.subject } : {}),
        maxResults: query.maxResults,
        retrievedAt: run.retrievedAt,
        storage: storesResults ? 'full' : 'rank_url',
        status: run.status,
        results,
      });
      const blob = await ctx.blobs.put(new TextEncoder().encode(artifact), 'application/json');
      const p = run.provenance;
      const draft: Omit<Capture, 'manifestSha256'> = {
        id: newId(),
        runId: ctx.runId,
        sourceId: descriptor.id,
        url: p.url,
        finalUrl: p.finalUrl ?? p.url,
        collectedAt: run.retrievedAt,
        collector: deps.config.collectorName,
        ...(deps.config.collectorHost ? { collectorHost: deps.config.collectorHost } : {}),
        clockSynced: deps.config.clockSynced,
        toolVersion: p.toolVersion,
        userAgent: p.userAgent,
        httpStatus: p.httpStatus,
        status: CAPTURE_STATUS[run.status],
        artifacts: [{ kind: 'json', blob }],
        fetchIds: run.fetchIds,
        technical: {
          method: 'http',
          startedAt,
          redirects: [],
          software: [
            { name: '@olcys/collectors', version: COLLECTORS_VERSION },
            { name: `${SEARCH_SOFTWARE_PREFIX}${provider.id}`, version: SEARCH_COLLECTOR_VERSION },
          ],
          transformations: [
            'provider responses hashed, not stored (scraped snippets may hold secrets)',
            storesResults
              ? 'result list as canonical JSON: rank, URL, title and snippet (secrets redacted)'
              : 'result list as canonical JSON with rank and URL only (provider terms)',
          ],
          notes,
        },
      };
      const capture: Capture = { ...draft, manifestSha256: captureManifestSha256(draft) };
      rb.addPage({ status: capture.status, capture, notes });
      if (run.status !== 'error' && run.status !== 'blocked') {
        const key = searchSubjectKey(provider.id, query.text);
        const subject = { type: 'page' as const, key };
        for (const result of run.results) {
          rb.observe(capture, subject, 'search.result_url', result.url, `${key}#rank=${result.rank}`);
        }
        // The count is a fact only when the list is complete.
        if (run.status !== 'partial') {
          rb.observe(capture, subject, 'search.result_count', String(run.results.length), `${key}#search.result_count`);
        }
      }
      return { ...rb.build(), status: run.status };
    },
  };
}

/** Mock search over the fixture site's sitemap (offline and replay; the demo default). */
export function createMockSearchCollector(options: { sitemapPath?: string } = {}): CollectorFactory {
  return {
    sourceId: MOCK_SEARCH_ID,
    platform: SEARCH_PLATFORM,
    webSearch: true,
    create(descriptor, deps) {
      const provider = createMockSearchProvider({
        baseUrl: deps.config.fixture.baseUrl,
        ...(options.sitemapPath ? { sitemapPath: options.sitemapPath } : {}),
        robots: deps.robots,
        redactor: deps.redactor,
        mapping: deps.config.fixture,
      });
      return createSearchCollector({
        provider,
        descriptor,
        deps,
        storesResults: provider.storesResults,
        fixtureOnly: true,
      });
    },
  };
}

export function createBraveSearchCollector(options: BraveSearchOptions): CollectorFactory {
  return {
    sourceId: BRAVE_SEARCH_ID,
    platform: SEARCH_PLATFORM,
    webSearch: true,
    create(descriptor, deps) {
      const provider = createBraveSearchProvider(options);
      return createSearchCollector({ provider, descriptor, deps, storesResults: provider.storesResults });
    },
  };
}

export function createMojeekSearchCollector(options: MojeekSearchOptions): CollectorFactory {
  return {
    sourceId: MOJEEK_SEARCH_ID,
    platform: SEARCH_PLATFORM,
    webSearch: true,
    create(descriptor, deps) {
      const provider = createMojeekSearchProvider(options);
      return createSearchCollector({ provider, descriptor, deps, storesResults: provider.storesResults });
    },
  };
}
