/**
 * Mojeek Search API (web search, AMBER, paid per query; DPA without sub-processors, zero data retention on request).
 * JSON format, exact-phrase queries, Polish language and region bias for names and nicks. The key is a query
 * parameter and is redacted (`api_key=REDACTED`) in logs, provenance and recordings. Storage depends on the plan:
 * Startup may only cache results for an hour, so only rank and URL are kept and every request is hash-only.
 *
 * The request parameters and response fields follow the shape documented for this adapter (`fmt`, `t`, `s`, `lb`,
 * `rb`; `response.status`, `response.results[] { url, title, desc }`) and are to be checked against the provider's
 * current API reference before the first live use.
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

export const MOJEEK_SEARCH_ID = 'mojeek_search';
export const MOJEEK_ENDPOINT = 'https://api.mojeek.com/search';
export const MOJEEK_PLANS = ['startup', 'business', 'enterprise'] as const;
export type MojeekPlan = (typeof MOJEEK_PLANS)[number];
const LOCALISED: ReadonlySet<string> = new Set(['full_name', 'nickname', 'username']);

export interface MojeekSearchOptions {
  apiKey: string;
  /** Startup: results may be cached for at most an hour (not stored); Business and Enterprise: may be kept. */
  plan: MojeekPlan;
  /** Language bias for names and nicks (default `PL`). */
  languageBias?: string;
  /** Region bias for names and nicks (default `PL`). */
  regionBias?: string;
}

interface MojeekBody {
  response?: { status?: unknown; results?: unknown };
}

/** True when the plan's terms allow keeping results (anything but Startup). */
export function mojeekStoresResults(plan: MojeekPlan): boolean {
  return plan !== 'startup';
}

/** Request URL for one query, key included (redacted by the egress client wherever the URL is written). */
export function mojeekSearchUrl(
  query: SubjectSearchQuery,
  options: Pick<MojeekSearchOptions, 'apiKey' | 'languageBias' | 'regionBias'>,
): string {
  const params = new URLSearchParams({
    q: query.exact ? exactPhrase(query.text) : normaliseQueryText(query.text),
    fmt: 'json',
    t: String(Math.max(1, query.maxResults)),
    s: '1',
    api_key: options.apiKey,
  });
  if (query.subject !== undefined && LOCALISED.has(query.subject)) {
    params.set('lb', options.languageBias ?? 'PL');
    params.set('rb', options.regionBias ?? 'PL');
  }
  return `${MOJEEK_ENDPOINT}?${params.toString()}`;
}

/** `response.status` must be `OK`; `response.results[] { url, title, desc }` → results. */
export function parseMojeekResults(
  body: unknown,
  fetchId: string,
  maxResults: number,
): { ok: true; results: SearchRun['results'] } | { ok: false; status: string } {
  const doc = (typeof body === 'object' && body !== null ? body : {}) as MojeekBody;
  const status = doc.response?.status;
  if (status !== 'OK') return { ok: false, status: typeof status === 'string' ? status.slice(0, 120) : 'missing' };
  const list: unknown = doc.response?.results;
  const items = (Array.isArray(list) ? list : []).filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  const results = rankResults(
    items.map((item) => ({
      url: httpUrl(item['url']),
      title: plainText(item['title']),
      snippet: plainText(item['desc']),
    })),
    MOJEEK_SEARCH_ID,
    fetchId,
    maxResults,
  );
  return { ok: true, results };
}

export function createMojeekSearchProvider(options: MojeekSearchOptions): SearchAdapter {
  const stores = mojeekStoresResults(options.plan);
  const adapter: SearchAdapter = {
    id: MOJEEK_SEARCH_ID,
    storesResults: stores,
    async run(query: SubjectSearchQuery, ctx: RunContext): Promise<SearchRun> {
      const fetched = await providerFetch(ctx, {
        url: mojeekSearchUrl(query, options),
        sourceId: MOJEEK_SEARCH_ID,
        purpose: 'mojeek web search',
        // The query is the case identifier itself.
        containsIdentifier: true,
        headers: { accept: 'application/json' },
        secretParams: ['api_key'],
        persistBody: stores,
      });
      if ('failure' in fetched) {
        return { status: 'error', results: [], notes: [fetched.failure], fetchIds: [], retrievedAt: nowIso(ctx.clock) };
      }
      const { response } = fetched;
      const { provenance } = response;
      const common = { fetchIds: [provenance.fetchId], provenance, retrievedAt: provenance.receivedAt, results: [] };
      if (response.status === 429) {
        return {
          ...common,
          status: 'blocked',
          notes: [
            note('barrier_blocked', 'HTTP 429'),
            note('rate_limited', `retry-after ${response.headers['retry-after'] ?? '?'}`),
          ],
        };
      }
      if (response.status < 200 || response.status >= 300) {
        const reason =
          response.status === 401 || response.status === 403 ? 'API key or plan rejected' : 'provider error';
        return {
          ...common,
          status: 'error',
          notes: [note('search_provider_error', `HTTP ${response.status}: ${reason}`)],
        };
      }
      let body: unknown;
      try {
        body = response.json();
      } catch {
        return { ...common, status: 'error', notes: [note('search_provider_error', 'response is not JSON')] };
      }
      const parsed = parseMojeekResults(body, provenance.fetchId, query.maxResults);
      if (!parsed.ok) {
        return {
          ...common,
          status: 'error',
          notes: [note('search_provider_error', `response status ${parsed.status}`)],
        };
      }
      return { ...common, status: parsed.results.length ? 'ok' : 'not_found', results: parsed.results, notes: [] };
    },
    search: (query, ctx) => portSearch(adapter)(query, ctx),
  };
  return adapter;
}
