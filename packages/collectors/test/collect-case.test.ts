/**
 * End to end over the real egress client and robots.txt cache against the in-process fixture site (port 0):
 * the persona run, barriers, robots.txt, redirects, the HTTP-200 "member does not exist" page and the v2 profile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  collectCase,
  createSourceHttp,
  fetchPage,
  SourceCircuitBreaker,
  type CollectCaseResult,
  type CollectorConfig,
  type CollectorDeps,
  type SourceRegistry,
} from '../src/index.ts';
import {
  BTC_1,
  BTC_2,
  createTestRun,
  DEMO_SCOPE,
  demoRegistry,
  ETH_2,
  identifier,
  PERSONA_IDENTIFIERS,
  SIGNATURE,
  startFixture,
  testConfig,
  TEST_REDACTOR,
  type TestRun,
} from './helpers.ts';

let server: FixtureServer;
let registry: SourceRegistry;
let config: CollectorConfig;

beforeAll(async () => {
  server = await startFixture('v1');
  registry = await demoRegistry();
  config = await testConfig(server);
});
afterAll(async () => {
  await server.close();
});

async function run(identifiers = PERSONA_IDENTIFIERS(), maxPivotDepth = 2, cfg = config) {
  const scope = registry.resolveScope(DEMO_SCOPE, 'offline');
  const test = createTestRun(scope);
  const result = await collectCase({
    identifiers,
    scope,
    sources: registry,
    ctx: test.ctx,
    config: cfg,
    robots: test.robots,
    redactor: TEST_REDACTOR,
    maxPivotDepth,
  });
  return { result, test };
}

const facts = (r: CollectCaseResult) => r.observations.map((o) => [o.property, o.value, o.locator]);

const values = (result: CollectCaseResult, property: string, subject?: string) =>
  result.observations.filter((o) => o.property === property && (!subject || o.subject.key === subject));

describe('persona run (offline, fixture site)', () => {
  let result: CollectCaseResult;
  let test: TestRun;
  beforeAll(async () => {
    ({ result, test } = await run());
  });

  it('plans input, same-nick and watch-list tasks and reports every source', () => {
    expect(result.tasks.map((t) => [t.key, t.status, t.provenance.rule])).toEqual([
      ['bitcointalk|handle:bitcointalk:fikcyjny_kacper', 'ok', 'I1'],
      ['wykop|handle:wykop:fikcyjny_kacper', 'ok', 'I2'],
      ['github|handle:github:fikcyjny-kacper', 'ok', 'I2'],
      ['telegram_preview|handle:telegram:fikcyjny_kacper', 'not_found', 'I2'],
      [`fixture_site|url:${server.url}/tablica/ogloszenie/81000001/`, 'ok', 'I3'],
      ['telegram_preview|url:https://t.me/s/olcys_test_ostrzezenia/', 'ok', 'I3'],
    ]);
    // The forum link on the social profile points at the anchor already collected: no second visit.
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ key: 'bitcointalk|id:bitcointalk:900001', skip: 'duplicate', depth: 1 }),
    );
    expect(result.sources.map((s) => [s.sourceId, s.status])).toEqual([
      ['bitcointalk', 'ok'],
      ['wykop', 'ok'],
      ['github', 'ok'],
      ['telegram_preview', 'ok'],
      ['fixture_site', 'ok'],
    ]);
    expect(result.partial).toBe(false);
  });

  it('captures pages through the egress client with robots.txt checked first', () => {
    expect(result.captures).toHaveLength(11);
    const requested = test.logs.map((l) => new URL(l.urlRedacted).pathname + new URL(l.urlRedacted).search);
    expect(requested[0]).toBe('/robots.txt');
    expect(requested.filter((p) => p === '/robots.txt')).toHaveLength(1);
    expect(requested).toContain('/bitcointalk/index.php?action=profile;user=fikcyjny_kacper');
    expect(requested).toContain('/bitcointalk/index.php?topic=5500002.msg65000101');
    expect(test.logs.every((l) => l.allowed && l.host === '127.0.0.1')).toBe(true);
    const profile = result.captures[0];
    expect(profile).toMatchObject({
      sourceId: 'bitcointalk',
      status: 'ok',
      httpStatus: 200,
      collector: 'test-analyst',
      technical: { logicalUrl: 'https://bitcointalk.org/index.php?action=profile;user=fikcyjny_kacper' },
    });
    expect(profile?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // The html artifact is the egress client's stored body: its digest is the hash at collection.
    const envelope = test.envelopes.find((e) => e.fetchId === profile?.fetchIds[0]);
    expect(profile?.artifacts[0]).toEqual({ kind: 'html', blob: envelope?.body });
    expect(test.blobs.data.has(envelope?.body.sha256 ?? '')).toBe(true);
  });

  it('forum: anchor account, profile field, signed message on the account and post authors', () => {
    expect(result.accounts.find((a) => a.platform === 'bitcointalk')).toMatchObject({
      handle: 'fikcyjny_kacper',
      platformUserId: '900001',
      profileUrl: 'https://bitcointalk.org/index.php?action=profile;u=900001',
      discoveredVia: { sourceId: 'bitcointalk', method: 'input' },
    });
    expect(values(result, 'profile.bitcoin_address')).toEqual([
      expect.objectContaining({ value: BTC_1, locator: 'bitcointalk:u=900001#profile.bitcoin_address' }),
    ]);
    expect(values(result, 'profile.date_registered')[0]?.value).toBe('2019-03-14T20:12:45.000Z');
    const signed = values(result, 'post.signed_message.signature');
    expect(signed.length).toBe(2); // Show Posts and the topic page
    for (const o of signed) {
      expect(o).toMatchObject({
        subject: { type: 'account', key: 'bitcointalk:900001' },
        locator: 'bitcointalk:msg=65000001#signed_message[0]',
        value: SIGNATURE,
      });
    }
    expect(values(result, 'post.signed_message.address')[0]?.value).toBe(BTC_1);
    expect(values(result, 'post.author', 'bitcointalk:msg=65000102')[0]?.value).toBe('bitcointalk:900003');
    expect(values(result, 'post.author', 'bitcointalk:msg=65000101').map((o) => o.value)).toEqual([
      'bitcointalk:900001',
      'bitcointalk:900001',
    ]);
    expect(values(result, 'post.published_at', 'bitcointalk:msg=65000101')[0]?.value).toBe('2026-11-04T21:12:00.000Z');
  });

  it('social profile links to the forum profile in the same URL form as the anchor', () => {
    const anchor = result.accounts.find((a) => a.platform === 'bitcointalk');
    expect(values(result, 'account.link', 'wykop:fikcyjny_kacper')).toEqual([
      expect.objectContaining({ value: anchor?.profileUrl, locator: 'wykop:fikcyjny_kacper#account.link[0]' }),
    ]);
    expect(values(result, 'post.author', 'wykop:71000001')[0]?.value).toBe('wykop:fikcyjny_kacper');
  });

  it('code hosting: same-nick account and the Drips claim from FUNDING.json', () => {
    expect(result.accounts.find((a) => a.platform === 'github')).toMatchObject({
      handle: 'fikcyjny-kacper',
      discoveredVia: { method: 'enumeration' },
    });
    expect(values(result, 'claim.drips.ethereum_address')).toEqual([
      expect.objectContaining({
        subject: { type: 'account', key: 'github:fikcyjny-kacper' },
        value: ETH_2,
        locator: 'github:fikcyjny-kacper/gas-tracker-cli#claim.drips.ethereum_address',
      }),
    ]);
    const funding = result.captures.find((c) => c.url.endsWith('FUNDING.json'));
    expect(funding?.artifacts[0]?.kind).toBe('json');
  });

  it('P2P ad kept because seller e-mail, name and login match the case', () => {
    expect(result.accounts.find((a) => a.platform === 'tablica')).toMatchObject({
      handle: 'fikcyjny_kacper',
      displayName: 'Kacper Fikcyjny',
      discoveredVia: { sourceId: 'fixture_site', method: 'search' },
    });
    expect(values(result, 'profile.email', 'tablica:fikcyjny_kacper')[0]?.value).toBe('kacper.fikcyjny@example.org');
    expect(values(result, 'profile.name', 'tablica:fikcyjny_kacper')[0]?.value).toBe('Kacper Fikcyjny');
    expect(values(result, 'computed.identifier_match', 'tablica:fikcyjny_kacper').map((o) => o.value)).toEqual([
      'email',
      'full_name',
      'nickname',
    ]);
    expect(values(result, 'post.author', 'tablica:ad=81000001')[0]?.value).toBe('tablica:fikcyjny_kacper');
  });

  it('warning channel: third-party posts with their author; the channel is never pivoted on', () => {
    expect(values(result, 'post.author', 'telegram:olcys_test_ostrzezenia/101')[0]?.value).toBe(
      'telegram:olcys_test_ostrzezenia',
    );
    expect(values(result, 'computed.identifier_match', 'telegram:olcys_test_ostrzezenia/101')[0]?.value).toBe(
      'nickname',
    );
    expect(result.tasks.some((t) => t.key.includes('olcys_test_ostrzezenia') && t.depth > 0)).toBe(false);
    expect(result.skipped.some((s) => s.subjectKey.includes('olcys_test_ostrzezenia'))).toBe(false);
  });

  it('re-parsing gives identical facts (deterministic parsers)', async () => {
    const again = await run();
    expect(facts(again.result)).toEqual(facts(result));
  });
});

describe('pivots', () => {
  it('from an e-mail only: the P2P ad gives the login, which leads to the other platforms', async () => {
    const { result } = await run([identifier('email', 'kacper.fikcyjny@example.org')]);
    expect(result.tasks[0]?.key).toBe(`fixture_site|url:${server.url}/tablica/ogloszenie/81000001/`);
    expect(result.tasks.filter((t) => t.depth === 1).map((t) => t.key)).toEqual([
      'bitcointalk|handle:bitcointalk:fikcyjny_kacper',
      'wykop|handle:wykop:fikcyjny_kacper',
      'github|handle:github:fikcyjny-kacper',
      'telegram_preview|handle:telegram:fikcyjny_kacper',
    ]);
    expect(result.accounts.find((a) => a.platform === 'bitcointalk')?.discoveredVia.method).toBe('enumeration');
  });

  it('respects the maximum depth', async () => {
    const { result } = await run([identifier('email', 'kacper.fikcyjny@example.org')], 0);
    expect(result.tasks.every((t) => t.depth === 0)).toBe(true);
    expect(result.skipped.some((s) => s.skip === 'depth_exceeded')).toBe(true);
  });

  it('a nick that does not exist on the forum: HTTP-200 error page → not_found, no facts', async () => {
    const { result } = await run([identifier('nickname', 'nikt_taki_test', { platform: 'bitcointalk' })], 0);
    const forum = result.tasks.find((t) => t.sourceId === 'bitcointalk');
    expect(forum?.status).toBe('not_found');
    expect(result.captures.find((c) => c.sourceId === 'bitcointalk')?.status).toBe('not_found');
    expect(result.observations.filter((o) => o.sourceId === 'bitcointalk')).toHaveLength(0);
  });

  it('v2 of the profile shows the swapped address at the same locator', async () => {
    const v2 = await startFixture('v2');
    try {
      const { result } = await run(PERSONA_IDENTIFIERS(), 0, await testConfig(v2));
      expect(values(result, 'profile.bitcoin_address')).toEqual([
        expect.objectContaining({ value: BTC_2, locator: 'bitcointalk:u=900001#profile.bitcoin_address' }),
      ]);
    } finally {
      await v2.close();
    }
  });
});

async function page(path: string) {
  const scope = registry.resolveScope(DEMO_SCOPE, 'offline');
  const test = createTestRun(scope);
  const deps: CollectorDeps = {
    mode: 'offline',
    config,
    robots: test.robots,
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const http = createSourceHttp({
    descriptor: registry.require('bitcointalk'),
    ctx: test.ctx,
    deps,
    input: { identifiers: [], accounts: [], addresses: [], depth: 0 },
  });
  const first = await fetchPage(http, { url: `${server.url}${path}`, purpose: 'test', containsIdentifier: false });
  const before = test.logs.length;
  const second = await fetchPage(http, { url: `${server.url}/`, purpose: 'test', containsIdentifier: false });
  return { first, second, extraRequests: test.logs.length - before, logs: test.logs };
}

describe('barriers, robots.txt and redirects (no evasion)', () => {
  it.each([
    ['/barriers/captcha', 'captcha', 'barrier_captcha'],
    ['/barriers/challenge', 'captcha', 'barrier_captcha'],
    ['/barriers/login', 'login_wall', 'barrier_login_wall'],
    ['/barriers/forbidden', 'blocked', 'barrier_blocked'],
    ['/barriers/rate-limited', 'blocked', 'rate_limited'],
  ])('%s → %s; the block page is kept and the source stops for the run', async (path, status, code) => {
    const { first, second, extraRequests } = await page(path);
    expect(first.status).toBe(status);
    expect(first.capture?.status).toBe(status);
    expect(first.capture?.artifacts.map((a) => a.kind)).toEqual(['html', 'headers']);
    expect(first.notes.some((n) => n.startsWith(`${code}:`))).toBe(true);
    expect(second.status).toBe(status);
    expect(second.notes[0]).toMatch(/^source_stopped:/);
    expect(extraRequests).toBe(0);
  });

  it('robots.txt: /private/ is never requested, also not via a redirect', async () => {
    const direct = await page('/private/');
    expect(direct.first).toMatchObject({ status: 'blocked' });
    expect(direct.first.notes[0]).toMatch(/^robots_disallowed:/);
    expect(direct.logs.some((l) => l.urlRedacted.includes('/private'))).toBe(false);
    const redirected = await page('/barriers/redirect-private');
    expect(redirected.first.status).toBe('blocked');
    expect(redirected.first.notes[0]).toMatch(/^robots_disallowed:/);
    expect(redirected.logs.some((l) => l.urlRedacted.includes('/private'))).toBe(false);
  });

  it('a redirect to a host outside the allow-list is refused, and the source is not stopped', async () => {
    const { first, second, logs } = await page('/barriers/redirect-external');
    expect(first.status).toBe('blocked');
    expect(first.notes[0]).toMatch(/^allow_list_denied:/);
    expect(logs.some((l) => l.host === 'example.org')).toBe(false);
    expect(second.status).toBe('ok');
  });
});
