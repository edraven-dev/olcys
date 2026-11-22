/**
 * The search collector: what is kept under restrictive provider terms, observations and locators, the search modes,
 * exact phrases, and the pivot rules I5/E3 on the fixture site — a page reached both directly and through search is
 * collected once.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CollectorInput, EgressRequest } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  collectCase,
  createBraveSearchProvider,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createMojeekSearchCollector,
  createSearchCollector,
  exactPhrase,
  searchCollectorFactories,
  searchModeFromEnv,
  SourceCircuitBreaker,
  type CollectCaseResult,
  type CollectorConfig,
  type CollectorDeps,
  type SourceRegistry,
} from '../src/index.ts';
import {
  createTestRun,
  DEMO_SCOPE,
  demoRegistry,
  identifier,
  JUSTIFICATION,
  PERSONA_IDENTIFIERS,
  startFixture,
  testConfig,
  TEST_REDACTOR,
} from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'search');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let registry: SourceRegistry;
beforeAll(async () => {
  registry = await demoRegistry();
});

const nameInput = (): CollectorInput => ({
  identifiers: [identifier('full_name', 'Kacper Fikcyjny')],
  accounts: [],
  addresses: [],
  depth: 0,
});

async function braveRun(storesResults: boolean, storageRights: boolean) {
  const body = await readFile(join(FIXTURES, 'brave-web.json'), 'utf8');
  const requests: EgressRequest[] = [];
  const scope = registry.resolveScope(
    { enabledSources: ['brave_search'], amberJustifications: { brave_search: JUSTIFICATION } },
    'live',
  );
  const test = createTestRun(scope, 'live', 'run-storage', {
    fetchImpl: (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    wrap: (client) => ({
      fetch: (request) => {
        requests.push(request);
        return client.fetch(request);
      },
    }),
  });
  const deps: CollectorDeps = {
    mode: 'live',
    config: createCollectorConfig({ mode: 'live', env: {} }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const collector = createSearchCollector({
    provider: createBraveSearchProvider({ apiKey: 'test-token', storageRights }),
    descriptor: registry.require('brave_search'),
    deps,
    storesResults,
  });
  const result = await collector.collect(nameInput(), test.ctx);
  const capture = result.captures[0]!;
  const artifact = JSON.parse(new TextDecoder().decode(await test.blobs.get(capture.artifacts[0]!.blob.sha256))) as {
    storage: string;
    results: Record<string, unknown>[];
  };
  return { result, requests, test, artifact };
}

describe('result storage follows the provider terms', () => {
  it('without storage rights: hash-only requests, no stored body, only rank and URL in the capture', async () => {
    const { result, requests, test, artifact } = await braveRun(false, false);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.persistBody === false)).toBe(true);
    expect(test.envelopes.every((e) => e.bodyPersisted === false)).toBe(true);
    expect(await Promise.all(test.envelopes.map((e) => test.blobs.has(e.body.sha256)))).toEqual(
      test.envelopes.map(() => false),
    );
    expect(artifact.storage).toBe('rank_url');
    expect(artifact.results).toEqual([
      { rank: 1, url: 'https://example.org/profil/fikcyjny_kacper' },
      { rank: 2, url: 'https://example.org/ogloszenie/81000001' },
    ]);
    expect(result.notes).toContain(
      'search_results_not_stored: provider terms: only the rank and URL of each result are kept',
    );
  });

  it('the collector enforces it even when the provider itself would store', async () => {
    const { requests, test, artifact } = await braveRun(false, true);
    expect(requests.every((r) => r.persistBody === false)).toBe(true);
    expect(test.envelopes.every((e) => e.bodyPersisted === false)).toBe(true);
    expect(artifact.results.every((r) => Object.keys(r).toSorted().join() === 'rank,url')).toBe(true);
  });

  it('with storage rights the provider body is kept and the capture has titles and snippets', async () => {
    const { test, artifact } = await braveRun(true, true);
    expect(test.envelopes[0]?.bodyPersisted).toBe(true);
    expect(await test.blobs.has(test.envelopes[0]!.body.sha256)).toBe(true);
    expect(artifact.storage).toBe('full');
    expect(artifact.results[0]).toHaveProperty('snippet');
  });

  it('Mojeek Startup stores nothing but rank and URL', async () => {
    const body = await readFile(join(FIXTURES, 'mojeek-ok.json'), 'utf8');
    const scope = registry.resolveScope(
      { enabledSources: ['mojeek_search'], amberJustifications: { mojeek_search: JUSTIFICATION } },
      'live',
    );
    const test = createTestRun(scope, 'live', 'run-mojeek-startup', {
      fetchImpl: (async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    const deps: CollectorDeps = {
      mode: 'live',
      config: createCollectorConfig({ mode: 'live', env: {} }),
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collector = createMojeekSearchCollector({ apiKey: 'k', plan: 'startup' }).create(
      registry.require('mojeek_search'),
      deps,
    );
    const result = await collector.collect(nameInput(), test.ctx);
    expect(test.envelopes.every((e) => e.bodyPersisted === false)).toBe(true);
    const capture = result.captures[0]!;
    const artifact = JSON.parse(new TextDecoder().decode(await test.blobs.get(capture.artifacts[0]!.blob.sha256))) as {
      results: Record<string, unknown>[];
    };
    expect(artifact.results.every((r) => Object.keys(r).toSorted().join() === 'rank,url')).toBe(true);
  });
});

const ids = (factories: { sourceId: string }[]) => factories.map((f) => f.sourceId);
const pageFacts = (r: CollectCaseResult) =>
  r.observations.filter((o) => o.sourceId !== 'mock_search').map((o) => [o.sourceId, o.property, o.value, o.locator]);

const searchIds = (env: Record<string, string>, mode: 'offline' | 'replay' | 'live' = 'offline') =>
  ids(
    createDefaultCollectorRegistry({ mode, env })
      .list()
      .filter((f) => f.webSearch),
  );

describe('search modes', () => {
  const keys = { BRAVE_SEARCH_API_KEY: 'brave-key', MOJEEK_API_KEY: 'mojeek-key' };

  it('defaults to the mock search', () => {
    expect(searchModeFromEnv({})).toBe('mock');
    expect(searchModeFromEnv({ OLCYS_SEARCH_MODE: ' External ' })).toBe('external');
    expect(searchIds({})).toEqual(['mock_search']);
  });

  it('off registers no search collector; an unknown mode is a configuration error', () => {
    expect(searchIds({ OLCYS_SEARCH_MODE: 'off' })).toEqual([]);
    expect(() => searchModeFromEnv({ OLCYS_SEARCH_MODE: 'google' })).toThrow(/OLCYS_SEARCH_MODE must be one of/);
  });

  it('external adds Brave and Mojeek only in live and replay runs and only with a key', () => {
    const external = { OLCYS_SEARCH_MODE: 'external', OLCYS_MODE: 'offline', ...keys };
    expect(searchIds(external, 'offline')).toEqual(['mock_search']);
    expect(searchIds(external, 'live')).toEqual(['mock_search', 'brave_search', 'mojeek_search']);
    expect(searchIds(external, 'replay')).toEqual(['mock_search', 'brave_search', 'mojeek_search']);
    expect(searchIds({ OLCYS_SEARCH_MODE: 'external', MOJEEK_API_KEY: 'k' }, 'live')).toEqual([
      'mock_search',
      'mojeek_search',
    ]);
    expect(ids(searchCollectorFactories({ mode: 'live', env: { ...keys } }))).toEqual(['mock_search']);
    expect(() =>
      searchCollectorFactories({ mode: 'live', env: { OLCYS_SEARCH_MODE: 'external', ...keys, MOJEEK_PLAN: 'gold' } }),
    ).toThrow(/MOJEEK_PLAN/);
  });
});

describe('exact phrases', () => {
  it('quotes the normalised text', () => {
    expect(exactPhrase('  Kacper   Fikcyjny ')).toBe('"Kacper Fikcyjny"');
    expect(exactPhrase('ｆｉｋｃｙｊｎｙ_kacper')).toBe('"fikcyjny_kacper"');
    expect(exactPhrase('a'.repeat(600))).toHaveLength(602);
    expect(exactPhrase(Array.from({ length: 75 }, () => 'w').join(' '))).toMatch(/^"w( w){74}"$/);
  });

  it('refuses a quote inside, more than 600 characters or more than 75 words', () => {
    expect(() => exactPhrase('Kacper "Fikcyjny"')).toThrow(/double quote/);
    expect(() => exactPhrase('a'.repeat(601))).toThrow(/600 characters/);
    expect(() => exactPhrase(Array.from({ length: 76 }, () => 'w').join(' '))).toThrow(/75 words/);
    expect(() => exactPhrase('   ')).toThrow(/empty/);
  });
});

describe('search on the fixture site', () => {
  let server: FixtureServer;
  let config: CollectorConfig;
  beforeAll(async () => {
    server = await startFixture('v1');
    config = await testConfig(server);
  });
  afterAll(async () => {
    await server.close();
  });

  async function run(enabledSources: string[], identifiers = PERSONA_IDENTIFIERS(), cfg = config) {
    const scope = registry.resolveScope({ ...DEMO_SCOPE, enabledSources }, 'offline');
    const test = createTestRun(scope);
    const result = await collectCase({
      identifiers,
      scope,
      sources: registry,
      ctx: test.ctx,
      config: cfg,
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 2,
    });
    return { result, test };
  }

  const WITH_SEARCH = [...DEMO_SCOPE.enabledSources, 'mock_search'];

  it('emits result URLs with rank locators per query and a result count; nothing found is not_found', async () => {
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const scope = registry.resolveScope({ enabledSources: ['mock_search'], amberJustifications: {} }, 'offline');
    const test = createTestRun(scope);
    const collector = createDefaultCollectorRegistry({ mode: 'offline' })
      .get('mock_search')!
      .create(registry.require('mock_search'), deps);
    const found = await collector.collect(nameInput(), test.ctx);
    const key = `search:mock_search:${sha256('Kacper Fikcyjny')}`;
    expect(found.status).toBe('ok');
    expect(found.observations.map((o) => [o.subject, o.property, o.locator])).toEqual([
      [{ type: 'page', key }, 'search.result_url', `${key}#rank=1`],
      [{ type: 'page', key }, 'search.result_count', `${key}#search.result_count`],
    ]);
    expect(found.captures[0]).toMatchObject({
      sourceId: 'mock_search',
      status: 'ok',
      url: `${server.url}/sitemap.xml`,
      artifacts: [{ kind: 'json' }],
    });
    expect(found.captures[0]?.fetchIds.length).toBeGreaterThan(5);

    const nobody = await collector.collect(
      { ...nameInput(), identifiers: [identifier('full_name', 'Nikt Taki')] },
      test.ctx,
    );
    expect(nobody.status).toBe('not_found');
    expect(nobody.observations.map((o) => [o.property, o.value])).toEqual([['search.result_count', '0']]);
  });

  it('plans one query per identifier and collects pages found both ways only once', async () => {
    const plain = await run(DEMO_SCOPE.enabledSources);
    const searched = await run(WITH_SEARCH);
    const { result } = searched;
    expect(
      result.tasks.filter((t) => t.sourceId === 'mock_search').map((t) => [t.key, t.status, t.provenance.rule]),
    ).toEqual([
      ['mock_search|query:fikcyjny_kacper', 'ok', 'I5'],
      ['mock_search|query:kacper fikcyjny', 'ok', 'I5'],
      ['mock_search|query:kacper.fikcyjny@example.org', 'ok', 'I5'],
    ]);
    // Every page the search found is already collected (watch list, same nick, the anchor): duplicates, not new tasks.
    const fromSearch = result.skipped.filter((s) => s.provenance.rule === 'E3');
    expect(fromSearch.every((s) => s.skip === 'duplicate' && s.provenance.reason === 'search_result')).toBe(true);
    expect(fromSearch.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        'bitcointalk|id:bitcointalk:900001',
        'wykop|handle:wykop:fikcyjny_kacper',
        `fixture_site|url:${server.url}/tablica/ogloszenie/81000001/`,
        'telegram_preview|url:https://t.me/s/olcys_test_ostrzezenia/',
      ]),
    );
    expect(result.tasks.filter((t) => t.sourceId !== 'mock_search').map((t) => [t.key, t.status])).toEqual(
      plain.result.tasks.map((t) => [t.key, t.status]),
    );
    expect(result.captures.filter((c) => c.sourceId !== 'mock_search')).toHaveLength(plain.result.captures.length);
    expect(pageFacts(result)).toEqual(pageFacts(plain.result));
    expect(result.accounts.map((a) => [a.platform, a.handle])).toEqual(
      plain.result.accounts.map((a) => [a.platform, a.handle]),
    );
    expect(result.partial).toBe(false);
  });

  it('collects a persona page that only the search found', async () => {
    const { result } = await run(WITH_SEARCH, [identifier('full_name', 'Kacper Fikcyjny')], {
      ...config,
      watchList: [],
    });
    const ad = result.tasks.find((t) => t.sourceId === 'fixture_site');
    expect(ad).toMatchObject({
      key: `fixture_site|url:${server.url}/tablica/ogloszenie/81000001/`,
      status: 'ok',
      depth: 1,
      provenance: { reason: 'search_result', rule: 'E3', parentTaskKey: 'mock_search|query:kacper fikcyjny' },
    });
    expect(result.accounts.find((a) => a.platform === 'tablica')).toMatchObject({
      handle: 'fikcyjny_kacper',
      discoveredVia: { sourceId: 'fixture_site', method: 'search' },
    });
  });

  it('follows result URLs only into sources the case enables', async () => {
    const { result } = await run(['mock_search'], [identifier('nickname', 'fikcyjny_kacper')], {
      ...config,
      watchList: [],
    });
    const skips = result.skipped.filter((s) => s.provenance.rule === 'E3');
    expect(skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'bitcointalk|id:bitcointalk:900001', skip: 'source_not_enabled' }),
        expect.objectContaining({ key: 'wykop|handle:wykop:fikcyjny_kacper', skip: 'source_not_enabled' }),
      ]),
    );
    const contacted = new Set(result.tasks.map((t) => t.sourceId));
    expect([...contacted].toSorted()).toEqual(['fixture_site', 'mock_search']);
  });
});
