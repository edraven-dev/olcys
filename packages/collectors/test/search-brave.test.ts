/**
 * Brave Search API adapter against synthetic responses (hand-written in the documented shape): request parameters,
 * the subscription token kept out of every log, provenance and recording, result mapping, rewritten queries and the
 * HTTP error statuses. The network is a fake `fetch` behind the real egress client.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CollectorInput } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  braveSearchUrl,
  createBraveSearchCollector,
  createBraveSearchProvider,
  createCollectorConfig,
  loadFixtureManifest,
  runCollector,
  SourceCircuitBreaker,
  type CollectorConfig,
  type CollectorDeps,
  type SourceRegistry,
} from '../src/index.ts';
import { createTestRun, demoRegistry, identifier, JUSTIFICATION, TEST_REDACTOR } from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'search');
const TOKEN = 'TEST-BRAVE-TOKEN-0f1e2d3c';
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

let registry: SourceRegistry;
let config: CollectorConfig;
beforeAll(async () => {
  registry = await demoRegistry();
  // No persona manifest: the synthetic-identifier guard is exercised separately below.
  config = createCollectorConfig({ mode: 'live', env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
}

function setup(
  answer: () => { status: number; body: string },
  options: { record?: boolean; cassetteDir?: string } = {},
) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const { status, body } = answer();
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
  }) as typeof fetch;
  const scope = registry.resolveScope(
    { enabledSources: ['brave_search'], amberJustifications: { brave_search: JUSTIFICATION } },
    'live',
  );
  const test = createTestRun(scope, 'live', 'run-brave', { fetchImpl, ...options });
  const breaker = new SourceCircuitBreaker();
  const deps: CollectorDeps = {
    mode: 'live',
    config,
    robots: { check: async () => ({ allowed: true }) },
    breaker,
    redactor: TEST_REDACTOR,
  };
  return { sent, test, deps, scope, breaker };
}

const input = (kind: 'full_name' | 'email' | 'nickname', value: string): CollectorInput => ({
  identifiers: [identifier(kind, value)],
  accounts: [],
  addresses: [],
  depth: 0,
});

describe('Brave Search API', () => {
  it('sends an exact phrase without spelling correction or decorations, localised for names', () => {
    const url = new URL(
      braveSearchUrl({ text: '  Kacper   Fikcyjny ', exact: true, maxResults: 20, subject: 'full_name' }),
    );
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.search).toMatch(/[?&]q=%22Kacper\+Fikcyjny%22(&|$)/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: '"Kacper Fikcyjny"',
      count: '20',
      offset: '0',
      safesearch: 'off',
      spellcheck: 'false',
      text_decorations: 'false',
      result_filter: 'web',
      country: 'PL',
      search_lang: 'pl',
    });
    const email = new URL(
      braveSearchUrl({ text: 'kacper.fikcyjny@example.org', exact: true, maxResults: 50, subject: 'email' }),
    );
    expect([
      email.searchParams.get('country'),
      email.searchParams.get('search_lang'),
      email.searchParams.get('count'),
    ]).toEqual(['ALL', null, '20']);
  });

  it('keeps the token and the raw answer out of logs, provenance, storage and recordings; maps the results', async () => {
    const cassetteDir = await mkdtemp(join(tmpdir(), 'olcys-brave-'));
    const body = await fixture('brave-web.json');
    const { sent, test, deps } = setup(() => ({ status: 200, body }), { record: true, cassetteDir });
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: true }).create(
      registry.require('brave_search'),
      deps,
    );
    const result = await collector.collect(input('full_name', 'Kacper Fikcyjny'), test.ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['x-subscription-token']).toBe(TOKEN);
    expect(sent[0]?.headers['accept']).toBe('application/json');
    expect(sent[0]?.url).toMatch(
      /[?&]q=%22Kacper\+Fikcyjny%22&count=20&offset=0&safesearch=off&spellcheck=false&text_decorations=false/,
    );
    // Hash-only even with storage rights: the raw answer (snippets are scraped text) is neither stored nor recorded.
    await expect(readdir(join(cassetteDir, 'brave_search'))).rejects.toThrow(/ENOENT/);
    expect(test.envelopes.map((e) => e.bodyPersisted)).toEqual([false]);
    const stored = [...test.blobs.data.values()].map((bytes) => new TextDecoder().decode(bytes));
    for (const text of [JSON.stringify(test.logs), JSON.stringify(test.envelopes), JSON.stringify(result), ...stored]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('TESTSECRET');
    }
    expect(test.logs).toEqual([
      expect.objectContaining({ sourceId: 'brave_search', containsIdentifier: true, allowed: true }),
    ]);

    expect(result.status).toBe('ok');
    const urls = result.observations.filter((o) => o.property === 'search.result_url');
    expect(urls.map((o) => [o.value, o.locator.split('#')[1]])).toEqual([
      ['https://example.org/profil/fikcyjny_kacper', 'rank=1'],
      ['https://example.org/ogloszenie/81000001', 'rank=2'],
    ]);
    // Stored results keep titles and snippets, with secrets redacted.
    const capture = result.captures[0]!;
    const artifact = JSON.parse(new TextDecoder().decode(await test.blobs.get(capture.artifacts[0]!.blob.sha256))) as {
      results: { rank: number; url: string; title?: string; snippet?: string }[];
      storage: string;
    };
    expect(artifact.storage).toBe('full');
    expect(artifact.results[1]).toMatchObject({ rank: 2, title: 'Ogłoszenie testowe — sprzedam USDT' });
    expect(artifact.results[1]?.snippet).toContain('[REDACTED:test_secret]');
    expect(JSON.stringify(artifact)).not.toContain('TESTSECRET');
    expect(capture).toMatchObject({ sourceId: 'brave_search', status: 'ok', httpStatus: 200 });
    expect(capture.url).toBe(test.envelopes[0]?.url);
  });

  it('maps a synthetic response to ranked results of the brave_search provider (core port)', async () => {
    const body = await fixture('brave-web.json');
    const { test } = setup(() => ({ status: 200, body }));
    const provider = createBraveSearchProvider({ apiKey: TOKEN, storageRights: false });
    const results = await provider.search({ text: 'Kacper Fikcyjny', exact: true, maxResults: 20 }, test.ctx);
    expect(results.map((r) => [r.rank, r.provider, r.url])).toEqual([
      [1, 'brave_search', 'https://example.org/profil/fikcyjny_kacper'],
      [2, 'brave_search', 'https://example.org/ogloszenie/81000001'],
    ]);
    expect(results.every((r) => r.fetchId === test.envelopes[0]?.fetchId)).toBe(true);
  });

  it('discards the results of a rewritten query and says why', async () => {
    const body = await fixture('brave-altered.json');
    const { test, deps } = setup(() => ({ status: 200, body }));
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: false }).create(
      registry.require('brave_search'),
      deps,
    );
    const result = await collector.collect(input('full_name', 'Kacpr Fikcyjny'), test.ctx);
    expect(result.status).toBe('partial');
    expect(result.observations).toEqual([]);
    expect(result.notes.some((n) => n.startsWith('search_query_altered:'))).toBe(true);
    expect(result.captures[0]?.status).toBe('error');
  });

  it('reports zero results as not_found with a result count of 0', async () => {
    const body = await fixture('brave-empty.json');
    const { test, deps } = setup(() => ({ status: 200, body }));
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: false }).create(
      registry.require('brave_search'),
      deps,
    );
    const result = await collector.collect(input('email', 'kacper.fikcyjny@example.org'), test.ctx);
    expect(result.status).toBe('not_found');
    expect(result.observations.map((o) => [o.property, o.value])).toEqual([['search.result_count', '0']]);
    expect(result.captures[0]?.status).toBe('not_found');
  });

  it.each([
    [401, 'error', 'API key or plan rejected'],
    [403, 'error', 'API key or plan rejected'],
    [422, 'error', 'query rejected'],
    [500, 'error', 'provider error'],
  ])('HTTP %i → %s', async (status, expected, detail) => {
    const { test, deps } = setup(() => ({ status, body: '{"type":"ErrorResponse"}' }));
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: false }).create(
      registry.require('brave_search'),
      deps,
    );
    const result = await collector.collect(input('nickname', 'fikcyjny_kacper'), test.ctx);
    expect(result.status).toBe(expected);
    expect(result.observations).toEqual([]);
    expect(result.notes.join()).toContain(detail);
  });

  it('HTTP 429 → blocked (rate limited); the source is not asked again in the run', async () => {
    const { test, deps, scope, sent } = setup(() => ({ status: 429, body: '{}' }));
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: false }).create(
      registry.require('brave_search'),
      deps,
    );
    const first = await runCollector(collector, input('nickname', 'fikcyjny_kacper'), test.ctx, scope, deps);
    expect(first.status).toBe('blocked');
    expect(first.notes).toEqual(expect.arrayContaining(['barrier_blocked: HTTP 429', 'rate_limited: retry-after 30']));
    const second = await runCollector(collector, input('full_name', 'Kacper Fikcyjny'), test.ctx, scope, deps);
    expect([second.status, second.notes[0]?.startsWith('source_stopped:')]).toEqual(['blocked', true]);
    expect(sent).toHaveLength(1);
  });

  it('live: a synthetic persona identifier never reaches the provider', async () => {
    const manifest = await loadFixtureManifest();
    const { test, sent } = setup(() => ({ status: 200, body: '{}' }));
    const deps: CollectorDeps = {
      mode: 'live',
      config: createCollectorConfig({ mode: 'live', env: {}, ...(manifest ? { manifest } : {}) }),
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collector = createBraveSearchCollector({ apiKey: TOKEN, storageRights: false }).create(
      registry.require('brave_search'),
      deps,
    );
    const result = await collector.collect(input('nickname', 'fikcyjny_kacper'), test.ctx);
    expect(result.status).toBe('error');
    expect(result.notes[0]).toMatch(/^synthetic_identifier_refused:/);
    expect(sent).toEqual([]);
  });
});
