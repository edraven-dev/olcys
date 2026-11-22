/**
 * Search providers of this package: the core `SearchProvider` port plus `run()`, which also reports what happened
 * (status, notes, the provider requests), so the collector can preserve the query as a capture and the planner can
 * follow the result URLs. Providers talk to the network only through `ctx.http`.
 */
import type {
  EgressResponse,
  Id,
  IsoDateTime,
  ProvenanceEnvelope,
  RunContext,
  SearchProvider,
  SearchQuery,
  SearchResult,
  SourceId,
} from '@olcys/core';
import { SyntheticIdentifierError } from '../framework/errors.ts';
import { note } from '../framework/status.ts';
import type { SubjectSearchQuery } from './query.ts';

/** `partial`: results are not a complete exact-match list (rewritten query, pages that could not be indexed). */
export type SearchStatus = 'ok' | 'not_found' | 'partial' | 'blocked' | 'error';

/** What one query returned. */
export interface SearchRun {
  status: SearchStatus;
  /** Ranks 1…n in provider order (the mock: by occurrences, then URL). */
  results: SearchResult[];
  notes: string[];
  /** Provenance of every provider request the results rest on (the capture's `fetchIds`). */
  fetchIds: Id[];
  /** The provider's main response (the API answer; the sitemap for the mock); absent when nothing was answered. */
  provenance?: ProvenanceEnvelope;
  retrievedAt: IsoDateTime;
}

export interface SearchAdapter extends SearchProvider {
  readonly id: SourceId;
  /** True when the provider's terms allow storing result titles and snippets (else only rank and URL are kept). */
  readonly storesResults: boolean;
  run(query: SubjectSearchQuery, ctx: RunContext): Promise<SearchRun>;
}

/** Thrown by the port method `search()` when the provider failed, so a failure never reads as "no results". */
export class SearchFailedError extends Error {
  readonly status: SearchStatus;
  readonly notes: readonly string[];
  constructor(providerId: string, status: SearchStatus, notes: readonly string[]) {
    super(`search ${providerId} ${status}: ${notes.join('; ') || 'no detail'}`);
    this.name = 'SearchFailedError';
    this.status = status;
    this.notes = notes;
  }
}

/** The core port on top of `run()`: results only; `error` and `blocked` throw. */
export function portSearch(
  adapter: Pick<SearchAdapter, 'id' | 'run'>,
): (query: SearchQuery, ctx: RunContext) => Promise<SearchResult[]> {
  return async (query, ctx) => {
    const run = await adapter.run(query, ctx);
    if (run.status === 'error' || run.status === 'blocked')
      throw new SearchFailedError(adapter.id, run.status, run.notes);
    return run.results;
  };
}

/**
 * Sends one provider request; expected transport outcomes (allow-list denial, missing recording, timeouts, refused
 * connections, a synthetic identifier in live mode) become a note, anything else is a bug and is rethrown.
 */
export async function providerFetch(
  ctx: RunContext,
  request: Parameters<RunContext['http']['fetch']>[0],
): Promise<{ response: EgressResponse } | { failure: string }> {
  try {
    return { response: await ctx.http.fetch(request) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.name === 'EgressDeniedError') return { failure: note('allow_list_denied', error.message) };
    if (error.name === 'ReplayMissError') return { failure: note('replay_miss', error.message) };
    if (error instanceof SyntheticIdentifierError)
      return { failure: note('synthetic_identifier_refused', error.message) };
    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      error.name === 'TypeError' ||
      /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|exceeds \d+ bytes|too many redirects/.test(
        error.message,
      )
    ) {
      return { failure: note('fetch_error', error.message) };
    }
    throw error;
  }
}

/** Plain text of a provider-supplied title or snippet (tags dropped, whitespace collapsed). */
export function plainText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text || undefined;
}

/** An absolute http(s) URL, else undefined. */
export function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = URL.parse(value.trim());
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.toString() : undefined;
}

/**
 * Result list in provider order: invalid or repeated URLs dropped, at most `max`, ranks 1…n, each result citing the
 * provider response it came from.
 */
export function rankResults(
  items: readonly { url?: string; title?: string; snippet?: string }[],
  provider: string,
  fetchId: Id,
  max: number,
): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of items) {
    if (out.length >= max) break;
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.snippet ? { snippet: item.snippet } : {}),
      rank: out.length + 1,
      provider,
      fetchId,
    });
  }
  return out;
}
