/**
 * Brave Search API (web search, AMBER, paid per query): exact-phrase queries, spelling correction off, no text
 * decorations, web results only. The subscription token travels in a header that is never logged, stored or recorded.
 * Results are stored only with a plan whose terms allow it (`storageRights`); otherwise every request is hash-only.
 */
import type { RunContext } from '@olcys/core';
import { nowIso } from '@olcys/core';
import { note } from '../framework/status.ts';
import {
  httpUrl,
  plainText,
  portSearch,
  providerFetch,
  rankResults,
  type SearchAdapter,
  type SearchRun,
} from './provider.ts';
import { exactPhrase, normaliseQueryText, type SubjectSearchQuery } from './query.ts';

export const BRAVE_SEARCH_ID = 'brave_search';
export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
/** Largest `count` the endpoint accepts. */
export const BRAVE_MAX_COUNT = 20;
const LOCALISED: ReadonlySet<string> = new Set(['full_name', 'nickname', 'username']);

export interface BraveSearchOptions {
  apiKey: string;
  /** True only on a plan whose terms allow storing results (a custom plan); false keeps only rank and URL. */
  storageRights: boolean;
  /** Country for names and nicks (default `PL`); e-mails and crypto addresses are searched worldwide (`ALL`). */
  country?: string;
  /** Search language for names and nicks (default `pl`). */
  searchLang?: string;
}

interface BraveBody {
  query?: { original?: unknown; altered?: unknown };
  web?: { results?: unknown };
}

/** Request URL for one query (no credentials: the token is a header). */
export function braveSearchUrl(
  query: SubjectSearchQuery,
  options: Pick<BraveSearchOptions, 'country' | 'searchLang'> = {},
): string {
  const localised = query.subject !== undefined && LOCALISED.has(query.subject);
  const params = new URLSearchParams({
    q: query.exact ? exactPhrase(query.text) : normaliseQueryText(query.text),
    count: String(Math.min(Math.max(1, query.maxResults), BRAVE_MAX_COUNT)),
    offset: '0',
    safesearch: 'off',
    spellcheck: 'false',
    text_decorations: 'false',
    result_filter: 'web',
    country: localised ? (options.country ?? 'PL') : 'ALL',
  });
  if (localised) params.set('search_lang', options.searchLang ?? 'pl');
  return `${BRAVE_ENDPOINT}?${params.toString()}`;
}

/** `web.results[] { url, title, description }` → results; a rewritten query (`query.altered`) is reported instead. */
export function parseBraveResults(
  body: unknown,
  fetchId: string,
  maxResults: number,
): { results: SearchRun['results']; altered: boolean } {
  const doc = (typeof body === 'object' && body !== null ? body : {}) as BraveBody;
  const altered = typeof doc.query?.altered === 'string' && doc.query.altered.trim() !== '';
  if (altered) return { results: [], altered };
  const list: unknown = doc.web?.results;
  const items = (Array.isArray(list) ? list : []).filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  const results = rankResults(
    items.map((item) => ({
      url: httpUrl(item['url']),
      title: plainText(item['title']),
      snippet: plainText(item['description']),
    })),
    BRAVE_SEARCH_ID,
    fetchId,
    maxResults,
  );
  return { results, altered };
}

/** HTTP status → outcome: 401/403 key or plan, 422 rejected query, 429 rate limit (the source stops), other errors. */
function httpFailure(status: number, retryAfter: string | undefined): Pick<SearchRun, 'status' | 'notes'> {
  if (status === 429) {
    return {
      status: 'blocked',
      notes: [note('barrier_blocked', 'HTTP 429'), note('rate_limited', `retry-after ${retryAfter ?? '?'}`)],
    };
  }
  let reason = 'provider error';
  if (status === 401 || status === 403) reason = 'API key or plan rejected';
  else if (status === 422) reason = 'query rejected by the provider';
  return { status: 'error', notes: [note('search_provider_error', `HTTP ${status}: ${reason}`)] };
}

export function createBraveSearchProvider(options: BraveSearchOptions): SearchAdapter {
  const adapter: SearchAdapter = {
    id: BRAVE_SEARCH_ID,
    storesResults: options.storageRights,
    async run(query: SubjectSearchQuery, ctx: RunContext): Promise<SearchRun> {
      const fetched = await providerFetch(ctx, {
        url: braveSearchUrl(query, options),
        sourceId: BRAVE_SEARCH_ID,
        purpose: 'brave web search',
        // The query is the case identifier itself.
        containsIdentifier: true,
        headers: { accept: 'application/json', 'X-Subscription-Token': options.apiKey },
        secretParams: ['x-subscription-token'],
        persistBody: options.storageRights,
      });
      if ('failure' in fetched) {
        return { status: 'error', results: [], notes: [fetched.failure], fetchIds: [], retrievedAt: nowIso(ctx.clock) };
      }
      const { response } = fetched;
      const { provenance } = response;
      const common = { fetchIds: [provenance.fetchId], provenance, retrievedAt: provenance.receivedAt };
      if (response.status < 200 || response.status >= 300) {
        return { ...common, ...httpFailure(response.status, response.headers['retry-after']), results: [] };
      }
      let body: unknown;
      try {
        body = response.json();
      } catch {
        return {
          ...common,
          status: 'error',
          results: [],
          notes: [note('search_provider_error', 'response is not JSON')],
        };
      }
      const { results, altered } = parseBraveResults(body, provenance.fetchId, query.maxResults);
      if (altered) {
        return {
          ...common,
          status: 'partial',
          results: [],
          notes: [
            note(
              'search_query_altered',
              'the provider rewrote the query; exact match not guaranteed, results discarded',
            ),
          ],
        };
      }
      return { ...common, status: results.length ? 'ok' : 'not_found', results, notes: [] };
    },
    search: (query, ctx) => portSearch(adapter)(query, ctx),
  };
  return adapter;
}
