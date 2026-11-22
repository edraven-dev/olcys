/**
 * Maigret username enumeration client: the committed sample answer of osint-py (no service, no network) behind the real
 * egress client. Covers the response parser, captures and observations, the delegated request log, the refusals
 * (no merge hook, external access disabled), the byte-identical request body, the planner rule and the policy parity
 * with the register and the fixture mapping.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CollectorInput, CollectorResult, SecretRedactor } from '@olcys/core';
import { createSecretRedactor } from '../../address-extractor/src/index.ts';
import { gen } from '../../address-extractor/test/helpers.ts';
import { describe, expect, it } from 'vitest';
import {
  collectCase,
  createCollectorConfig,
  DEFAULT_HOST_PREFIXES,
  maigretCollectorFactory,
  maigretNick,
  maigretOptionsFromEnv,
  parseUsernameSearchResponse,
  planInitial,
  rollupUsernameSearch,
  runCollector,
  searchRequestBody,
  SourceCircuitBreaker,
  stripBodies,
  UsernameSearchResponseError,
  type CollectorDeps,
  type PlannerContext,
  type UsernameStatus,
} from '../src/index.ts';
import { createDefaultCollectorRegistry } from '../src/index.ts';
import { demoRegistry, fakeEgress, identifier, createTestRun, REPO, TEST_REDACTOR } from './helpers.ts';

const SAMPLE_PATH = resolve(REPO, 'services', 'osint-py', 'tests', 'data', 'usernames-search.sample.json');
const POLICY_PATH = resolve(REPO, 'services', 'osint-py', 'config', 'policy.json');
const JUSTIFICATION = 'Sprawa testowa 2026/1: enumeracja nicku persony syntetycznej';
const NICK = 'fikcyjny_kacper';

const sampleText = await readFile(SAMPLE_PATH, 'utf8');
const sample = JSON.parse(sampleText) as Record<string, unknown>;
const registry = await demoRegistry();

interface Sent {
  url: string;
  method: string;
  body: string;
}

/** Real egress client over a fake `fetch` standing in for osint-py. */
function setup(
  answer: (sent: Sent) => Response = () => new Response(sampleText, { status: 200 }),
  redactor: SecretRedactor = TEST_REDACTOR,
) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') };
    sent.push(call);
    return answer(call);
  }) as typeof fetch;
  const scope = registry.resolveScope(
    { enabledSources: ['maigret'], amberJustifications: { maigret: JUSTIFICATION } },
    'offline',
  );
  const test = createTestRun(scope, 'offline', 'run-maigret', { fetchImpl });
  const deps: CollectorDeps = {
    mode: 'offline',
    config: createCollectorConfig({ mode: 'offline', env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor,
    deniedHosts: ['wykop.pl', 'bitcointalk.org'],
  };
  const run = (input: CollectorInput = nickInput(), ctx = test.ctx): Promise<CollectorResult> => {
    const factory = maigretCollectorFactory({ baseUrl: 'http://127.0.0.1:8090', database: 'fixture' });
    return runCollector(factory.create(registry.require('maigret'), deps), input, ctx, scope, deps);
  };
  return { sent, test, run, deps, scope };
}

/** The sample's `results` or `requests` with `patch` applied to the first entry. */
function patched(key: 'results' | 'requests', patch: Record<string, unknown>): Record<string, unknown>[] {
  const rows = structuredClone(sample[key] as Record<string, unknown>[]);
  Object.assign(rows[0] as Record<string, unknown>, patch);
  return rows;
}

const nickInput = (value = NICK): CollectorInput => ({
  identifiers: [identifier('nickname', value, { isAnchor: true })],
  accounts: [],
  addresses: [],
  depth: 0,
});

describe('response parser', () => {
  it('parses the committed sample of osint-py', () => {
    const parsed = parseUsernameSearchResponse(sample);
    expect(parsed.schemaVersion).toBe('usernames-search.v1');
    expect(parsed.results.map((r) => [r.site, r.status])).toEqual([
      ['Archiwum', 'skipped'],
      ['GitHub', 'not_found'],
      ['Keybase', 'blocked'],
      ['Telegram', 'not_found'],
      ['Wykop', 'found'],
    ]);
    expect(parsed.requests).toHaveLength(6);
    expect(parsed.requests.every((r) => r.method === 'GET')).toBe(true);
    // robots.txt requests carry no identifier; every other request does.
    expect(parsed.requests.every((r) => r.containsIdentifier === (r.purpose !== 'robots.txt'))).toBe(true);
    expect(stripBodies(parsed).requests.every((r) => r.bodyBase64 === null)).toBe(true);
  });

  it('refuses answers of another shape', () => {
    expect(() => parseUsernameSearchResponse({ ...sample, schemaVersion: 'usernames-search.v2' })).toThrow(
      UsernameSearchResponseError,
    );
    expect(() => parseUsernameSearchResponse([])).toThrow(/not an object/);
    expect(() =>
      parseUsernameSearchResponse({ ...sample, results: patched('results', { status: 'not_sure' }) }),
    ).toThrow(/unknown status/);
    expect(() => parseUsernameSearchResponse({ ...sample, requests: patched('requests', { method: 'POST' }) })).toThrow(
      /not GET/,
    );
  });
});

describe('collector on the sample (offline)', () => {
  it('turns hits into candidate accounts, barrier pages into captures and the rest into notes (AC6)', async () => {
    const { run, sent } = setup();
    const result = await run();
    expect(result.status).toBe('partial');
    expect(sent).toHaveLength(1);
    // 1 report + 1 `ok` profile + 1 `blocked` barrier page.
    expect(result.captures.map((c) => c.status).toSorted()).toEqual(['blocked', 'ok', 'ok']);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      platform: 'wykop',
      handle: NICK,
      profileUrl: 'https://wykop.pl/ludzie/fikcyjny_kacper',
      discoveredVia: { sourceId: 'maigret', method: 'enumeration' },
    });
    const status = result.observations.filter((o) => o.property === 'enumeration.status');
    expect(status.map((o) => [o.subject.key, o.value]).toSorted()).toEqual([
      ['archiwum:fikcyjny_kacper', 'skipped'],
      ['github:fikcyjny_kacper', 'not_found'],
      ['keybase:fikcyjny_kacper', 'blocked'],
      ['telegram:fikcyjny_kacper', 'not_found'],
      ['wykop:fikcyjny_kacper', 'found'],
    ]);
    expect(result.notes.some((n) => n.startsWith('barrier_blocked: Keybase'))).toBe(true);
    expect(result.notes.some((n) => n.startsWith('not_found: 2 site(s)'))).toBe(true);
  });

  it('keeps the page bodies out of the report and in their own captures', async () => {
    const { run, test } = setup();
    const result = await run();
    const report = result.captures.find((c) => c.artifacts.some((a) => a.kind === 'json'));
    expect(report).toBeDefined();
    const json = report?.artifacts.find((a) => a.kind === 'json');
    const stored = JSON.parse(new TextDecoder().decode(await test.blobs.get(json?.blob.sha256 as string))) as {
      requests: { bodyBase64: string | null }[];
    };
    expect(stored.requests.every((r) => r.bodyBase64 === null)).toBe(true);
    const pages = result.captures.filter((c) => c !== report);
    expect(pages).toHaveLength(2);
    expect(pages.every((c) => c.artifacts.some((a) => a.kind === 'html'))).toBe(true);
  });

  it('merges the service request log into the egress log, once per request (AC7)', async () => {
    const { run, test } = setup();
    await run();
    const delegated = test.logs.filter((l) => l.delegate === 'osint-py');
    expect(delegated).toHaveLength(6);
    expect(delegated.every((l) => l.sourceId === 'maigret' && l.method === 'GET')).toBe(true);
    expect(delegated.filter((l) => !l.containsIdentifier)).toHaveLength(1);
    expect(new Set(delegated.map((l) => l.host))).toEqual(new Set(['fixture-site']));
    // The call to the service itself is an ordinary egress row.
    expect(test.logs.filter((l) => !l.delegate)).toHaveLength(1);
    const withBody = test.envelopes.filter((e) => e.delegatedVia);
    expect(withBody).toHaveLength(2);
    expect(withBody.every((e) => e.delegatedVia?.delegate === 'osint-py')).toBe(true);
    const via = test.envelopes.find((e) => !e.delegatedVia && e.url.endsWith('/v1/usernames/search'));
    expect(withBody.every((e) => e.delegatedVia?.fetchId === via?.fetchId)).toBe(true);
  });

  it('records denials of the service as not allowed', async () => {
    const requests = patched('requests', {
      allowed: false,
      denyReason: 'no fixture mapping for host x',
      httpStatus: null,
      receivedAt: null,
    });
    const { run, test } = setup(() => new Response(JSON.stringify({ ...sample, requests }), { status: 200 }));
    await run();
    const denied = test.logs.filter((l) => l.delegate === 'osint-py' && !l.allowed);
    expect(denied.map((l) => l.denyReason)).toContain('no fixture mapping for host x');
    expect(denied.map((l) => l.denyReason)).toContain('robots_disallowed');
  });

  it('sends a canonical body that is byte-identical across runs and carries the run id only in a header', async () => {
    const first = setup();
    await first.run();
    const second = setup();
    await second.run();
    expect(first.sent[0]?.body).toBe(second.sent[0]?.body);
    expect(first.sent[0]?.body).toBe(
      `{"database":"fixture","deniedHostSuffixes":["bitcointalk.org","wykop.pl"],"tags":["coding","crypto","finance","messaging","pl","social"],"timeoutSeconds":10,"username":"${NICK}"}`,
    );
    expect(first.sent[0]?.url).toBe('http://127.0.0.1:8090/v1/usernames/search');
    expect(first.sent[0]?.method).toBe('POST');
  });

  it('sends nothing when the egress client cannot merge the service log (AC7)', async () => {
    const egress = fakeEgress();
    const { run, test } = setup();
    const result = await run(nickInput(), { ...test.ctx, http: egress });
    expect(result.status).toBe('error');
    expect(result.notes.some((n) => n.startsWith('delegated_log_unavailable'))).toBe(true);
    expect(result.captures).toEqual([]);
    expect(egress.requests).toHaveLength(0);
  });

  it('reports a disabled external access and a database mismatch as such (never as "not found")', async () => {
    const answers = ['external_disabled', 'db_hash_mismatch'].map(async (code) => {
      const { run } = setup(() => new Response(JSON.stringify({ code, message: 'x' }), { status: 409 }));
      return { code, result: await run() };
    });
    for (const { code, result } of await Promise.all(answers)) {
      expect(result.status).toBe('error');
      expect(result.notes.some((n) => n.startsWith(`${code}:`))).toBe(true);
      expect(result.accounts).toEqual([]);
    }
  });

  it('reports an unreachable service and an unreadable answer as errors', async () => {
    const down = setup(() => {
      throw new TypeError('fetch failed');
    });
    const failed = await down.run();
    expect(failed.status).toBe('error');
    expect(failed.notes.some((n) => n.startsWith('fetch_error'))).toBe(true);
    const garbled = setup(() => new Response('{"schemaVersion":"usernames-search.v1"}', { status: 200 }));
    const unreadable = await garbled.run();
    expect(unreadable.status).toBe('error');
    expect(unreadable.notes.some((n) => n.startsWith('unrecognised_markup'))).toBe(true);
  });

  it('refuses the upstream database outside live mode and sends nothing', async () => {
    const { deps, test, sent } = setup();
    const factory = maigretCollectorFactory({ baseUrl: 'http://127.0.0.1:8090', database: 'upstream' });
    for (const mode of ['offline', 'replay'] as const) {
      // eslint-style: sequential, each mode is an independent collector
      // oxlint-disable-next-line no-await-in-loop
      const result = await factory
        .create(registry.require('maigret'), { ...deps, mode })
        .collect(nickInput(), test.ctx);
      expect(result.status).toBe('error');
      expect(result.notes.some((n) => n.startsWith('unsupported_input') && n.includes(mode))).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a synthetic persona name in live mode', async () => {
    const { run, deps, test } = setup();
    const config = createCollectorConfig({
      mode: 'live',
      env: {},
      overrides: { syntheticIdentifiers: [NICK] },
    });
    const live: CollectorDeps = { ...deps, mode: 'live', config };
    const factory = maigretCollectorFactory({ baseUrl: 'http://127.0.0.1:8090', database: 'upstream' });
    const collector = factory.create(registry.require('maigret'), live);
    const result = await collector.collect(nickInput(), test.ctx);
    expect(result.status).toBe('error');
    expect(result.notes.some((n) => n.startsWith('synthetic_identifier_refused'))).toBe(true);
    void run;
  });
});

describe('secrets and request details', () => {
  const wif = gen.wif('maigret-wif');
  const seed = gen.mnemonic12('maigret-seed');
  const page = `<html><body><p>klucz: ${wif}</p><p>seed: ${seed}</p></body></html>`;
  const leaking = (): Record<string, unknown> => {
    const requests = structuredClone(sample['requests'] as Record<string, unknown>[]);
    const wykop = requests.find((r) => r['site'] === 'Wykop') as Record<string, unknown>;
    wykop['bodyBase64'] = Buffer.from(page).toString('base64');
    const results = structuredClone(sample['results'] as Record<string, unknown>[]);
    (results.find((r) => r['site'] === 'Wykop') as Record<string, unknown>)['ids'] = { fullname: `x ${wif}` };
    return { ...sample, requests, results };
  };

  it('redacts a private key and a seed phrase everywhere and never stores the raw service body', async () => {
    const raw = JSON.stringify(leaking());
    const { run, test } = setup(() => new Response(raw, { status: 200 }), createSecretRedactor());
    const result = await run();
    const fragments = [wif, wif.slice(8, 30), ...seed.split(' ').slice(2, 6).join(' ').split(' ')];
    const stored = [...test.blobs.data.values()].map((b) => new TextDecoder().decode(b));
    // The wykop page is stored, with markers instead of the secrets.
    expect(stored.some((t) => t.includes('[REDACTED:'))).toBe(true);
    const everywhere = [
      ...stored,
      JSON.stringify(result),
      JSON.stringify(test.logs),
      JSON.stringify(test.envelopes),
    ].join('\n');
    expect(everywhere).not.toContain(wif);
    expect(everywhere).not.toContain(seed);
    for (const fragment of fragments.slice(0, 2)) expect(everywhere).not.toContain(fragment);
    // The raw answer (bodies as received) is neither in the blob store nor in provenance.
    const answer = test.envelopes.find((e) => e.url.endsWith('/v1/usernames/search'));
    expect(answer?.bodyPersisted).toBe(false);
    expect(test.blobs.data.has(answer?.body.sha256 as string)).toBe(false);
  });

  it('decodes a legacy charset before redacting, re-encodes as UTF-8 and records the redaction (Windows-1250)', async () => {
    // "Zażółć gęślą jaźń" in Windows-1250 plus an ASCII synthetic key.
    const polish = Buffer.from([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6, 0x20, 0x67, 0xea, 0x9c, 0x6c, 0xb9]);
    const body = Buffer.concat([
      Buffer.from('<html><body><p>'),
      polish,
      Buffer.from(` klucz: ${wif}</p></body></html>`),
    ]);
    const requests = structuredClone(sample['requests'] as Record<string, unknown>[]);
    const wykop = requests.find((r) => r['site'] === 'Wykop') as Record<string, unknown>;
    wykop['bodyBase64'] = body.toString('base64');
    wykop['responseHeaders'] = {
      ...(wykop['responseHeaders'] as object),
      'content-type': 'text/html; charset=windows-1250',
    };
    const answer = JSON.stringify({ ...sample, requests });
    const { run, test } = setup(() => new Response(answer, { status: 200 }), createSecretRedactor());
    const result = await run();
    const capture = result.captures.find((c) => c.url.includes('/wykop/'));
    const html = capture?.artifacts.find((a) => a.kind === 'html');
    const stored = new TextDecoder().decode(await test.blobs.get(html?.blob.sha256 as string));
    expect(stored).toContain('Zażółć gęślą');
    expect(stored).toContain('[REDACTED:');
    expect(stored).not.toContain(wif);
    expect(html?.blob.mediaType).toContain('charset=utf-8');
    const manifestJson = JSON.stringify(result.captures);
    expect(manifestJson).not.toContain(wif);
    const envelope = test.envelopes.find(
      (e) => e.delegatedVia && e.responseHeaders['content-type']?.includes('charset'),
    );
    expect(envelope?.responseHeaders['content-type']).toBe('text/html; charset=utf-8');
    // technical.redaction: count, kinds and the digest of the body as received; stored bytes described as redacted.
    const manifest = JSON.parse(new TextDecoder().decode(await test.blobs.get(capture?.manifestSha256 as string))) as {
      technical?: { redaction?: { secrets: number; kinds: string[]; originalSha256: string } };
      artifacts: { description: string }[];
      transformations: string[];
    };
    expect(manifest.technical?.redaction).toEqual({
      secrets: 1,
      kinds: ['wif'],
      originalSha256: wykop['bodySha256'],
    });
    expect(manifest.artifacts.some((a) => /redacted/.test(a.description))).toBe(true);
    expect(manifest.transformations.join(' ')).toMatch(/redacted in memory/);
  });

  it('records no redaction for a clean page and describes its bytes as received', async () => {
    const { run, test } = setup();
    const result = await run();
    const capture = result.captures.find((c) => c.url.includes('/wykop/'));
    const manifest = JSON.parse(new TextDecoder().decode(await test.blobs.get(capture?.manifestSha256 as string))) as {
      technical?: { redaction?: unknown };
      transformations: string[];
    };
    expect(manifest.technical?.redaction).toBeUndefined();
    expect(manifest.transformations.join(' ')).toContain('body stored as received');
  });

  it('does not start a page capture at robots.txt', async () => {
    const { run } = setup();
    const result = await run();
    const profile = result.captures.find((c) => c.status === 'ok' && c.url.includes('/wykop/'));
    expect(profile?.url).toBe('http://fixture-site:4100/wykop/ludzie/fikcyjny_kacper');
    expect(result.captures.every((c) => !c.url.endsWith('/robots.txt'))).toBe(true);
  });

  it('carries a request failure of the service into the egress log', async () => {
    const requests = patched('requests', { error: 'timeout', httpStatus: null, receivedAt: null, allowed: true });
    const { run, test } = setup(() => new Response(JSON.stringify({ ...sample, requests }), { status: 200 }));
    await run();
    expect(test.logs.filter((l) => l.delegate === 'osint-py' && l.error === 'timeout')).toHaveLength(1);
  });
});

describe('status roll-up', () => {
  const cases: [UsernameStatus[], string][] = [
    [['found', 'not_found'], 'ok'],
    [['found', 'blocked', 'not_found'], 'partial'],
    [['found', 'unknown'], 'partial'],
    [['not_found', 'not_found', 'illegal'], 'not_found'],
    [['blocked', 'captcha'], 'captcha'],
    [['blocked', 'login_wall'], 'login_wall'],
    [['blocked'], 'blocked'],
    [['blocked', 'not_found'], 'partial'],
    [['unknown', 'not_found'], 'partial'],
    [['unknown'], 'partial'],
    [[], 'error'],
  ];
  it.each(cases)('%j → %s', (statuses, expected) => {
    expect(rollupUsernameSearch(statuses)).toBe(expected);
  });
});

describe('nickname, request body and environment', () => {
  it('accepts nicknames and social logins the service accepts', () => {
    expect(maigretNick(nickInput('@olcys_test'))).toBe('olcys_test');
    expect(maigretNick(nickInput('has space'))).toBeUndefined();
    expect(maigretNick(nickInput('a/b'))).toBeUndefined();
    expect(
      maigretNick({ identifiers: [identifier('email', 'a@example.org')], accounts: [], addresses: [], depth: 0 }),
    ).toBeUndefined();
    expect(
      maigretNick({
        ...nickInput(),
        values: [{ kind: 'url', value: 'https://wykop.pl/ludzie/x', method: 'search' }],
      }),
    ).toBeUndefined();
  });

  it('builds the request body with sorted, deduplicated denied hosts', () => {
    const body = searchRequestBody('x_user', { database: 'upstream', tags: ['pl', 'crypto'] }, [
      'B.example',
      '*.a.example',
      'b.example',
    ]);
    expect(body).toEqual({
      username: 'x_user',
      database: 'upstream',
      deniedHostSuffixes: ['a.example', 'b.example'],
      tags: ['crypto', 'pl'],
      timeoutSeconds: 10,
    });
  });

  it('chooses the database from the mode, overridable by OSINT_PY_DATABASE', () => {
    expect(maigretOptionsFromEnv('offline', {})).toEqual({ baseUrl: 'http://127.0.0.1:8090', database: 'fixture' });
    expect(maigretOptionsFromEnv('replay', {}).database).toBe('fixture');
    expect(maigretOptionsFromEnv('live', { OSINT_PY_URL: 'http://osint-py:8000' })).toEqual({
      baseUrl: 'http://osint-py:8000',
      database: 'upstream',
    });
    expect(maigretOptionsFromEnv('live', { OSINT_PY_DATABASE: 'fixture' }).database).toBe('fixture');
    expect(maigretOptionsFromEnv('offline', { OSINT_PY_DATABASE: 'bogus' }).database).toBe('fixture');
  });
});

describe('pivot planner', () => {
  it('plans one enumeration task per nickname when the case enables the source, and none otherwise', () => {
    const registryOfCollectors = createDefaultCollectorRegistry({ mode: 'offline' });
    const plan = (enabled: string[]) => {
      const scope = registry.resolveScope(
        {
          enabledSources: enabled,
          amberJustifications: Object.fromEntries(enabled.map((id) => [id, JUSTIFICATION])),
        },
        'offline',
      );
      const deps: CollectorDeps = {
        mode: 'offline',
        config: createCollectorConfig({ mode: 'offline' }),
        robots: { check: async () => ({ allowed: true }) },
        breaker: new SourceCircuitBreaker(),
        redactor: TEST_REDACTOR,
      };
      const ctx: PlannerContext = {
        scope,
        factories: registryOfCollectors.list(),
        collectors: registryOfCollectors.forScope(scope, registry, deps),
        known: new Set(),
        maxPivotDepth: 2,
        maxTasks: 40,
        counter: { planned: 0 },
        watchList: [],
        fixture: deps.config.fixture,
      };
      return planInitial([identifier('nickname', NICK, { platform: 'bitcointalk' })], ctx);
    };
    const enabled = plan(['maigret']);
    expect(enabled.tasks.map((t) => [t.sourceId, t.subjectKey])).toEqual([['maigret', `name:${NICK}`]]);
    const off = plan(['bitcointalk']);
    expect(off.tasks.some((t) => t.sourceId === 'maigret')).toBe(false);
    expect(off.skipped.filter((t) => t.sourceId === 'maigret').map((t) => t.skip)).toEqual(['source_not_enabled']);
  });
});

describe('policy parity', () => {
  it('denies every host of the register`s RED sources', async () => {
    const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8')) as { deniedHostSuffixes: string[] };
    const covered = (host: string) =>
      policy.deniedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    const red = registry.list().filter((s) => s.compliance === 'RED');
    expect(red.length).toBeGreaterThan(0);
    const missing = red.flatMap((s) =>
      [...s.allowedHosts, ...(s.blockedHosts ?? [])].map((h) => h.replace(/^\*\./, '')).filter((h) => !covered(h)),
    );
    expect(missing).toEqual([]);
  });

  it('maps the fixture hosts like the collectors do', async () => {
    const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8')) as { fixtureHostPrefixes: Record<string, string> };
    for (const [host, prefix] of Object.entries(policy.fixtureHostPrefixes)) {
      expect(`${host}=${DEFAULT_HOST_PREFIXES[host]}`).toBe(`${host}=${prefix}`);
    }
  });

  it('keeps the tag allow-list in step with the service', async () => {
    const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8')) as { tagsAllowed: string[] };
    const { MAIGRET_TAGS } = await import('../src/index.ts');
    expect(policy.tagsAllowed.toSorted()).toEqual([...MAIGRET_TAGS].toSorted());
  });
});

describe('collection run', () => {
  it('runs the enumeration as a task, denying the hosts of sources the case did not enable', async () => {
    const { sent, test, scope } = setup();
    const result = await collectCase({
      identifiers: [identifier('nickname', NICK, { isAnchor: true })],
      scope,
      sources: registry,
      ctx: test.ctx,
      config: createCollectorConfig({ mode: 'offline', env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 2,
    });
    expect(result.tasks.map((t) => [t.sourceId, t.status, t.provenance.rule])).toEqual([['maigret', 'partial', 'I6']]);
    expect(result.accounts.map((a) => a.platform)).toEqual(['wykop']);
    const body = JSON.parse(sent[0]?.body ?? '{}') as { deniedHostSuffixes: string[] };
    // Register sources that are not enabled for this case are off limits for the service as well.
    expect(body.deniedHostSuffixes).toEqual(expect.arrayContaining(['wykop.pl', 'bitcointalk.org']));
    expect(body.deniedHostSuffixes).not.toContain('maigret');
  });
});
