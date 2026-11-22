import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RunContext, SourceDescriptor } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createSourceHttp,
  DEFAULT_HOST_PREFIXES,
  DEFAULT_SOURCES_PATH,
  loadSourceRegistry,
  parseSourceRegistry,
  recogniseAccountUrl,
  rollupOutcomes,
  rollupStatus,
  runCollector,
  SourceCircuitBreaker,
  SourceConfigError,
  SourceRefusedError,
  SyntheticIdentifierError,
  toFixtureUrl,
  toLogicalUrl,
  type CollectorDeps,
  type FixtureMapping,
} from '../src/index.ts';
import { fakeEgress, identifier, MemoryBlobs, memoryLogger, TEST_REDACTOR } from './helpers.ts';

const FIXTURE: FixtureMapping = { baseUrl: 'http://127.0.0.1:4100', hostPrefixes: DEFAULT_HOST_PREFIXES };

const entry = (extra: string): string =>
  `version: t\nsources:\n  a:\n    name: A\n    kind: web\n    compliance: GREEN\n    complianceNote: n\n    namePl: A\n    complianceNotePl: n\n    tosUrl: null\n    enabledByDefault: false\n    requiresApiKey: false\n    sendsIdentifiersExternally: false\n    reliability: B\n${extra}`;

/** Problems of the `SourceConfigError` an invalid register throws (empty when it parses). */
function fail(yaml: string): readonly string[] {
  try {
    parseSourceRegistry(yaml);
    return [];
  } catch (error) {
    if (error instanceof SourceConfigError) return error.problems;
    throw error;
  }
}

describe('source register and scope lock', () => {
  it('loads config/sources.yaml: every entry, its hash, RED entries without a rate', async () => {
    const registry = await loadSourceRegistry();
    const text = await readFile(DEFAULT_SOURCES_PATH);
    expect(registry.version).toBe('sources.v1');
    expect(registry.configSha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(registry.list().length).toBeGreaterThan(30);
    for (const d of registry.list().filter((s) => s.compliance === 'RED')) expect(d.rateLimit.requests).toBe(0);
  });

  it('refuses RED, unjustified AMBER and unknown sources; offline adds the fixture site', async () => {
    const registry = await loadSourceRegistry();
    const live = registry.resolveScope(
      { enabledSources: ['x_twitter', 'bitlist', 'keybase', 'nope'], amberJustifications: { bitlist: 'archiwum' } },
      'live',
    );
    expect(live.enabled.map((d) => d.id)).toEqual(['keybase']);
    expect(live.refused).toEqual([
      { sourceId: 'x_twitter', reason: 'red' },
      { sourceId: 'bitlist', reason: 'amber_without_justification' },
      { sourceId: 'nope', reason: 'unknown_source' },
    ]);
    const offline = registry.resolveScope(
      { enabledSources: ['bitlist'], amberJustifications: { bitlist: 'Sprawa 2026/17: archiwum forum' } },
      'offline',
    );
    expect(offline.enabled.map((d) => d.id)).toEqual(['bitlist', 'fixture_site']);
    expect(offline.amberJustifications).toEqual({ bitlist: 'Sprawa 2026/17: archiwum forum' });
    // Offline every request hits the local fixture site: its rate limit applies to every source.
    expect(offline.egressSources.map((d) => d.rateLimit)).toEqual([
      { requests: 10, perSeconds: 1 },
      { requests: 10, perSeconds: 1 },
    ]);
  });

  it('rejects an invalid register with the failing paths', () => {
    const ok = '    rateLimit: { requests: 1, perSeconds: 1 }\n    allowedHosts: [a.org]\n';
    expect(parseSourceRegistry(entry(ok)).list()).toHaveLength(1);
    expect(fail(`${entry(ok)}  a:\n    name: B\n`).join()).toMatch(/duplicate|unique/i);
    expect(fail(entry('    rateLimit: { requests: 1, perSeconds: 0 }\n    allowedHosts: []\n')).join()).toMatch(
      /sources\.a\.rateLimit\.perSeconds/,
    );
    expect(
      fail(entry('    rateLimit: { requests: 1, perSeconds: 1 }\n    allowedHosts: [https://x.org/path]\n')),
    ).toEqual([
      'sources.a.allowedHosts: "https://x.org/path" must be a lower-case host name without scheme, port or path',
    ]);
  });
});

describe('URL mapping and account recognition', () => {
  it('maps live URLs to the fixture site and back', () => {
    const live = 'https://bitcointalk.org/index.php?action=profile;u=900001';
    const fixture = toFixtureUrl(live, FIXTURE);
    expect(fixture).toBe('http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001');
    expect(toLogicalUrl(fixture, FIXTURE)).toBe(live);
    expect(toFixtureUrl('https://raw.githubusercontent.com/a/b/HEAD/FUNDING.json', FIXTURE)).toBe(
      'http://127.0.0.1:4100/github-raw/a/b/HEAD/FUNDING.json',
    );
    expect(toLogicalUrl('http://127.0.0.1:4100/github-raw/a/b/HEAD/FUNDING.json', FIXTURE)).toBe(
      'https://raw.githubusercontent.com/a/b/HEAD/FUNDING.json',
    );
    expect(toFixtureUrl('https://mempool.space/api/address/x', FIXTURE)).toBe(
      'http://127.0.0.1:4100/chain/esplora/api/address/x',
    );
    expect(() => toFixtureUrl('https://unmapped.example/x', FIXTURE)).toThrow(/no fixture mapping/);
    expect(toLogicalUrl('http://127.0.0.1:4100/tablica/ogloszenie/81000001/', FIXTURE)).toBe(
      'http://127.0.0.1:4100/tablica/ogloszenie/81000001/',
    );
  });

  it('recognises profile URLs of known platforms (fixture URLs included)', () => {
    expect(recogniseAccountUrl('http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001', FIXTURE)).toEqual(
      {
        platform: 'bitcointalk',
        platformUserId: '900001',
        logicalUrl: 'https://bitcointalk.org/index.php?action=profile;u=900001',
      },
    );
    expect(recogniseAccountUrl('https://wykop.pl/ludzie/fikcyjny_kacper/')?.handle).toBe('fikcyjny_kacper');
    expect(recogniseAccountUrl('https://github.com/fikcyjny-kacper')?.platform).toBe('github');
    expect(recogniseAccountUrl('https://github.com/settings')).toBeUndefined();
    expect(recogniseAccountUrl('https://t.me/s/olcys_test_ostrzezenia')?.handle).toBe('olcys_test_ostrzezenia');
    expect(recogniseAccountUrl('https://t.me/joinchat/AbCdEf')).toBeUndefined();
    expect(recogniseAccountUrl('https://x.com/fikcyjny_kacper')?.platform).toBe('x_twitter');
    expect(recogniseAccountUrl('https://example.org/')).toBeUndefined();
  });
});

describe('status roll-up', () => {
  it('per collector run', () => {
    expect(rollupStatus(['ok', 'ok'], false)).toBe('ok');
    expect(rollupStatus(['ok', 'captcha'], false)).toBe('partial');
    expect(rollupStatus(['blocked', 'not_found'], false)).toBe('blocked');
    expect(rollupStatus(['captcha', 'login_wall'], false)).toBe('captcha');
    expect(rollupStatus(['not_found'], false)).toBe('not_found');
    expect(rollupStatus([], false)).toBe('error');
    expect(rollupStatus([], true)).toBe('not_found');
    expect(rollupStatus(['error', 'not_found'], false)).toBe('error');
  });

  it('per source over tasks: a missing nick does not degrade a source that answered', () => {
    expect(rollupOutcomes(['ok', 'not_found'])).toBe('ok');
    expect(rollupOutcomes(['ok', 'captcha'])).toBe('partial');
    expect(rollupOutcomes(['not_found', 'blocked'])).toBe('blocked');
  });
});

describe('source HTTP guards', () => {
  const descriptor: SourceDescriptor = {
    id: 'bitcointalk',
    name: 'Bitcointalk',
    kind: 'forum',
    compliance: 'AMBER',
    complianceNote: 'test',
    namePl: 'Bitcointalk',
    complianceNotePl: 'test',
    tosUrl: null,
    enabledByDefault: false,
    requiresApiKey: false,
    sendsIdentifiersExternally: true,
    reliability: 'B',
    rateLimit: { requests: 1, perSeconds: 1 },
    allowedHosts: ['bitcointalk.org'],
  };
  const setup = (mode: 'live' | 'offline') => {
    const egress = fakeEgress();
    const logger = memoryLogger();
    const ctx: RunContext = {
      runId: '00000000-0000-7000-8000-000000000903',
      caseId: '00000000-0000-7000-8000-000000000904',
      mode,
      http: egress,
      blobs: new MemoryBlobs(),
      clock: { now: () => new Date() },
      logger,
    };
    const deps: CollectorDeps = {
      mode,
      config: createCollectorConfig({
        mode,
        manifest: { hostPrefixes: {}, syntheticIdentifiers: ['fikcyjny_kacper', '900001'], pages: [] },
      }),
      robots: { check: async () => ({ allowed: true }) },
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const input = {
      identifiers: [identifier('nickname', 'fikcyjny_kacper', { platform: 'bitcointalk' })],
      accounts: [],
      addresses: [],
      depth: 0,
    };
    return { egress, logger, ctx, deps, http: createSourceHttp({ descriptor, ctx, deps, input }) };
  };

  it('never downgrades containsIdentifier and raises it for a case identifier in the URL', async () => {
    const { egress, logger, http } = setup('offline');
    await http.fetch({
      url: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;user=fikcyjny_kacper',
      purpose: 'test',
      containsIdentifier: false,
    });
    expect(egress.requests[0]).toMatchObject({
      containsIdentifier: true,
      sourceId: 'bitcointalk',
      runId: '00000000-0000-7000-8000-000000000903',
    });
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('live mode refuses synthetic persona identifiers before any request', async () => {
    const { egress, http } = setup('live');
    await expect(
      http.fetch({
        url: 'https://bitcointalk.org/index.php?action=profile;u=900001',
        purpose: 't',
        containsIdentifier: true,
      }),
    ).rejects.toBeInstanceOf(SyntheticIdentifierError);
    expect(egress.requests).toHaveLength(0);
  });

  it('runCollector refuses RED sources and sources outside the scope without a request', async () => {
    const { egress, ctx, deps } = setup('offline');
    const registry = await loadSourceRegistry();
    const scope = registry.resolveScope({ enabledSources: [], amberJustifications: {} }, 'offline');
    const factory = createDefaultCollectorRegistry().get('bitcointalk');
    if (!factory) throw new Error('missing factory');
    const input = { identifiers: [], accounts: [], addresses: [], depth: 0 };
    const red = factory.create({ ...descriptor, compliance: 'RED' }, deps);
    await expect(runCollector(red, input, ctx, scope, deps)).rejects.toMatchObject({ reason: 'red' });
    const outside = factory.create(descriptor, deps);
    await expect(runCollector(outside, input, ctx, scope, deps)).rejects.toBeInstanceOf(SourceRefusedError);
    expect(egress.requests).toHaveLength(0);
  });
});
