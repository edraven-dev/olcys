/**
 * Regression tests: secrets never reach storage, replay requests the offline fixture URLs, punctuation in handles is
 * significant, malformed links are skipped, signed-message text is kept verbatim, and accounts are collected once.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EgressClient, EgressRequest, RunContext } from '@olcys/core';
import { requestHash } from '@olcys/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  collectCase,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createWykopCollector,
  findSignedMessages,
  parseHtml,
  planInitial,
  recogniseAccountUrl,
  resolveSourceUrl,
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
  fakeEgress,
  identifier,
  JUSTIFICATION,
  MemoryBlobs,
  memoryLogger,
  testRecorder,
  PERSONA_IDENTIFIERS,
  startFixture,
  testConfig,
  TEST_REDACTOR,
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

const facts = (r: CollectCaseResult) => r.observations.map((o) => [o.property, o.value, o.locator]);
const ALLOW_ALL = { check: async () => ({ allowed: true }) as const };

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

describe('secrets are redacted in memory and never stored', () => {
  const pages: Record<string, string> = {
    'action=profile;u=123456;sa=showPosts': html(
      '<table><tr class="titlebg2"><td class="middletext"><a href="index.php?board=1.0">Board</a> / <a href="index.php?topic=77.msg701#msg701">Keys</a><div align="right">on: November 01, 2026, 10:00:00 AM</div></td></tr><tr><td><div class="post">my key TESTSECRET-postKey1 lol</div></td></tr></table>',
    ),
    'action=profile;u=123456': html(
      '<table><tr><td><b>Name: </b></td><td>test_user_x</td></tr><tr><td><b>Other contact info: </b></td><td>TESTSECRET-profile9</td></tr></table><a href="index.php?action=profile;u=123456;sa=showPosts">posts</a>',
    ),
    'topic=77.msg701': html(
      '<table><tr><td class="poster_info"><b><a href="index.php?action=profile;u=123456">test_user_x</a></b></td><td class="td_headerandpost"><div class="subject"><a href="index.php?topic=77.msg701#msg701">Keys</a></div><div class="smalltext">November 01, 2026, 10:00:00 AM</div><div class="post">again TESTSECRET-topicKey2</div></td></tr></table>',
    ),
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.keys(pages).find((k) => url.endsWith(k));
    if (!hit) return new Response('', { status: 404 });
    return new Response(pages[hit], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;

  it('stores, parses and records only redacted text; the egress client keeps hashes only', async () => {
    const cassetteDir = await mkdtemp(join(tmpdir(), 'olcys-collectors-secrets-'));
    const scope = registry.resolveScope(
      { enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: JUSTIFICATION } },
      'live',
    );
    const test = createTestRun(scope, 'live', 'run-secrets', { fetchImpl, cassetteDir, record: true });
    const result = await collectCase({
      identifiers: [identifier('nickname', '123456', { platform: 'bitcointalk' })],
      scope,
      sources: registry,
      ctx: test.ctx,
      config: createCollectorConfig({ mode: 'live' }),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 0,
    });
    expect(result.captures.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    const decoder = new TextDecoder();
    for (const bytes of test.blobs.data.values()) expect(decoder.decode(bytes)).not.toContain('TESTSECRET-');
    for (const o of result.observations) expect(o.value).not.toContain('TESTSECRET-');
    expect(result.observations.some((o) => o.value === '[REDACTED:test_secret]')).toBe(true);
    for (const capture of result.captures) {
      const envelope = test.envelopes.find((e) => e.fetchId === capture.fetchIds.at(-1));
      expect(envelope?.bodyPersisted).toBe(false);
      expect(capture.technical?.redaction).toEqual({
        secrets: 1,
        kinds: ['test_secret'],
        originalSha256: envelope?.body.sha256,
      });
      expect(capture.artifacts[0]?.blob.sha256).not.toBe(envelope?.body.sha256);
    }
    // Only robots.txt was recordable; page bodies are never written to cassettes.
    const cassettes = await filesUnder(cassetteDir);
    expect(cassettes).toHaveLength(1);
    const contents = await Promise.all(cassettes.map((file) => readFile(file, 'utf8')));
    for (const content of contents) {
      const cassette = JSON.parse(content) as { request: { url: string }; bodyBase64: string };
      expect(cassette.request.url).toMatch(/\/robots\.txt$/);
      expect(Buffer.from(cassette.bodyBase64, 'base64').toString('utf8')).not.toContain('TESTSECRET-');
    }
  });
});

describe('invalid redirect targets end the page, not the collection', () => {
  it('returns a typed error for an unparsable Location and keeps collecting', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('action=profile;u=123456')) {
        return new Response(null, { status: 302, headers: { location: 'https://[' } });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const scope = registry.resolveScope(
      { enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: JUSTIFICATION } },
      'live',
    );
    const test = createTestRun(scope, 'live', 'run-bad-redirect', { fetchImpl });
    const result = await collectCase({
      identifiers: [identifier('nickname', '123456', { platform: 'bitcointalk' })],
      scope,
      sources: registry,
      ctx: test.ctx,
      config: createCollectorConfig({ mode: 'live' }),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 0,
    });
    const notes = JSON.stringify(result);
    expect(notes).toContain('redirect_invalid');
    expect(result.captures.every((c) => c.status !== 'ok')).toBe(true);
  });
});

/** Test-side cassette generator for synthetic fixture pages (same key as the egress client's replay lookup). */
function recorder(inner: EgressClient, dir: string): EgressClient {
  return {
    async fetch(request: EgressRequest) {
      const response = await inner.fetch(request);
      const variant: Record<string, string> = request.redirect === 'manual' ? { redirect: 'manual' } : {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (['accept', 'accept-language', 'content-type'].includes(name.toLowerCase())) {
          variant[`header:${name.toLowerCase()}`] = value;
        }
      }
      const hash = requestHash(request.method ?? 'GET', request.url, request.body, request.secretParams, variant);
      const path = join(dir, request.sourceId, `${hash}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          request: { method: request.method ?? 'GET', url: request.url },
          status: response.status,
          headers: response.headers,
          bodyBase64: Buffer.from(response.body).toString('base64'),
          finalUrl: response.finalUrl,
          synthetic: true,
        }),
      );
      return response;
    },
  };
}

describe('replay requests exactly the fixture URLs of offline', () => {
  it('maps live hosts to the fixture site in replay too', () => {
    expect(resolveSourceUrl('https://wykop.pl/ludzie/x/', 'replay', config.fixture)).toBe(
      `${server.url}/wykop/ludzie/x/`,
    );
  });

  it('a run replayed from recordings of the fixture site matches the offline run, without network', async () => {
    const cassetteDir = await mkdtemp(join(tmpdir(), 'olcys-collectors-replay-'));
    const run = async (mode: 'offline' | 'replay') => {
      const scope = registry.resolveScope(DEMO_SCOPE, mode);
      const test = createTestRun(
        scope,
        mode,
        `run-${mode}`,
        mode === 'offline'
          ? { wrap: (client) => recorder(client, cassetteDir) }
          : {
              cassetteDir,
              fetchImpl: (() => Promise.reject(new Error('network used in replay'))) as typeof fetch,
            },
      );
      return collectCase({
        identifiers: PERSONA_IDENTIFIERS(),
        scope,
        sources: registry,
        ctx: test.ctx,
        config: await testConfig(server, mode),
        robots: test.robots,
        redactor: TEST_REDACTOR,
        maxPivotDepth: 2,
      });
    };
    const offline = await run('offline');
    const replay = await run('replay');
    expect(replay.tasks.map((t) => [t.key, t.status])).toEqual(offline.tasks.map((t) => [t.key, t.status]));
    expect(replay.tasks).toHaveLength(6);
    expect(replay.captures).toHaveLength(11);
    expect(replay.partial).toBe(false);
    expect(facts(replay)).toEqual(facts(offline));
  });
});

describe('handles keep the platform account-name rules', () => {
  it('`test-ab` and `test_ab` are two Wykop accounts, but one GitHub login', () => {
    const scope = registry.resolveScope(DEMO_SCOPE, 'offline');
    const collectors = createDefaultCollectorRegistry();
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: ALLOW_ALL,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const plan = planInitial(
      [
        identifier('nickname', 'test-ab', { platform: 'wykop' }),
        identifier('nickname', 'test_ab', { platform: 'wykop' }),
      ],
      {
        scope,
        factories: collectors.list(),
        collectors: collectors.forScope(scope, registry, deps),
        known: new Set(),
        maxPivotDepth: 2,
        maxTasks: 40,
        counter: { planned: 0 },
        watchList: [],
        fixture: config.fixture,
      },
    );
    const keys = (sourceId: string) => plan.tasks.filter((t) => t.sourceId === sourceId).map((t) => t.key);
    expect(keys('wykop')).toEqual(['wykop|handle:wykop:test-ab', 'wykop|handle:wykop:test_ab']);
    expect(keys('github')).toEqual(['github|handle:github:test-ab']);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({ key: 'github|handle:github:test-ab', skip: 'duplicate' }),
    );
  });
});

describe('malformed links are skipped, not fatal', () => {
  it('a stray % in a profile link does not throw', () => {
    expect(recogniseAccountUrl('https://bitcointalk.org/index.php?action=profile;u=1%zz')).toBeUndefined();
  });

  it('the social profile is still collected and the bad link is noted', async () => {
    const page =
      '<html><body><main><h1 class="username">test_user_x</h1><section class="about"><p>' +
      '<a href="/bitcointalk/index.php?action=profile;u=1%zz">bad</a> ' +
      '<a href="/bitcointalk/index.php?action=profile;u=777">ok</a></p></section></main></body></html>';
    const egress = fakeEgress(() => ({ status: 200, body: page }));
    const logger = memoryLogger();
    const ctx: RunContext = {
      runId: 'r',
      caseId: 'c',
      mode: 'offline',
      http: egress,
      blobs: new MemoryBlobs(),
      clock: { now: () => new Date() },
      logger,
      evidence: testRecorder(),
    };
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: ALLOW_ALL,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const collector = createWykopCollector().create(registry.require('wykop'), deps);
    const result = await collector.collect(
      { identifiers: [], accounts: [], addresses: [], depth: 0, values: [{ kind: 'username', value: 'test_user_x' }] },
      ctx,
    );
    expect(result.status).toBe('ok');
    expect(result.notes).toContain('malformed_link: /bitcointalk/index.php?action=profile;u=1%zz');
    expect(result.observations.filter((o) => o.property === 'account.link').map((o) => o.value)).toEqual([
      'https://bitcointalk.org/index.php?action=profile;u=777',
    ]);
  });
});

const block = (inner: string) => parseHtml(`<div class="post">${inner}</div>`).querySelector('div.post');

describe('signed-message text is kept exactly as authored', () => {
  it('keeps spaces, NBSP and blank lines between <br> tags', () => {
    const post = block(
      '<div class="code">-----BEGIN BITCOIN SIGNED MESSAGE-----<br />  two  spaces&nbsp;nbsp  <br /><br /><br />last line <br />-----BEGIN SIGNATURE-----<br />1abc<br />SIG=<br />-----END BITCOIN SIGNED MESSAGE-----</div>',
    );
    expect(post && findSignedMessages(post)[0]?.text).toBe('  two  spaces\u00a0nbsp  \n\n\nlast line ');
  });

  it('keeps the line breaks of <pre> text', () => {
    const post = block(
      '<pre>-----BEGIN BITCOIN SIGNED MESSAGE-----\nline\n\n\n  more\n-----BEGIN SIGNATURE-----\n1abc\nSIG=\n-----END BITCOIN SIGNED MESSAGE-----</pre>',
    );
    expect(post && findSignedMessages(post)[0]?.text).toBe('line\n\n\n  more');
  });
});

describe('an account collected under one key is not collected again', () => {
  it('a forum nick and its profile URL as inputs fetch the profile once', async () => {
    const scope = registry.resolveScope(DEMO_SCOPE, 'offline');
    const test = createTestRun(scope);
    const result = await collectCase({
      identifiers: [
        identifier('nickname', 'fikcyjny_kacper', { platform: 'bitcointalk', isAnchor: true }),
        identifier('social_login', 'https://bitcointalk.org/index.php?action=profile;u=900001'),
      ],
      scope,
      sources: registry,
      ctx: test.ctx,
      config,
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 0,
    });
    expect(result.tasks.filter((t) => t.sourceId === 'bitcointalk').map((t) => t.key)).toEqual([
      'bitcointalk|handle:bitcointalk:fikcyjny_kacper',
    ]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ key: 'bitcointalk|id:bitcointalk:900001', skip: 'already_collected' }),
    );
    expect(result.captures.filter((c) => c.sourceId === 'bitcointalk')).toHaveLength(4);
  });
});
