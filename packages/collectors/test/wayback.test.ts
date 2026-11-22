/**
 * Wayback history adapter against synthetic Availability / CDX / snapshot answers (a fake `fetch` behind the real egress
 * client, live mode): request URLs, selection, digest check, circuit breaker, sequential GET-only access, the Save Page
 * Now guard, the history join and the planner rule. Nothing touches the network.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CollectorInput, CollectorResult, OnlineAccount } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  assertNotSavePageNow,
  assertWaybackReadUrl,
  buildWaybackHistory,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createWaybackCollector,
  parseCdxJson,
  planExpansion,
  rawSnapshotUrl,
  runCollector,
  selectSnapshots,
  sha1Base32,
  SourceCircuitBreaker,
  taskKey,
  waybackTimestampToIso,
  type CdxEntry,
  type CollectorDeps,
  type PlannedTask,
  type PlannerContext,
  type SourceRegistry,
} from '../src/index.ts';
import { createTestRun, demoRegistry, startFixture, testConfig, TEST_REDACTOR } from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'wayback');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const PROFILE_URL = 'https://forum.example.org/profile/fikcyjny_kacper';
/** The archive's capture endpoint word, assembled so this file spells no such URL either. */
const WORD = ['sa', 've'].join('');
const NOW = new Date('2026-11-22T08:00:00Z');
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const TIMESTAMPS = ['20250102030405', '20250601000000', '20250801000000', '20251001000000', '20260102030405'];

let registry: SourceRegistry;
let v1: string;
let v2: string;
beforeAll(async () => {
  registry = await demoRegistry();
  [v1, v2] = await Promise.all([fixture('snapshot-v1.html'), fixture('snapshot-v2.html')]);
});

const digestOf = (text: string) => sha1Base32(new TextEncoder().encode(text));

const row = (timestamp: string, digest: string) => [timestamp, PROFILE_URL, '200', digest, '1000', 'text/html'];

/** Five CDX rows over the two snapshot files (the others carry made-up digests), as the API answers them. */
function cdxBody(options: { trailer?: string; firstDigest?: string } = {}): string {
  const rows = [
    row(TIMESTAMPS[0] as string, options.firstDigest ?? digestOf(v1)),
    row(TIMESTAMPS[1] as string, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    row(TIMESTAMPS[2] as string, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
    row(TIMESTAMPS[3] as string, 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'),
    row(TIMESTAMPS[4] as string, digestOf(v2)),
  ];
  const trailer = options.trailer ? [[], [options.trailer]] : [];
  return JSON.stringify([['timestamp', 'original', 'statuscode', 'digest', 'length', 'mimetype'], ...rows, ...trailer]);
}

type Answer = { status: number; body?: string; headers?: Record<string, string> };

function setup(answer: (url: string, index: number) => Answer | Promise<Answer>) {
  const sent: { url: string; method: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? 'GET' });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const { status, body, headers } = await answer(url, sent.length);
      return new Response(body ?? '', { status, headers: { ...JSON_TYPE, ...headers } });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  const scope = registry.resolveScope({ enabledSources: ['wayback_cdx'], amberJustifications: {} }, 'live');
  const test = createTestRun(scope, 'live', 'run-wayback', { fetchImpl });
  const ctx = { ...test.ctx, clock: { now: () => NOW } };
  const deps: CollectorDeps = {
    mode: 'live',
    config: createCollectorConfig({ mode: 'live', env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const run = (
    options: Parameters<typeof createWaybackCollector>[0] = {},
    input: CollectorInput = urlInput(),
  ): Promise<CollectorResult> => {
    const factory = createWaybackCollector(options);
    return runCollector(factory.create(registry.require('wayback_cdx'), deps), input, ctx, scope, deps);
  };
  return { sent, run, test, deps, scope, maxInFlight: () => maxInFlight };
}

const urlInput = (url = PROFILE_URL): CollectorInput => ({
  identifiers: [],
  accounts: [],
  addresses: [],
  depth: 0,
  values: [{ kind: 'url', value: url, method: 'cross_link' }],
});

/** Happy-path answers: availability, one CDX page, the two snapshot files by timestamp. */
async function happy(url: string): Promise<Answer> {
  if (url.startsWith('https://archive.org/wayback/available'))
    return { status: 200, body: await fixture('availability.json') };
  if (url.startsWith('https://web.archive.org/cdx/search/cdx')) return { status: 200, body: cdxBody() };
  if (url.includes(`${TIMESTAMPS[0]}id_/`)) return { status: 200, body: v1, headers: { 'content-type': 'text/html' } };
  if (url.includes(`${TIMESTAMPS[4]}id_/`)) return { status: 200, body: v2, headers: { 'content-type': 'text/html' } };
  return { status: 404 };
}

describe('pure helpers', () => {
  it('parses a CDX answer with a resume key (AC1)', () => {
    const body = JSON.parse(cdxBody({ trailer: 'RESUMEKEY' })) as unknown;
    const parsed = parseCdxJson(body);
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.resumeKey).toBe('RESUMEKEY');
    expect(parsed.entries[0]).toMatchObject({ timestamp: TIMESTAMPS[0], original: PROFILE_URL, statuscode: '200' });
    expect(parseCdxJson(JSON.parse(cdxBody()) as unknown).resumeKey).toBeUndefined();
    expect(parseCdxJson([]).entries).toEqual([]);
    expect(() => parseCdxJson({ not: 'an array' })).toThrow(/not a JSON array/);
    expect(() => parseCdxJson([['timestamp']])).toThrow(/lacks fields/);
  });

  it('selects the first, the last and evenly spaced snapshots, deterministically (AC3)', () => {
    const entries: CdxEntry[] = Array.from({ length: 30 }, (_u, i) => ({
      timestamp: `2024${String(i + 1).padStart(2, '0')}01000000`,
      original: PROFILE_URL,
      statuscode: '200',
      digest: `D${i}`,
      length: '1',
      mimetype: 'text/html',
    }));
    const picked = selectSnapshots(entries, 12);
    expect(picked).toHaveLength(12);
    expect(picked[0]).toBe(entries[0]);
    expect(picked.at(-1)).toBe(entries.at(-1));
    expect(picked.map((e) => e.timestamp)).toEqual(picked.map((e) => e.timestamp).toSorted());
    expect(selectSnapshots(entries, 12)).toEqual(picked);
    expect(selectSnapshots(entries.slice(0, 12), 12)).toEqual(entries.slice(0, 12));
    expect(selectSnapshots(entries, 1)).toEqual([entries.at(-1)]);
    expect(selectSnapshots(entries, 0)).toEqual([]);
  });

  it('converts timestamps and builds raw replay URLs (AC9)', () => {
    expect(waybackTimestampToIso('20240101123456')).toBe('2024-01-01T12:34:56.000Z');
    expect(() => waybackTimestampToIso('2024010112')).toThrow(/14-digit/);
    expect(() => waybackTimestampToIso('20241301123456')).toThrow(/not a valid/);
    expect(rawSnapshotUrl('20240101123456', PROFILE_URL)).toBe(
      `https://web.archive.org/web/20240101123456id_/${PROFILE_URL}`,
    );
  });

  it('computes the CDX digest format (SHA-1, base32, no padding)', () => {
    expect(sha1Base32(new TextEncoder().encode('abc'))).toBe('VGMT4NSHA2AWVOR6EVYXQUGCNSONBWE5');
    expect(digestOf(v1)).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('Save Page Now guard (AC8)', () => {
  it('refuses the capture-submission endpoints and every non-read path on archive hosts', () => {
    const spn = ['https://web.archive.org', 'save', 'https://example.org'].join('/');
    expect(() => assertNotSavePageNow(spn)).toThrow(/never used/);
    expect(() => assertNotSavePageNow(spn.replace('https://web.', 'http://'))).toThrow(/never used/);
    expect(() => assertNotSavePageNow(['https://web.archive.org', 'SAVE'].join('/'))).toThrow(/never used/);
    expect(() => assertNotSavePageNow(['https://web.archive.org', '%73ave', 'x'].join('/'))).toThrow(/never used/);
    // A page whose own URL contains the word is fine: only the archive's endpoint matters.
    expect(() =>
      assertNotSavePageNow(`https://web.archive.org/web/2024id_/https://example.org/${WORD}/x`),
    ).not.toThrow();
    expect(() => assertNotSavePageNow(`https://example.org/${WORD}`)).not.toThrow();
    expect(() => assertWaybackReadUrl('https://web.archive.org/other')).toThrow(/only the CDX/);
    expect(() => assertWaybackReadUrl('https://web.archive.org/cdx/search/cdx?url=x')).not.toThrow();
    expect(() => assertWaybackReadUrl('https://archive.org/wayback/available?url=x')).not.toThrow();
  });

  it('keeps the endpoint path out of every source file of the adapter', async () => {
    const dir = join(import.meta.dirname, '..', 'src', 'wayback');
    for (const file of await readdir(dir)) {
      // oxlint-disable-next-line no-await-in-loop
      expect([file, (await readFile(join(dir, file), 'utf8')).includes(`/${WORD}`)]).toEqual([file, false]);
    }
  });

  it('keeps the register entry at 20 requests per minute', () => {
    expect(registry.require('wayback_cdx').rateLimit).toEqual({ requests: 20, perSeconds: 60 });
    expect(registry.require('wayback_cdx').compliance).toBe('GREEN');
  });
});

describe('collector', () => {
  it('sends the CDX query with the documented parameters in order (AC2)', async () => {
    const { run, sent } = setup(happy);
    await run();
    expect(sent[0]?.url).toBe(`https://archive.org/wayback/available?url=${encodeURIComponent(PROFILE_URL)}`);
    expect(sent[1]?.url).toBe(
      'https://web.archive.org/cdx/search/cdx?url=https%3A%2F%2Fforum.example.org%2Fprofile%2Ffikcyjny_kacper&output=json&fl=timestamp%2Coriginal%2Cstatuscode%2Cdigest%2Clength%2Cmimetype&filter=statuscode%3A200&collapse=digest&limit=500&showResumeKey=true',
    );
  });

  it('stores fetched snapshots as archived copies with a digest check (AC4)', async () => {
    const { run, sent, test, maxInFlight } = setup(happy);
    const result = await run({ maxSnapshotsPerUrl: 2 });
    expect(result.status).toBe('ok');
    // API requests only (the test's robots policy is a stub): availability, one CDX page, two snapshots; one at a time (AC7)
    expect(sent.map((s) => s.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(maxInFlight()).toBe(1);
    const snaps = result.captures.filter((c) => c.archive);
    expect(snaps.map((c) => c.archive?.snapshotTimestamp)).toEqual([TIMESTAMPS[0], TIMESTAMPS[4]]);
    for (const c of snaps) {
      expect(c.url).toMatch(new RegExp(`id_/${PROFILE_URL.replaceAll('/', '\\/')}$`));
      expect(c.archive).toMatchObject({ provider: 'wayback', originalUrl: PROFILE_URL });
      expect(c.collectedAt).toBe(test.envelopes.find((e) => e.fetchId === c.fetchIds[0])?.receivedAt);
      expect(c.collectedAt).not.toContain('2025');
      expect(c.artifacts.map((a) => a.kind).toSorted()).toEqual(['headers', 'html']);
    }
    const checks = result.observations.filter((o) => o.property === 'computed.archive_digest_check');
    expect(checks.map((o) => o.value)).toEqual(['match', 'match']);
    // Every request is subject-derived: logged as containing an identifier, with its purpose.
    expect(test.logs.map((l) => [l.purpose, l.containsIdentifier])).toEqual([
      ['wayback availability', true],
      ['wayback cdx listing', true],
      ['wayback snapshot', true],
      ['wayback snapshot', true],
    ]);
  });

  it('records a mismatch without failing the snapshot', async () => {
    const { run } = setup(async (url) =>
      url.startsWith('https://web.archive.org/cdx/')
        ? { status: 200, body: cdxBody({ firstDigest: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' }) }
        : happy(url),
    );
    const result = await run({ maxSnapshotsPerUrl: 2 });
    expect(result.status).toBe('ok');
    expect(
      result.observations.filter((o) => o.property === 'computed.archive_digest_check').map((o) => o.value),
    ).toEqual(['mismatch', 'match']);
  });

  it('reports not_found after one request when the archive holds nothing (AC5)', async () => {
    const { run, sent } = setup(async () => ({ status: 200, body: await fixture('availability-empty.json') }));
    const result = await run();
    expect(result.status).toBe('not_found');
    expect(sent).toHaveLength(1);
    expect(result.captures.every((c) => !c.archive)).toBe(true);
  });

  it('follows CDX resume keys up to the page limit', async () => {
    let cdxPages = 0;
    const { run, sent } = setup(async (url) => {
      if (url.startsWith('https://web.archive.org/cdx/')) {
        cdxPages += 1;
        return { status: 200, body: cdxBody({ trailer: `KEY${cdxPages}` }) };
      }
      return happy(url);
    });
    const result = await run({ maxSnapshotsPerUrl: 1, maxCdxPages: 2 });
    const cdx = sent.filter((s) => s.url.includes('/cdx/'));
    expect(cdx).toHaveLength(2);
    expect(cdx[1]?.url).toContain('&resumeKey=KEY1');
    expect(result.notes.some((n) => n.startsWith('truncated:'))).toBe(true);
  });

  it('opens a circuit on a 429 for the rest of the run (AC6)', async () => {
    const { run, sent } = setup(async (url, index) =>
      index === 3 ? { status: 429, headers: { 'retry-after': '3600' } } : happy(url),
    );
    const first = await run({ maxSnapshotsPerUrl: 2 });
    expect(sent).toHaveLength(3);
    expect(first.status).toBe('partial');
    expect(first.notes).toContain('rate_limited: wayback rate limited (circuit open)');
    const second = await run({}, urlInput('https://forum.example.org/profile/other'));
    expect(sent).toHaveLength(3);
    expect(second.status).toBe('blocked');
  });

  it('honours the archive host robots.txt for replay fetches (API requests counted only)', async () => {
    const { run, sent, deps } = setup(happy);
    const robotsChecked: string[] = [];
    deps.robots = {
      check: async (url) => {
        robotsChecked.push(url);
        return url.includes('/web/') ? { allowed: false, reason: 'Disallow: /web/' } : { allowed: true };
      },
    };
    const result = await run({ maxSnapshotsPerUrl: 2 });
    // Only the two API requests (availability, CDX) were sent: no snapshot request, and no circuit opened.
    expect(sent.map((s) => s.url.split('?')[0])).toEqual([
      'https://archive.org/wayback/available',
      'https://web.archive.org/cdx/search/cdx',
    ]);
    expect(robotsChecked).toHaveLength(2);
    expect(result.notes.filter((n) => n.startsWith('robots_disallowed:'))).toHaveLength(2);
    expect(result.captures.some((c) => c.archive)).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('does not look up the archive itself or non-http values', async () => {
    const { run, sent } = setup(happy);
    const factory = createWaybackCollector();
    const collector = factory.create(registry.require('wayback_cdx'), setup(happy).deps);
    expect(collector.supports(urlInput('https://web.archive.org/web/2024/https://example.org/'))).toBe(false);
    expect(collector.supports(urlInput('ftp://example.org/'))).toBe(false);
    expect(collector.supports(urlInput())).toBe(true);
    const result = await run({}, urlInput('https://web.archive.org/web/2024/https://example.org/'));
    expect(result.status).toBe('error');
    expect(sent).toHaveLength(0);
  });
});

describe('history for the timeline (AC9)', () => {
  it('joins the listing, the snapshot captures and the digest checks, ascending', async () => {
    const { run } = setup(happy);
    const result = await run({ maxSnapshotsPerUrl: 2 });
    const history = buildWaybackHistory(result.captures, result.observations);
    expect(history.map((h) => h.snapshotTimestamp)).toEqual(TIMESTAMPS);
    expect(history.map((h) => h.at)).toEqual(TIMESTAMPS.map(waybackTimestampToIso));
    expect(history.filter((h) => h.fetched).map((h) => h.snapshotTimestamp)).toEqual([TIMESTAMPS[0], TIMESTAMPS[4]]);
    const captureIds = new Map(
      result.captures.flatMap((c) => (c.archive ? [[c.archive.snapshotTimestamp, c.id]] : [])),
    );
    for (const entry of history.filter((h) => h.fetched))
      expect(entry.captureId).toBe(captureIds.get(entry.snapshotTimestamp));
    expect(history.filter((h) => !h.fetched).every((h) => h.digestCheck === 'not_checked' && !h.captureId)).toBe(true);
    expect(history.filter((h) => h.fetched).every((h) => h.digestCheck === 'match')).toBe(true);
  });
});

const accountOf = (method: OnlineAccount['discoveredVia']['method'], platform = 'bitcointalk'): OnlineAccount => ({
  id: `00000000-0000-7000-8000-00000000000${method.length}`,
  runId: '00000000-0000-7000-8000-000000000901',
  platform,
  handle: 'fikcyjny_kacper',
  profileUrl: 'https://bitcointalk.org/index.php?action=profile;u=900001',
  discoveredVia: { sourceId: 'bitcointalk', method },
});
const resultOf = (accounts: OnlineAccount[]): CollectorResult => ({
  status: 'ok',
  captures: [],
  accounts,
  observations: [],
  notes: [],
});

async function plannerContext(enabled: string[]): Promise<PlannerContext> {
  const scope = registry.resolveScope(
    {
      enabledSources: enabled,
      amberJustifications: Object.fromEntries(enabled.map((s) => [s, 'Sprawa testowa 2026/1: dane syntetyczne'])),
    },
    'offline',
  );
  const factories = createDefaultCollectorRegistry();
  const deps = setup(happy).deps;
  return {
    scope,
    factories: factories.list(),
    collectors: factories.forScope(scope, registry, deps),
    known: new Set(),
    maxPivotDepth: 2,
    maxTasks: 40,
    counter: { planned: 0 },
    watchList: [],
    fixture: deps.config.fixture,
  };
}

const parentTask = (): PlannedTask => ({
  key: taskKey('bitcointalk', 'handle:bitcointalk:fikcyjny_kacper'),
  sourceId: 'bitcointalk',
  platform: 'bitcointalk',
  subjectKey: 'handle:bitcointalk:fikcyjny_kacper',
  depth: 1,
  input: { identifiers: [], accounts: [], addresses: [], depth: 1 },
  provenance: { reason: 'input_identifier', rule: 'I1' },
});

describe('planner rule E6', () => {
  it('plans one archive lookup per own profile URL when the case enables the archive', async () => {
    const ctx = await plannerContext(['bitcointalk', 'wayback_cdx']);
    const task = parentTask();
    const plan = planExpansion(task, resultOf([accountOf('input'), accountOf('cross_link')]), ctx);
    const wayback = plan.tasks.filter((t) => t.sourceId === 'wayback_cdx');
    expect(wayback).toHaveLength(1);
    expect(wayback[0]).toMatchObject({
      key: taskKey('wayback_cdx', 'url:https://bitcointalk.org/index.php?action=profile;u=900001'),
      depth: task.depth,
      provenance: { reason: 'archive_history', rule: 'E6', parentTaskKey: task.key },
    });
    expect(wayback[0]?.input.values).toEqual([
      { kind: 'url', value: 'https://bitcointalk.org/index.php?action=profile;u=900001', method: 'cross_link' },
    ]);
  });

  it('never looks up third-party pages (same-nick probes) and stays silent when the archive is not enabled', async () => {
    const ctx = await plannerContext(['bitcointalk', 'wayback_cdx']);
    expect(
      planExpansion(parentTask(), resultOf([accountOf('enumeration')]), ctx).tasks.some(
        (t) => t.sourceId === 'wayback_cdx',
      ),
    ).toBe(false);
    const off = await plannerContext(['bitcointalk']);
    const plan = planExpansion(parentTask(), resultOf([accountOf('input')]), off);
    expect(plan.tasks.some((t) => t.sourceId === 'wayback_cdx')).toBe(false);
    expect(plan.skipped.some((t) => t.sourceId === 'wayback_cdx')).toBe(false);
  });
});

const watched = (url: string): PlannedTask => ({
  key: taskKey('fixture_site', `url:${url}`),
  sourceId: 'fixture_site',
  platform: 'tablica',
  subjectKey: `url:${url}`,
  depth: 0,
  input: { identifiers: [], accounts: [], addresses: [], depth: 0 },
  provenance: { reason: 'watch_list', rule: 'I3' },
});
const withFacts = (n: number): CollectorResult => ({
  status: 'ok',
  captures: [],
  accounts: [],
  notes: [],
  observations: Array.from({ length: n }, (_u, i) => ({
    id: `00000000-0000-7000-8000-00000000010${i}`,
    runId: '00000000-0000-7000-8000-000000000901',
    captureId: '00000000-0000-7000-8000-000000000201',
    sourceId: 'fixture_site',
    subject: { type: 'page' as const, key: 'x' },
    property: 'profile.link',
    value: 'v',
    locator: 'l',
    observedAt: '2026-11-22T08:00:00.000Z',
  })),
});

describe('planner rule E6 for watch-list pages', () => {
  it('looks up a matched watch-list page with a live URL, never a fixture-only page', async () => {
    const scope = registry.resolveScope({ enabledSources: ['wayback_cdx'], amberJustifications: {} }, 'offline');
    const reg = createDefaultCollectorRegistry({ mode: 'offline' });
    const deps = setup(happy).deps;
    const ctx = (): PlannerContext => ({
      scope,
      factories: reg.list(),
      collectors: reg.forScope(scope, registry, deps),
      known: new Set(),
      maxPivotDepth: 2,
      maxTasks: 40,
      counter: { planned: 0 },
      watchList: [],
      fixture: deps.config.fixture,
    });
    const live = 'https://example.org/page';
    const fixtureOnly = `${deps.config.fixture.baseUrl}/tablica/ogloszenie/81000001/`;
    expect(planExpansion(watched(live), withFacts(1), ctx()).tasks.map((t) => t.subjectKey)).toEqual([`url:${live}`]);
    expect(planExpansion(watched(live), withFacts(0), ctx()).tasks).toEqual([]);
    expect(planExpansion(watched(fixtureOnly), withFacts(1), ctx()).tasks).toEqual([]);
    // A warning channel is a third party's page about the subject: its factory never pivots on it.
    const channel = { ...watched(live), sourceId: 'telegram_preview', platform: 'telegram' };
    expect(planExpansion(channel, withFacts(1), ctx()).tasks).toEqual([]);
  });
});

describe('over the fixture site (offline)', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixture('v1');
  });
  afterAll(async () => {
    await server.close();
  });

  it('reads the synthetic archive of the persona profile and finds BTC-1 in the older snapshots', async () => {
    const scope = registry.resolveScope({ enabledSources: ['wayback_cdx'], amberJustifications: {} }, 'offline');
    const test = createTestRun(scope, 'offline', 'run-wayback-fixture');
    const config = await testConfig(server);
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: test.robots,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const profile = 'https://bitcointalk.org/index.php?action=profile;u=900001';
    const factory = createWaybackCollector();
    const result = await runCollector(
      factory.create(registry.require('wayback_cdx'), deps),
      urlInput(profile),
      test.ctx,
      scope,
      deps,
    );
    expect(result.status).toBe('ok');
    const history = buildWaybackHistory(result.captures, result.observations);
    expect(history.map((h) => h.snapshotTimestamp)).toEqual(['20240312101500', '20250102030405']);
    expect(history.map((h) => h.digestCheck)).toEqual(['match', 'match']);
    expect(
      result.captures.filter((c) => c.archive).every((c) => c.technical?.logicalUrl?.includes('web.archive.org')),
    ).toBe(true);
    // An unrelated page is unknown to the synthetic archive: one request, not found.
    const other = await runCollector(
      factory.create(registry.require('wayback_cdx'), deps),
      urlInput('https://wykop.pl/ludzie/fikcyjny_kacper/'),
      test.ctx,
      scope,
      deps,
    );
    expect(other.status).toBe('not_found');
  });

  it('is part of the default collector registry', async () => {
    expect(createDefaultCollectorRegistry().get('wayback_cdx')?.archiveHistory).toBe(true);
  });
});
