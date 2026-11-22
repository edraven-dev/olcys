/**
 * Deterministic mock search over the synthetic fixture site (the demo default): reads `<loc>` values from the site's
 * sitemap, fetches every page robots.txt allows (once per run), and matches queries locally, so no identifier leaves
 * the process — the requests are the same whatever is searched. Exact query: the phrase, case-insensitive, as whole
 * words (no letter, digit or `_` right before or after it); otherwise every token must occur as a whole word.
 * Order: occurrences (descending), then URL.
 */
import type { Id, RunContext, SearchResult, SecretRedactor } from '@olcys/core';
import { nowIso } from '@olcys/core';
import type { RobotsPolicy } from '../framework/http.ts';
import { isBarrierStatus, note, statusFromHttp } from '../framework/status.ts';
import { toLogicalUrl, type FixtureMapping } from '../framework/urls.ts';
import { blockText, decodeBody, parseHtml, textOf } from '../html/dom.ts';
import { HTML_ACCEPT } from '../html/page.ts';
import { providerFetch, portSearch, type SearchAdapter, type SearchRun } from './provider.ts';
import { normaliseQueryText, type SubjectSearchQuery } from './query.ts';

export const MOCK_SEARCH_ID = 'mock_search';
export const DEFAULT_SITEMAP_PATH = '/sitemap.xml';
export const MOCK_MAX_PAGES = 200;
export const SNIPPET_RADIUS = 80;
const XML_ACCEPT = 'application/xml,text/xml;q=0.9,*/*;q=0.8';

export interface MockSearchOptions {
  /** Fixture site origin, e.g. `http://127.0.0.1:4100`. */
  baseUrl: string;
  sitemapPath?: string;
  /** robots.txt decisions (pages the site disallows, e.g. `/private/`, are never fetched). */
  robots: RobotsPolicy;
  /** Removes secrets from page text before it is indexed, so no snippet can carry one. */
  redactor: SecretRedactor;
  /** Maps fixture URLs to the live URLs they stand for (results then name the live page, as the collectors do). */
  mapping?: FixtureMapping;
  maxPages?: number;
}

interface IndexedPage {
  /** Result URL: the live URL the page stands for, else the fixture URL. */
  url: string;
  title?: string;
  /** Visible text, NFKC, whitespace collapsed, secrets redacted. */
  text: string;
  /** `text` lower-cased character by character (same length, so offsets match). */
  folded: string;
  fetchId: Id;
}

interface SearchIndex {
  pages: IndexedPage[];
  fetchIds: Id[];
  notes: string[];
  /** Listed pages that could not be read: a missing result is not evidence of absence. */
  incomplete: boolean;
  /** The sitemap could not be read (no index at all). */
  failure?: 'error' | 'blocked';
  blocked: boolean;
  provenance?: SearchRun['provenance'];
  builtAt: string;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return XML_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** `<loc>` values resolved against the sitemap URL; other origins and non-HTTP locations are ignored. */
export function parseSitemap(xml: string, sitemapUrl: string): { urls: string[]; ignored: number } {
  const origin = new URL(sitemapUrl).origin;
  const urls: string[] = [];
  let ignored = 0;
  for (const match of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const raw = (match[1] ?? '').trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
    const loc = (cdata ? (cdata[1] ?? '') : decodeXml(raw)).trim();
    const url = loc ? URL.parse(loc, sitemapUrl) : null;
    if (!url || url.origin !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      ignored += 1;
      continue;
    }
    url.hash = '';
    const href = url.toString();
    if (!urls.includes(href)) urls.push(href);
  }
  return { urls, ignored };
}

/** NFKC, whitespace collapsed (same as queries). */
function normaliseText(text: string): string {
  return normaliseQueryText(text);
}

/** Lower case per character, keeping characters whose lower case has another length (offsets stay aligned). */
export function foldCase(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Visible text of a page (`<script>`, `<style>` dropped, entities decoded) and its title. */
function pageText(body: string, contentType: string): { title?: string; text: string } {
  if (!/html|xml/i.test(contentType)) return { text: normaliseText(body) };
  const doc = parseHtml(body);
  const root = doc.querySelector('html') ?? doc.body;
  const title = normaliseText(textOf(doc.querySelector('title')));
  return { ...(title ? { title } : {}), text: normaliseText(root ? blockText(root) : '') };
}

const WORD = /^[\p{L}\p{N}\p{M}_]$/u;

/** True when the code point ending at `end` (exclusive) is a word character. */
function wordBefore(text: string, end: number): boolean {
  if (end <= 0) return false;
  const low = text.charCodeAt(end - 1);
  const start = end >= 2 && low >= 0xdc00 && low <= 0xdfff ? end - 2 : end - 1;
  return WORD.test(String.fromCodePoint(text.codePointAt(start) ?? 0));
}

/** True when the code point starting at `start` is a word character. */
function wordAt(text: string, start: number): boolean {
  if (start >= text.length) return false;
  return WORD.test(String.fromCodePoint(text.codePointAt(start) ?? 0));
}

/**
 * Non-overlapping occurrences of `needle` as whole words: where the needle starts (ends) with a word character, the
 * text must not continue it, so `kacper fikcyjny` is not found inside `fikcyjny_kacper fikcyjny_kacper`.
 */
function occurrences(haystack: string, needle: string): { count: number; first: number } {
  const open = wordAt(needle, 0);
  const close = wordBefore(needle, needle.length);
  let count = 0;
  let first = -1;
  for (let at = haystack.indexOf(needle); at >= 0;) {
    const end = at + needle.length;
    if ((!open || !wordBefore(haystack, at)) && (!close || !wordAt(haystack, end))) {
      if (first < 0) first = at;
      count += 1;
      at = haystack.indexOf(needle, end);
    } else {
      at = haystack.indexOf(needle, at + 1);
    }
  }
  return { count, first };
}

/** Occurrences of the query in a page: the phrase (exact) or every token (all must occur). */
function matchPage(page: IndexedPage, query: SubjectSearchQuery): { count: number; first: number; length: number } {
  const needle = foldCase(normaliseQueryText(query.text));
  if (!needle) return { count: 0, first: -1, length: 0 };
  if (query.exact) return { ...occurrences(page.folded, needle), length: needle.length };
  let count = 0;
  let first = -1;
  let length = 0;
  for (const token of new Set(needle.split(' '))) {
    const hit = occurrences(page.folded, token);
    if (hit.count === 0) return { count: 0, first: -1, length: 0 };
    count += hit.count;
    if (first < 0 || hit.first < first) {
      first = hit.first;
      length = token.length;
    }
  }
  return { count, first, length };
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** ±80 characters around the first hit, `…` where the text was cut. */
export function snippetAround(text: string, start: number, length: number, radius: number = SNIPPET_RADIUS): string {
  let from = Math.max(0, start - radius);
  let to = Math.min(text.length, start + length + radius);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to += 1;
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

const byUrl = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Complete index: ok / not_found; incomplete: partial with results, else blocked or error (absence proves nothing). */
function statusOf(index: SearchIndex, found: number): SearchRun['status'] {
  if (!index.incomplete) return found ? 'ok' : 'not_found';
  if (found) return 'partial';
  return index.blocked ? 'blocked' : 'error';
}

export function createMockSearchProvider(options: MockSearchOptions): SearchAdapter {
  // Under the base URL's path, like every fixture path (`OLCYS_FIXTURE_BASE_URL` may carry one).
  const sitemapPath = (options.sitemapPath ?? DEFAULT_SITEMAP_PATH).replace(/^\/+/, '');
  const sitemapUrl = new URL(`${options.baseUrl.replace(/\/+$/, '')}/${sitemapPath}`).toString();
  const maxPages = options.maxPages ?? MOCK_MAX_PAGES;
  let cache: { runId: Id; index: Promise<SearchIndex> } | undefined;
  const resultUrl = (url: string): string => (options.mapping ? toLogicalUrl(url, options.mapping) : url);

  async function crawl(ctx: RunContext): Promise<SearchIndex> {
    const notes: string[] = [];
    const fetchIds: Id[] = [];
    const failed = (failure: 'error' | 'blocked', provenance?: SearchRun['provenance']): SearchIndex => ({
      pages: [],
      fetchIds,
      notes,
      incomplete: true,
      failure,
      blocked: failure === 'blocked',
      ...(provenance ? { provenance } : {}),
      builtAt: nowIso(ctx.clock),
    });

    const sitemapRobots = await options.robots.check(sitemapUrl, MOCK_SEARCH_ID);
    if (!sitemapRobots.allowed) {
      notes.push(note('robots_disallowed', `${sitemapUrl} (${sitemapRobots.reason})`));
      return failed('error');
    }
    const sitemap = await providerFetch(ctx, {
      url: sitemapUrl,
      sourceId: MOCK_SEARCH_ID,
      purpose: 'mock search sitemap',
      // The index is built the same way for every query: no request carries anything from the case.
      containsIdentifier: false,
      redirect: 'manual',
      headers: { accept: XML_ACCEPT },
    });
    if ('failure' in sitemap) {
      notes.push(sitemap.failure);
      return failed('error');
    }
    const { provenance } = sitemap.response;
    fetchIds.push(provenance.fetchId);
    const sitemapStatus = statusFromHttp(sitemap.response.status);
    if (sitemapStatus !== 'ok') {
      notes.push(note('search_provider_error', `sitemap ${sitemapUrl}: HTTP ${sitemap.response.status}`));
      return failed(isBarrierStatus(sitemapStatus) ? 'blocked' : 'error', provenance);
    }
    const listed = parseSitemap(sitemap.response.text(), sitemapUrl);
    if (listed.ignored)
      notes.push(note('search_index_skipped', `${listed.ignored} sitemap location(s) of another origin`));
    if (listed.urls.length > maxPages) {
      notes.push(note('truncated', `sitemap lists ${listed.urls.length} pages; indexed the first ${maxPages}`));
    }

    const pages: IndexedPage[] = [];
    let incomplete = listed.urls.length > maxPages;
    let blocked = false;
    // Sequential on purpose: one request at a time, robots.txt checked before each page.
    for (const url of listed.urls.slice(0, maxPages)) {
      ctx.signal?.throwIfAborted();
      // oxlint-disable-next-line no-await-in-loop
      const decision = await options.robots.check(url, MOCK_SEARCH_ID);
      if (!decision.allowed) {
        notes.push(note('robots_disallowed', `${resultUrl(url)} (${decision.reason})`));
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const fetched = await providerFetch(ctx, {
        url,
        sourceId: MOCK_SEARCH_ID,
        purpose: 'mock search index',
        containsIdentifier: false,
        redirect: 'manual',
        // Hash only: a page may hold secrets; its evidence copy is made (redacted) by the page's own collector.
        persistBody: false,
        headers: { accept: HTML_ACCEPT },
      });
      if ('failure' in fetched) {
        notes.push(fetched.failure);
        incomplete = true;
        continue;
      }
      const { response } = fetched;
      fetchIds.push(response.provenance.fetchId);
      const status = statusFromHttp(response.status);
      if (status === 'not_found') {
        notes.push(note('search_index_skipped', `${resultUrl(url)}: HTTP ${response.status}`));
        continue;
      }
      if (status !== 'ok') {
        incomplete = true;
        if (isBarrierStatus(status)) {
          // A barrier ends the crawl: nothing is retried or worked around.
          notes.push(note(`barrier_${status}`, `${resultUrl(url)}: HTTP ${response.status}`));
          blocked = true;
          break;
        }
        notes.push(note('search_index_skipped', `${resultUrl(url)}: HTTP ${response.status}`));
        continue;
      }
      const contentType = response.headers['content-type'] ?? '';
      const { text: raw } = decodeBody(response.body, contentType);
      const { title, text } = pageText(options.redactor.redact(raw).text, contentType);
      pages.push({
        url: resultUrl(url),
        ...(title ? { title } : {}),
        text,
        folded: foldCase(text),
        fetchId: response.provenance.fetchId,
      });
    }
    return { pages, fetchIds, notes, incomplete, blocked, provenance, builtAt: nowIso(ctx.clock) };
  }

  /** One index per run: every query of the run sees the same pages. */
  function indexFor(ctx: RunContext): Promise<SearchIndex> {
    if (cache?.runId !== ctx.runId) {
      const index = crawl(ctx);
      cache = { runId: ctx.runId, index };
      index.catch(() => {
        if (cache?.index === index) cache = undefined;
      });
    }
    return cache.index;
  }

  const adapter: SearchAdapter = {
    id: MOCK_SEARCH_ID,
    storesResults: true,
    async run(query, ctx) {
      const index = await indexFor(ctx);
      const common = {
        notes: [...index.notes],
        fetchIds: [...index.fetchIds],
        ...(index.provenance ? { provenance: index.provenance } : {}),
        retrievedAt: index.builtAt,
      };
      if (index.failure) return { ...common, status: index.failure, results: [] };
      const hits = index.pages
        .map((page) => ({ page, hit: matchPage(page, query) }))
        .filter(({ hit }) => hit.count > 0)
        .toSorted((a, b) => b.hit.count - a.hit.count || byUrl(a.page.url, b.page.url))
        .slice(0, Math.max(0, query.maxResults));
      const results = hits.map(({ page, hit }, i) => {
        const result: SearchResult = {
          url: page.url,
          snippet: snippetAround(page.text, hit.first, hit.length),
          rank: i + 1,
          provider: MOCK_SEARCH_ID,
          fetchId: page.fetchId,
        };
        if (page.title) result.title = page.title;
        return result;
      });
      return { ...common, status: statusOf(index, results.length), results };
    },
    search: (query, ctx) => portSearch(adapter)(query, ctx),
  };
  return adapter;
}
