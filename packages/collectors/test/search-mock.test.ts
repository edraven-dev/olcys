/**
 * Mock search: a synthetic sitemap served by a fake egress client (ranks, fetch ids, snippets, robots.txt, indexing
 * rules), then the real fixture site in both variants through the real egress client and the collector.
 */
import type { EgressRequest, RunContext } from '@olcys/core';
import { RobotsCache } from '@olcys/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  createMockSearchCollector,
  createMockSearchProvider,
  parseSitemap,
  SourceCircuitBreaker,
  type CollectorDeps,
  type SearchRun,
  type SourceRegistry,
  type SubjectSearchQuery,
} from '../src/index.ts';
import {
  createTestRun,
  demoRegistry,
  fakeEgress,
  identifier,
  MemoryBlobs,
  memoryLogger,
  testRunId,
  startFixture,
  testConfig,
  TEST_REDACTOR,
  USER_AGENT,
} from './helpers.ts';

const BASE = 'http://127.0.0.1:4100';
const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title><style>.x{content:"fikcyjny_kacper"}</style></head>` +
  `<body><p>${body}</p><script>var nick = "fikcyjny_kacper";</script></body></html>`;

/** Three pages and a disallowed one, all listed in the sitemap (plus one of another origin). */
const SITE: Record<string, { status?: number; type?: string; body: string }> = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
  '/sitemap.xml': {
    type: 'application/xml',
    body:
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      '<url><loc>/c/profil</loc></url><url><loc>http://127.0.0.1:4100/a/wpis?x=1&amp;y=2</loc></url>' +
      '<url><loc>/b/inne</loc></url><url><loc>/private/sekret</loc></url>' +
      '<url><loc>https://example.org/obca</loc></url></urlset>',
  },
  '/c/profil': { body: page('Profil fikcyjny_kacper', 'Użytkownik fikcyjny_kacper pisze: fikcyjny_kacper tu był.') },
  '/a/wpis': {
    body: page('Wpis', 'Autor: Fikcyjny_Kacper &amp; przyjaciele. Kacper Fikcyjny, kontakt TESTSECRET-zz9 dalej.'),
  },
  '/b/inne': { body: page('Inne', 'Nic tu nie ma o tej osobie, tylko fikcyjny-kacper z myślnikiem.') },
  '/private/sekret': { body: page('Sekret', 'fikcyjny_kacper fikcyjny_kacper fikcyjny_kacper') },
};

function fakeSite(site = SITE) {
  return fakeEgress((request) => {
    const entry = site[new URL(request.url).pathname];
    if (!entry) return { status: 404, body: 'not found', headers: { 'content-type': 'text/plain' } };
    return {
      status: entry.status ?? 200,
      body: entry.body,
      headers: { 'content-type': `${entry.type ?? 'text/html'}; charset=utf-8` },
    };
  });
}

function runContext(http: RunContext['http'], label = '00000000-0000-7000-8000-000000000905'): RunContext {
  return {
    runId: testRunId(label),
    caseId: '00000000-0000-7000-8000-000000000902',
    mode: 'offline',
    http,
    blobs: new MemoryBlobs(),
    clock: { now: () => new Date('2026-11-21T10:00:00.000Z') },
    logger: memoryLogger(),
  };
}

const exact = (text: string): SubjectSearchQuery => ({ text, exact: true, maxResults: 20, subject: 'nickname' });
const paths = (requests: EgressRequest[]) => requests.map((r) => new URL(r.url).pathname);

describe('mock search over a synthetic sitemap', () => {
  let egress: ReturnType<typeof fakeSite>;
  let run: SearchRun;
  const fetchOf = (path: string) =>
    `00000000-0000-7000-8000-${String(paths(egress.requests).indexOf(path) + 1).padStart(12, '0')}`;
  beforeAll(async () => {
    egress = fakeSite();
    const provider = createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(egress, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    run = await provider.run(exact('fikcyjny_kacper'), runContext(egress));
  });

  it('returns exactly the pages containing the phrase, by occurrences then URL, citing each page fetch', () => {
    expect(run.status).toBe('ok');
    expect(run.results.map((r) => [r.rank, r.url, r.provider])).toEqual([
      [1, `${BASE}/c/profil`, 'mock_search'],
      [2, `${BASE}/a/wpis?x=1&y=2`, 'mock_search'],
    ]);
    expect(run.results.map((r) => r.fetchId)).toEqual([fetchOf('/c/profil'), fetchOf('/a/wpis')]);
    expect(run.fetchIds).toContain(fetchOf('/sitemap.xml'));
    expect(run.results[0]?.title).toBe('Profil fikcyjny_kacper');
  });

  it('cuts the snippet around the first hit, after removing secrets and decoding entities', () => {
    expect(run.results[0]?.snippet).toContain('fikcyjny_kacper');
    const second = run.results[1]?.snippet ?? '';
    expect(second).toContain('Fikcyjny_Kacper & przyjaciele');
    expect(second).toContain('[REDACTED:test_secret]');
    expect(second).not.toContain('TESTSECRET');
  });

  it('never fetches a page robots.txt disallows, nor locations of another origin', () => {
    expect(paths(egress.requests)).toEqual(['/robots.txt', '/sitemap.xml', '/c/profil', '/a/wpis', '/b/inne']);
    expect(run.notes.some((n) => n.startsWith('robots_disallowed:') && n.includes('/private/sekret'))).toBe(true);
    expect(run.notes).toContain('search_index_skipped: 1 sitemap location(s) of another origin');
  });

  it('sends nothing from the case and keeps page bodies hash-only', () => {
    expect(egress.requests.every((r) => r.containsIdentifier === false && r.sourceId === 'mock_search')).toBe(true);
    const pages = egress.requests.filter((r) => !/robots|sitemap/.test(r.url));
    expect(pages.every((r) => r.persistBody === false)).toBe(true);
  });

  it('builds the index once per run: further queries send no request, a new run crawls again', async () => {
    const http = fakeSite();
    const provider = createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(http, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    const ctx = runContext(http, 'run-a');
    await provider.run(exact('fikcyjny_kacper'), ctx);
    const sent = http.requests.length;
    const name = await provider.run({ text: 'kacper fikcyjny', exact: false, maxResults: 20 }, ctx);
    expect(http.requests).toHaveLength(sent);
    // Every token as a whole word: `fikcyjny-kacper` has both, `fikcyjny_kacper` is one word.
    expect(name.results.map((r) => r.url)).toEqual([`${BASE}/a/wpis?x=1&y=2`, `${BASE}/b/inne`]);
    await provider.run(exact('fikcyjny_kacper'), runContext(http, 'run-b'));
    expect(http.requests.length).toBeGreaterThan(sent);
  });

  it('matches after NFKC, whole words only, ignoring scripts and styles; nothing found is not_found', async () => {
    const site = {
      ...SITE,
      '/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>/szeroki</loc></url></urlset>' },
      '/szeroki': { body: page('Szeroki', 'ｆｉｋｃｙｊｎｙ＿ｋａｃｐｅｒ') },
    };
    const http = fakeSite(site);
    const provider = createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(http, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    const ctx = runContext(http);
    expect((await provider.run(exact('fikcyjny_kacper'), ctx)).results.map((r) => r.snippet)).toEqual([
      'Szeroki fikcyjny_kacper',
    ]);
    const texts = ['var nick', 'fikcyjny', 'kacper fikcyjny'];
    const none = await Promise.all(texts.map((text) => provider.run(exact(text), ctx)));
    expect(none.map((r, i) => [texts[i], r.status, r.results])).toEqual(texts.map((t) => [t, 'not_found', []]));
  });

  it('orders equal counts by URL and caps the list at maxResults', async () => {
    const site = {
      '/sitemap.xml': {
        type: 'application/xml',
        body: '<urlset><url><loc>/z</loc></url><url><loc>/m</loc></url><url><loc>/a</loc></url></urlset>',
      },
      '/z': { body: page('Z', 'fikcyjny_kacper') },
      '/m': { body: page('M', 'fikcyjny_kacper') },
      '/a': { body: page('A', 'fikcyjny_kacper') },
    };
    const http = fakeSite(site);
    const provider = createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(http, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    const result = await provider.run({ ...exact('fikcyjny_kacper'), maxResults: 2 }, runContext(http));
    expect(result.results.map((r) => [r.rank, new URL(r.url).pathname])).toEqual([
      [1, '/a'],
      [2, '/m'],
    ]);
  });

  it('reports an unreadable sitemap as an error and a page that failed as a partial index', async () => {
    const broken = fakeSite({ '/sitemap.xml': { status: 500, body: 'boom' } });
    const provider = createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(broken, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    const failed = await provider.run(exact('fikcyjny_kacper'), runContext(broken));
    expect([failed.status, failed.results]).toEqual(['error', []]);
    expect(failed.notes.join()).toContain('search_provider_error: sitemap');

    const partialSite = { ...SITE, '/b/inne': { status: 503, body: 'unavailable' } };
    const http = fakeSite(partialSite);
    const partial = await createMockSearchProvider({
      baseUrl: BASE,
      robots: new RobotsCache(http, USER_AGENT),
      redactor: TEST_REDACTOR,
    }).run(exact('fikcyjny_kacper'), runContext(http));
    expect(partial.status).toBe('partial');
    expect(partial.results).toHaveLength(2);
    // The core port refuses to turn a failed search into "no results".
    await expect(
      createMockSearchProvider({
        baseUrl: BASE,
        robots: new RobotsCache(broken, USER_AGENT),
        redactor: TEST_REDACTOR,
      }).search(exact('fikcyjny_kacper'), runContext(broken, 'run-port')),
    ).rejects.toThrow(/search mock_search error/);
  });

  it('resolves relative locations under a base path and keeps malformed character references as written', async () => {
    expect(
      parseSitemap('<urlset><url><loc>a/b?x=1</loc></url></urlset>', 'http://h.test/base/sitemap.xml').urls,
    ).toEqual(['http://h.test/base/a/b?x=1']);
    expect(parseSitemap('<loc>/&#x41;b&#98;</loc>', 'http://h.test/sitemap.xml').urls).toEqual(['http://h.test/Abb']);
    // Not a Unicode scalar value: kept as written (no exception), so its `#` starts the fragment.
    expect(parseSitemap('<loc>/q?v=&#x110000;&#55296;</loc>', 'http://h.test/sitemap.xml').urls).toEqual([
      'http://h.test/q?v=&',
    ]);
    const site = {
      '/robots.txt': { type: 'text/plain', body: '' },
      '/base/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>strona</loc></url></urlset>' },
      '/base/strona': { body: page('Strona', 'fikcyjny_kacper') },
    };
    const http = fakeSite(site);
    const provider = createMockSearchProvider({
      baseUrl: `${BASE}/base/`,
      robots: new RobotsCache(http, USER_AGENT),
      redactor: TEST_REDACTOR,
    });
    const found = await provider.run(exact('fikcyjny_kacper'), runContext(http));
    expect(paths(http.requests)).toEqual(['/robots.txt', '/base/sitemap.xml', '/base/strona']);
    expect(found.results.map((r) => r.url)).toEqual([`${BASE}/base/strona`]);
  });

  it('parses locations: entities, CDATA, relative paths; other origins are counted, not kept', () => {
    const xml =
      '<urlset><url><loc> /a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[/b&c]]></loc></url>' +
      '<url><loc>/a?x=1&amp;y=2</loc></url><url><loc>https://example.org/x</loc></url><url><loc>mailto:a@example.org</loc></url></urlset>';
    expect(parseSitemap(xml, `${BASE}/sitemap.xml`)).toEqual({
      urls: [`${BASE}/a?x=1&y=2`, `${BASE}/b&c`],
      ignored: 2,
    });
  });
});

describe('mock search on the fixture site (v1 and v2)', () => {
  let registry: SourceRegistry;
  const servers: FixtureServer[] = [];
  beforeAll(async () => {
    registry = await demoRegistry();
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  async function search(variant: 'v1' | 'v2', value: string, kind: 'nickname' | 'full_name' | 'email') {
    const server = await startFixture(variant);
    servers.push(server);
    const scope = registry.resolveScope({ enabledSources: ['mock_search'], amberJustifications: {} }, 'offline');
    const test = createTestRun(scope, 'offline', `run-${variant}`);
    const deps: CollectorDeps = {
      mode: 'offline',
      config: await testConfig(server),
      robots: test.robots,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collector = createMockSearchCollector().create(registry.require('mock_search'), deps);
    const result = await collector.collect(
      { identifiers: [identifier(kind, value)], accounts: [], addresses: [], depth: 0 },
      test.ctx,
    );
    const urls = result.observations
      .filter((o) => o.property === 'search.result_url')
      .map((o) => [o.locator.split('#')[1], o.value.replace(server.url, '<fixture>')]);
    return { result, urls, test };
  }

  it('ranks the persona pages the same in both variants and never marks a request as disclosing', async () => {
    const v1 = await search('v1', 'fikcyjny_kacper', 'nickname');
    const v2 = await search('v2', 'fikcyjny_kacper', 'nickname');
    expect(v1.result.status).toBe('ok');
    expect(v1.urls).toEqual([
      ['rank=1', 'https://bitcointalk.org/index.php?action=profile;u=900001'],
      ['rank=2', 'https://wykop.pl/ludzie/fikcyjny_kacper/'],
      ['rank=3', 'https://bitcointalk.org/index.php?topic=5500001.0'],
      ['rank=4', 'https://bitcointalk.org/index.php?topic=5500002.0'],
      ['rank=5', 'https://bitcointalk.org/index.php?action=profile;u=900001;sa=showPosts'],
      ['rank=6', '<fixture>/tablica/ogloszenie/81000001/'],
      ['rank=7', 'https://t.me/s/olcys_test_ostrzezenia/'],
    ]);
    expect(v2.urls).toEqual(v1.urls);
    for (const { test } of [v1, v2]) {
      const mock = test.logs.filter((l) => l.sourceId === 'mock_search');
      expect(mock.length).toBeGreaterThan(5);
      expect(mock.every((l) => l.allowed && l.containsIdentifier === false)).toBe(true);
      expect(test.logs.some((l) => l.urlRedacted.includes('/private/'))).toBe(false);
    }
  });

  it('finds the classified ad for the full name and the e-mail address', async () => {
    const name = await search('v1', 'Kacper Fikcyjny', 'full_name');
    const email = await search('v1', 'kacper.fikcyjny@example.org', 'email');
    expect(name.urls).toEqual([['rank=1', '<fixture>/tablica/ogloszenie/81000001/']]);
    expect(email.urls).toEqual([['rank=1', '<fixture>/tablica/ogloszenie/81000001/']]);
  });

  it('is fixture-only: unsupported in live mode', async () => {
    const server = await startFixture('v1');
    servers.push(server);
    const deps: CollectorDeps = {
      mode: 'live',
      config: await testConfig(server, 'live'),
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collector = createMockSearchCollector().create(registry.require('mock_search'), deps);
    const input = { identifiers: [identifier('nickname', 'fikcyjny_kacper')], accounts: [], addresses: [], depth: 0 };
    expect(collector.supports(input)).toBe(false);
  });
});
