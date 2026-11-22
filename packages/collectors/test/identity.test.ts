/**
 * Identity lookups: BitList (AMBER), Keybase and ENS. Live-shaped behaviour runs against a fake `fetch` behind the real
 * egress client; offline behaviour reads the synthetic answers of the fixture site. Everything is synthetic: the demo
 * persona is unknown to all three sources, a second synthetic identity (`olcys_test_ewa`) is "found".
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CollectorInput, CollectorResult, FetchMode, SourceId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretRedactor } from '../../address-extractor/src/index.ts';
import { abiEncode } from '../src/identity/ens-abi.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { identityAddresses, TEST_IDENTITY } from '../../../apps/fixture-site/scripts/lib/identity.ts';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  collectCase,
  createBitlistCollector,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createEnsCollector,
  createKeybaseCollector,
  decodeCoinAddress,
  ENS_FIXTURE_RESOLVER,
  looksLikeEnsName,
  namehash,
  normaliseEnsName,
  parseBitlistAddresses,
  parseBitlistPosts,
  parseKeybaseLookup,
  parseSourceRegistry,
  DEFAULT_SOURCES_PATH,
  planInitial,
  PIVOT_RULES_VERSION,
  runCollector,
  SourceCircuitBreaker,
  SourceConfigError,
  taskKey,
  type CollectorDeps,
  type CollectorFactory,
  type EnsReader,
  type PlannerContext,
  type SourceRegistry,
} from '../src/index.ts';
import { CcipReadDisabledError } from '../src/index.ts';
import {
  BTC_1,
  createTestRun,
  demoRegistry,
  identifier,
  PERSONA_IDENTIFIERS,
  SIGNATURE,
  startFixture,
  testConfig,
  TEST_REDACTOR,
} from './helpers.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'bitlist');
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const JUSTIFICATION = 'Sprawa testowa 2026/1: archiwum forum, dane syntetyczne';
const PERSONA_ETH_1 = '0xCd5C1A91d6dFAAfEb0807e3c9d6D00655A54617a';

let registry: SourceRegistry;
let server: FixtureServer;
let seed = '';
let signedMessage = '';
beforeAll(async () => {
  registry = await demoRegistry();
  server = await startFixture('v1');
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'persona', 'manifest.json'), 'utf8'),
  ) as {
    seed: string;
    signedMessages: { message: string }[];
  };
  seed = manifest.seed;
  signedMessage = manifest.signedMessages[0]?.message ?? '';
});
afterAll(async () => {
  await server.close();
});

const readText = (path: string): string => readFileSync(path, 'utf8');
const A = () => identityAddresses(seed);
const NICK = TEST_IDENTITY.nick;
const ENS_NAME = TEST_IDENTITY.ensName;
const fixtureJson = async (relative: string) =>
  readFile(
    resolve(import.meta.dirname, '..', '..', '..', 'apps', 'fixture-site', 'public', 'shared', relative),
    'utf8',
  );

const handleInput = (
  platform: string | undefined,
  value: string,
  kind: 'nickname' | 'social_login' = 'nickname',
): CollectorInput => ({
  identifiers: [identifier(kind, value, platform ? { platform } : {})],
  accounts: [],
  addresses: [],
  depth: 0,
});
const probeInput = (value: string): CollectorInput => ({
  identifiers: [],
  accounts: [],
  addresses: [],
  depth: 0,
  values: [{ kind: 'username', value, method: 'enumeration' }],
});
const addressInput = (chain: 'bitcoin' | 'evm:1', address: string): CollectorInput => ({
  identifiers: [identifier('crypto_address', address, { chain })],
  accounts: [],
  addresses: [{ chain, address }],
  depth: 0,
});
const props = (r: CollectorResult, property: string) => r.observations.filter((o) => o.property === property);
const values = (r: CollectorResult, property: string) => props(r, property).map((o) => o.value);

type Answer = { status: number; body?: string; headers?: Record<string, string> };

/** Live-mode run over a fake `fetch`: the URLs the collector sends and the answers it gets. */
function liveSetup(
  answer: (url: string, body?: string) => Answer | Promise<Answer>,
  sources: SourceId[],
  env: Record<string, string> = {},
) {
  const mode: FetchMode = 'live';
  const sent: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    sent.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}) });
    const { status, body: text, headers } = await answer(url, body);
    return new Response(text ?? '', { status, headers: { ...JSON_TYPE, ...headers } });
  }) as typeof fetch;
  const reg = env['OLCYS_SOURCE_HOSTS_ENS'] ? parseSourceRegistry(readText(DEFAULT_SOURCES_PATH), env) : registry;
  const scope = reg.resolveScope({ enabledSources: sources, amberJustifications: { bitlist: JUSTIFICATION } }, mode);
  const test = createTestRun(scope, mode, 'run-identity', { fetchImpl });
  const deps: CollectorDeps = {
    mode,
    config: createCollectorConfig({ mode, env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const run = (factory: CollectorFactory, input: CollectorInput): Promise<CollectorResult> =>
    runCollector(factory.create(reg.require(factory.sourceId), deps), input, test.ctx, scope, deps);
  return { sent, test, run, deps, scope, reg };
}

const hitsFor = (author: string, address: string) =>
  JSON.stringify({
    result: 'success',
    message: null,
    data: {
      total_results: 1,
      addresses: [
        {
          address,
          coin: 'BTC',
          post_id: 1,
          topic_id: 2,
          author,
          author_uid: 900201,
          title: 't',
          date: '2026-01-01T00:00:00.000Z',
          board_id: 142,
          board_name: 'Polski',
        },
      ],
    },
  });

it('queries author, posts and address with the observed parameters only (AMBER, identifier disclosed)', async () => {
  const { sent, run, test } = liveSetup(
    (url) => ({
      status: 200,
      body: url.includes('/posts')
        ? '{"result":"success","message":null,"data":{"total_results":0,"posts":[]}}'
        : hitsFor(NICK, A().btc),
    }),
    ['bitlist'],
  );
  await run(createBitlistCollector(), probeInput(NICK));
  await run(createBitlistCollector(), addressInput('bitcoin', A().btc));
  expect(sent.map((s) => s.url)).toEqual([
    `https://api.ninjastic.space/addresses?author=${NICK}&limit=50`,
    `https://api.ninjastic.space/posts?author=${NICK}&limit=50`,
    `https://api.ninjastic.space/addresses?address=${A().btc}&limit=50`,
  ]);
  expect(sent.some((s) => s.url.includes('board='))).toBe(false);
  expect(test.logs.every((l) => l.sourceId === 'bitlist' && l.containsIdentifier)).toBe(true);
  expect(new Set(test.logs.map((l) => l.host))).toEqual(new Set(['api.ninjastic.space']));
});

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function runEns(input: CollectorInput, ens: EnsReader) {
  const scope = registry.resolveScope({ enabledSources: ['ens'], amberJustifications: {} }, 'offline');
  const test = createTestRun(scope);
  const deps: CollectorDeps = {
    mode: 'offline',
    config: await testConfig(server),
    robots: test.robots,
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const collector = createEnsCollector({ reader: ens }).create(registry.require('ens'), deps);
  return { result: await runCollector(collector, input, test.ctx, scope, deps), test };
}

async function offline(input: CollectorInput) {
  const scope = registry.resolveScope({ enabledSources: ['ens'], amberJustifications: {} }, 'offline');
  const test = createTestRun(scope);
  const deps: CollectorDeps = {
    mode: 'offline',
    config: await testConfig(server),
    robots: test.robots,
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const result = await runCollector(
    createEnsCollector().create(registry.require('ens'), deps),
    input,
    test.ctx,
    scope,
    deps,
  );
  return { result, test };
}

const depsFor = (mode: FetchMode): CollectorDeps => ({
  mode,
  config: createCollectorConfig({ mode }),
  robots: { check: async () => ({ allowed: true }) },
  breaker: new SourceCircuitBreaker(),
  redactor: TEST_REDACTOR,
});

const planner = (
  scope: ReturnType<SourceRegistry['resolveScope']>,
  config: ReturnType<typeof createCollectorConfig>,
): PlannerContext => {
  const collectors = createDefaultCollectorRegistry({ mode: 'offline' });
  const deps: CollectorDeps = {
    mode: 'offline',
    config,
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  return {
    scope,
    factories: collectors.list(),
    collectors: collectors.forScope(scope, registry, deps),
    known: new Set(),
    maxPivotDepth: 2,
    maxTasks: 40,
    counter: { planned: 0 },
    watchList: [],
    fixture: config.fixture,
  };
};

describe('Keybase', () => {
  it('requests exactly the documented lookup URL and reads signed addresses and proofs', async () => {
    const found = await fixtureJson('keybase/lookup-olcys_test_ewa.json');
    const { sent, run, test } = liveSetup(() => ({ status: 200, body: found }), ['keybase']);
    const result = await run(createKeybaseCollector(), probeInput(NICK));
    expect(sent.map((s) => s.url)).toEqual([
      `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${NICK}&fields=basics,profile,proofs_summary,cryptocurrency_addresses`,
    ]);
    expect(test.logs.every((l) => l.sourceId === 'keybase' && l.containsIdentifier)).toBe(true);
    expect(result.status).toBe('ok');
    expect(values(result, 'verification.bitcoin_address')).toEqual([A().btc]);
    expect(props(result, 'verification.bitcoin_address')[0]?.locator).toBe(
      `keybase:${NICK}#cryptocurrency_addresses.bitcoin[0]`,
    );
    expect(values(result, 'verification.bitcoin_sig_id')).toHaveLength(1);
    // Zcash has no chain family: recorded as a fact, with a note, not an error.
    expect(values(result, 'verification.zcash_address')).toHaveLength(1);
    expect(result.notes.some((n) => n.startsWith('unsupported_input: zcash'))).toBe(true);
    const keybase = result.accounts.find((a) => a.platform === 'keybase');
    expect(keybase).toMatchObject({ handle: NICK, discoveredVia: { method: 'enumeration' } });
    expect(keybase?.platformUserId).toMatch(/^[0-9a-f]{32}$/);
    expect(values(result, 'profile.created_at')).toEqual(['2014-01-01T00:00:00.000Z']);
  });

  it('follows only verified proofs (state 1): a link and a cross-link account; state 2 is a fact only', async () => {
    const found = await fixtureJson('keybase/lookup-olcys_test_ewa.json');
    const { run } = liveSetup(() => ({ status: 200, body: found }), ['keybase']);
    const result = await run(createKeybaseCollector(), probeInput(NICK));
    expect(values(result, 'account.link')).toEqual([`https://github.com/${TEST_IDENTITY.github}`]);
    const github = result.accounts.find((a) => a.platform === 'github');
    expect(github).toMatchObject({
      handle: TEST_IDENTITY.github,
      discoveredVia: { sourceId: 'keybase', method: 'cross_link' },
    });
    expect(github?.discoveredVia.fromAccountId).toBe(result.accounts.find((a) => a.platform === 'keybase')?.id);
    expect(values(result, 'verification.proof_state').toSorted()).toEqual(['1', '2']);
    expect(result.accounts.some((a) => a.platform === 'x_twitter')).toBe(false);
    expect(result.observations.some((o) => o.property === 'account.link' && o.value.includes('x.com'))).toBe(false);
  });

  it('answers not found for an unknown user (them: [null]) with one capture and no observations', async () => {
    const none = await fixtureJson('keybase/lookup-none.json');
    const { run } = liveSetup(() => ({ status: 200, body: none }), ['keybase']);
    const result = await run(createKeybaseCollector(), probeInput('olcys_test_nn'));
    expect([result.status, result.observations.length, result.captures.length]).toEqual(['not_found', 0, 1]);
  });

  it('maps an input error to error, a rate limit to blocked (and stops the source), HTML maintenance to error', async () => {
    const bad = liveSetup(
      () => ({ status: 200, body: '{"status":{"code":100,"name":"INPUT_ERROR"},"them":[]}' }),
      ['keybase'],
    );
    expect((await bad.run(createKeybaseCollector(), probeInput(NICK))).status).toBe('error');
    let calls = 0;
    const limited = liveSetup(
      () => ((calls += 1), { status: 429, body: '{}', headers: { 'retry-after': '30' } }),
      ['keybase'],
    );
    const two: CollectorInput = {
      ...probeInput('olcys_test_a1'),
      values: [
        { kind: 'username', value: 'olcys_test_a1' },
        { kind: 'username', value: 'olcys_test_a2' },
      ],
    };
    const blocked = await limited.run(createKeybaseCollector(), two);
    expect(blocked.status).toBe('blocked');
    expect(calls).toBe(1);
    expect((await limited.run(createKeybaseCollector(), probeInput('olcys_test_a3'))).notes.join('\n')).toContain(
      'source_stopped',
    );
    expect(calls).toBe(1);
    const html = liveSetup(
      () => ({ status: 503, body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } }),
      ['keybase'],
    );
    expect((await html.run(createKeybaseCollector(), probeInput(NICK))).status).toBe('error');
    const html200 = liveSetup(
      () => ({ status: 200, body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } }),
      ['keybase'],
    );
    expect((await html200.run(createKeybaseCollector(), probeInput(NICK))).status).toBe('error');
  });

  it('sends nothing for names Keybase cannot have (hyphen, one letter, e-mail)', async () => {
    const { sent, run } = liveSetup(() => ({ status: 200, body: '{}' }), ['keybase']);
    const result = await run(createKeybaseCollector(), {
      identifiers: [
        identifier('nickname', 'fikcyjny-kacper'),
        identifier('nickname', 'k'),
        identifier('email', 'kacper.fikcyjny@example.org'),
      ],
      accounts: [],
      addresses: [],
      depth: 0,
    });
    expect(sent).toEqual([]);
    expect(result.notes.filter((n) => n.startsWith('unsupported_input'))).toHaveLength(2);
  });

  it('keeps the register rate (1 request per second) and a single host', () => {
    const d = registry.require('keybase');
    expect([d.rateLimit, d.allowedHosts, d.compliance]).toEqual([
      { requests: 1, perSeconds: 1 },
      ['keybase.io'],
      'GREEN',
    ]);
  });

  it('parses the documented shapes', () => {
    expect(parseKeybaseLookup({ status: { code: 0, name: 'OK' }, them: [null] }).status).toBe('not_found');
    expect(parseKeybaseLookup({ status: { code: 205, name: 'NOT_FOUND' }, them: [] }).status).toBe('not_found');
    expect(parseKeybaseLookup('x').status).toBe('error');
  });
});

describe('BitList', () => {
  it('reads the persona-independent test identity offline: addresses, uid account, archive facts', async () => {
    const scope = registry.resolveScope(
      { enabledSources: ['bitlist'], amberJustifications: { bitlist: JUSTIFICATION } },
      'offline',
    );
    const test = createTestRun(scope);
    const config = await testConfig(server);
    const deps: CollectorDeps = {
      mode: 'offline',
      config,
      robots: test.robots,
      breaker: new SourceCircuitBreaker(),
      redactor: TEST_REDACTOR,
    };
    const factory = createBitlistCollector();
    const author = await runCollector(
      factory.create(registry.require('bitlist'), deps),
      probeInput(NICK),
      test.ctx,
      scope,
      deps,
    );
    expect(author.status).toBe('ok');
    expect(values(author, 'archive.post.address')).toEqual([A().btc, A().eth]);
    expect(props(author, 'archive.post.address').map((o) => o.locator)).toEqual([
      'bitlist:post=65000201#address[0]',
      'bitlist:post=65000202#address[1]',
    ]);
    expect(values(author, 'archive.post.board')[0]).toBe('142:Polski');
    expect(values(author, 'archive.post.url')[0]).toBe(
      'https://bitcointalk.org/index.php?topic=5500201.msg65000201#msg65000201',
    );
    expect(values(author, 'archive.post.text')).toHaveLength(2);
    expect(author.accounts).toHaveLength(1);
    expect(author.accounts[0]).toMatchObject({
      platform: 'bitcointalk',
      platformUserId: '900201',
      handle: NICK,
      discoveredVia: { sourceId: 'bitlist', method: 'search' },
    });
    const byAddress = await runCollector(
      factory.create(registry.require('bitlist'), deps),
      addressInput('bitcoin', A().btc),
      test.ctx,
      scope,
      deps,
    );
    expect(values(byAddress, 'archive.post.address')).toEqual([A().btc]);
    expect(byAddress.accounts[0]?.discoveredVia.method).toBe('search');
    // The persona is unknown to the archive: an affirmative not found.
    const persona = await runCollector(
      factory.create(registry.require('bitlist'), deps),
      probeInput('fikcyjny_kacper'),
      test.ctx,
      scope,
      deps,
    );
    expect([persona.status, persona.observations.length]).toEqual(['not_found', 0]);
  });

  it('keeps only hits about the queried author or address; a bare-array posts answer parses', async () => {
    const foreign = (await readFile(join(FIXTURES, 'foreign-authors.json'), 'utf8')).replace('{{ADDRESS}}', A().btc);
    const { run } = liveSetup(() => ({ status: 200, body: foreign }), ['bitlist']);
    const result = await run(createBitlistCollector({ includePosts: false }), probeInput(NICK));
    expect(values(result, 'archive.post.address')).toEqual([A().btc]);
    expect(result.accounts.map((a) => a.platformUserId)).toEqual(['900201']);
    const parsed = parseBitlistPosts(JSON.parse(await readFile(join(FIXTURES, 'posts-array.json'), 'utf8')));
    expect(parsed.posts.map((p) => p.post_id)).toEqual([65000301]);
  });

  it('records signed blocks of archived posts as facts (the check happens where evidence is weighed)', async () => {
    const body = (await readFile(join(FIXTURES, 'posts-signed.json'), 'utf8'))
      .replaceAll('{{ADDRESS}}', BTC_1)
      .replace('{{MESSAGE}}', signedMessage)
      .replace('{{SIGNATURE}}', SIGNATURE);
    const { run } = liveSetup(
      (url) =>
        url.includes('/posts')
          ? { status: 200, body }
          : { status: 200, body: '{"result":"success","message":null,"data":{"total_results":0,"addresses":[]}}' },
      ['bitlist'],
    );
    const result = await run(createBitlistCollector(), probeInput(NICK));
    expect(values(result, 'post.signed_message.address')).toEqual([BTC_1]);
    expect(values(result, 'post.signed_message.signature')).toEqual([SIGNATURE]);
    expect(props(result, 'post.signed_message.address')[0]?.locator).toBe('bitlist:post=65000501#signed_message[0]');
  });

  it('maps a failure body to error, 429 to blocked (no further request), empty results to not found', async () => {
    const fail = liveSetup(() => ({ status: 200, body: readText(join(FIXTURES, 'fail.json')) }), ['bitlist']);
    const failed = await fail.run(createBitlistCollector(), probeInput(NICK));
    expect(failed.status).toBe('error');
    expect(failed.notes.join('\n')).toContain('synthetic failure');
    let calls = 0;
    const limited = liveSetup(() => ((calls += 1), { status: 429, body: '{}' }), ['bitlist']);
    expect((await limited.run(createBitlistCollector(), probeInput(NICK))).status).toBe('blocked');
    expect(calls).toBe(1);
    const empty = liveSetup(
      () => ({ status: 200, body: '{"result":"success","message":null,"data":{"total_results":0,"addresses":[]}}' }),
      ['bitlist'],
    );
    expect((await empty.run(createBitlistCollector({ includePosts: false }), probeInput(NICK))).status).toBe(
      'not_found',
    );
    expect(() => parseBitlistAddresses({ result: 'fail', message: 'x' })).toThrow(/x/);
  });

  it('notes truncation when the archive has more hits than it returned', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      address: `bc1qsynthetic${i}`,
      coin: 'BTC',
      post_id: i + 1,
      topic_id: 1,
      author: NICK,
      author_uid: 900201,
      title: 't',
      date: '2026-01-01T00:00:00.000Z',
      board_id: 142,
      board_name: 'Polski',
    }));
    const body = JSON.stringify({ result: 'success', message: null, data: { total_results: 120, addresses: items } });
    const { run } = liveSetup(() => ({ status: 200, body }), ['bitlist']);
    const result = await run(createBitlistCollector({ includePosts: false }), probeInput(NICK));
    expect(result.notes).toContain('truncated: 50 of 120');
  });

  it('is AMBER: without a case justification the planner skips it and nothing is requested', async () => {
    const scope = registry.resolveScope({ enabledSources: ['bitlist'], amberJustifications: {} }, 'offline');
    expect(scope.isEnabled('bitlist')).toBe(false);
    const test = createTestRun(scope);
    const result = await collectCase({
      identifiers: [identifier('nickname', NICK)],
      scope,
      sources: registry,
      ctx: test.ctx,
      config: await testConfig(server),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 1,
    });
    expect(test.logs.filter((l) => l.sourceId === 'bitlist')).toEqual([]);
    expect(result.skipped.find((s) => s.sourceId === 'bitlist')?.skip).toBe('amber_without_justification');
    const short = registry.resolveScope(
      { enabledSources: ['bitlist'], amberJustifications: { bitlist: 'za krótko' } },
      'offline',
    );
    expect(short.refusal('bitlist')).toBe('amber_without_justification');
  });
});

describe('ENS names and coins', () => {
  it('normalises conservatively and refuses look-alikes and invisible characters', () => {
    expect(normaliseEnsName('Olcys-Test-Ewa.ETH')).toEqual({ ok: true, name: 'olcys-test-ewa.eth' });
    for (const bad of [
      'olcys​test.eth',
      'olcys-tést.eth',
      'аpple.eth',
      'a..eth',
      '-a.eth',
      'noeth',
      'ab--c.eth',
      '😀.eth',
    ]) {
      expect(normaliseEnsName(bad).ok).toBe(false);
    }
    expect(looksLikeEnsName(' Name.ETH ')).toBe(true);
    expect(looksLikeEnsName('name.com')).toBe(false);
  });

  it('computes the ENSIP-1 namehash', () => {
    expect(hex(namehash(''))).toBe('0'.repeat(64));
    expect(hex(namehash('eth'))).toBe('93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
    expect(hex(namehash('foo.eth'))).toBe('de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
  });

  it('decodes ENSIP-9 bytes to addresses', () => {
    const program = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
    const p2wpkh = decodeCoinAddress(0, Uint8Array.from([0x00, 0x14, ...program]));
    expect(p2wpkh).toMatch(/^bc1q/);
    expect(decodeCoinAddress(0, Uint8Array.from([1, 2, 3]))).toBeUndefined();
    expect(decodeCoinAddress(195, Uint8Array.from([0x41, ...program]))).toMatch(/^T/);
  });
});

describe('ENS collector (fake reader)', () => {
  const ADDR = '0x00000000000000000000000000000000000000aa';
  const OTHER = '0x00000000000000000000000000000000000000bb';
  const BLOCK = { number: 100n, hash: '0xabc' };
  function reader(overrides: Partial<EnsReader> = {}): EnsReader & { calls: string[] } {
    const calls: string[] = [];
    const base: EnsReader = {
      block: async () => BLOCK,
      primaryName: async (a) => (a.toLowerCase() === ADDR ? ENS_NAME : null),
      address: async (name, coinType) => {
        calls.push(`addr:${name}:${coinType}`);
        if (coinType === 60) return ADDR;
        if (coinType === 0) return `0x0014${'11'.repeat(20)}`;
        return null;
      },
      text: async (name, key) => {
        calls.push(`text:${name}:${key}`);
        return key === 'com.github' ? 'olcys-test-ewa' : key === 'description' ? 'Opis​ z\u0007 ukrytymi znakami' : null;
      },
    };
    return Object.assign({ calls }, base, overrides);
  }

  it('a primary name that resolves back is verified: facts, one ens account, E1-shaped observation', async () => {
    const { result } = await runEns(addressInput('evm:1', ADDR), reader());
    expect(values(result, 'ens.primary_name')).toEqual([ENS_NAME]);
    expect(values(result, 'computed.ens.forward_verified')).toEqual(['true']);
    expect(values(result, 'ens.verified_address')).toEqual([ADDR]);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      platform: 'ens',
      handle: ENS_NAME,
      discoveredVia: { sourceId: 'ens', method: 'protocol_lookup' },
    });
    expect(result.accounts[0]?.profileUrl).toBe(`https://app.ens.domains/${ENS_NAME}`);
    expect(result.captures).toHaveLength(1);
  });

  it('a forward address that differs is recorded as not verified: no account, no verified address', async () => {
    const { result } = await runEns(addressInput('evm:1', ADDR), reader({ address: async () => OTHER }));
    expect(values(result, 'computed.ens.forward_verified')).toEqual(['false']);
    expect(result.accounts).toEqual([]);
    expect(props(result, 'ens.verified_address')).toEqual([]);
    expect(result.notes.some((n) => n.includes('not forward-verified'))).toBe(true);
  });

  it('an address without a primary name is not found', async () => {
    const { result } = await runEns(addressInput('evm:1', OTHER), reader());
    expect([result.status, result.observations.length]).toEqual(['not_found', 0]);
  });

  it('a name: text records, social links, other-chain addresses; hostile text is cleaned and links are validated', async () => {
    const { result } = await runEns(handleInput(undefined, 'Olcys-Test-Ewa.ETH'), reader());
    expect(values(result, 'ens.text.com.github')).toEqual(['olcys-test-ewa']);
    expect(values(result, 'account.link')).toEqual(['https://github.com/olcys-test-ewa']);
    expect(values(result, 'profile.ens_btc_address')[0]).toMatch(/^bc1q/);
    expect(values(result, 'ens.text.description')).toEqual(['Opis z ukrytymi znakami']);
    expect(values(result, 'profile.ens_address')).toEqual([ADDR]);
    // The reverse check closes the loop for a name: the address' primary name equals it.
    expect(values(result, 'computed.ens.forward_verified')).toEqual(['true']);
    expect(result.accounts[0]?.discoveredVia.method).toBe('input');
    const hostile = await runEns(
      handleInput(undefined, 'a.eth'),
      reader({ text: async (_n, key) => (key === 'com.github' ? '../../evil?x=1' : null) }),
    );
    expect(values(hostile.result, 'account.link')).toEqual([]);
  });

  it('refuses a name with an invisible character before any request', async () => {
    const r = reader();
    const { result } = await runEns(handleInput(undefined, 'olcys​test.eth'), r);
    expect(r.calls).toEqual([]);
    expect(result.notes.some((n) => n.startsWith('unsupported_input: ens name refused'))).toBe(true);
    expect(result.captures).toEqual([]);
  });

  it('reports CCIP-Read as unsupported instead of following it', async () => {
    const { result } = await runEns(
      addressInput('evm:1', ADDR),
      reader({
        primaryName: async () => {
          throw new CcipReadDisabledError();
        },
      }),
    );
    expect(result.status).toBe('error');
    expect(result.notes).toContain('unsupported_input: ccip-read disabled');
  });
});

describe('ENS over JSON-RPC (fixture node)', () => {
  it('verifies the test address: every call is a POST to the node, with identifier flag, pinned to one block', async () => {
    const { result, test } = await offline(addressInput('evm:1', A().eth));
    expect(values(result, 'ens.primary_name')).toEqual([ENS_NAME]);
    expect(values(result, 'computed.ens.forward_verified')).toEqual(['true']);
    expect(values(result, 'ens.verified_address')).toEqual([A().eth]);
    expect(values(result, 'ens.text.io.keybase')).toEqual([NICK]);
    expect(values(result, 'profile.ens_btc_address')).toEqual([A().btc]);
    expect(test.logs.every((l) => l.sourceId === 'ens' && l.containsIdentifier && l.method === 'POST')).toBe(true);
    expect(test.logs.length).toBeGreaterThan(10);
    const blocks = new Set(test.envelopes.filter((e) => e.method === 'POST').map((e) => e.url));
    expect(blocks.size).toBe(1);
    expect(result.captures).toHaveLength(1);
    expect(ENS_FIXTURE_RESOLVER).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('an impostor address that claims the name is not verified; the persona addresses have no name', async () => {
    const impostor = await offline(addressInput('evm:1', A().ethImpostor));
    expect(values(impostor.result, 'computed.ens.forward_verified')).toEqual(['false']);
    expect(impostor.result.accounts).toEqual([]);
    const persona = await offline(addressInput('evm:1', PERSONA_ETH_1));
    expect(persona.result.status).toBe('not_found');
  });

  it('forward-checks a name offline: address, Bitcoin address, social links', async () => {
    const { result } = await offline(handleInput(undefined, ENS_NAME));
    expect(values(result, 'profile.ens_address')).toEqual([A().eth]);
    expect(values(result, 'ens.verified_address')).toEqual([A().eth]);
    expect(values(result, 'account.link').toSorted()).toEqual([
      `https://github.com/${TEST_IDENTITY.github}`,
      `https://keybase.io/${NICK}`,
    ]);
    const unknown = await offline(handleInput(undefined, 'olcys-test-nieznany.eth'));
    expect(unknown.result.status).toBe('not_found');
  });

  it('live mode: no RPC URL, a missing host or a bad resolver is a start-up configuration error', () => {
    const descriptor = registry.require('ens');
    expect(() => createEnsCollector().create(descriptor, depsFor('live'))).toThrow(SourceConfigError);
    expect(() =>
      createEnsCollector({ rpcUrl: 'https://node.example.org/', universalResolver: ENS_FIXTURE_RESOLVER }).create(
        descriptor,
        depsFor('live'),
      ),
    ).toThrow(/OLCYS_SOURCE_HOSTS_ENS/);
    const withHost = { ...descriptor, allowedHosts: ['node.example.org'] };
    expect(() =>
      createEnsCollector({ rpcUrl: 'https://node.example.org/', universalResolver: ENS_FIXTURE_RESOLVER }).create(
        withHost,
        depsFor('live'),
      ),
    ).not.toThrow();
    expect(createDefaultCollectorRegistry({ mode: 'live', env: {} }).get('ens')).toBeUndefined();
    expect(createDefaultCollectorRegistry({ mode: 'offline', env: {} }).get('ens')).toBeDefined();
    expect(
      createDefaultCollectorRegistry({ mode: 'live', env: { ENS_RPC_URL: 'https://node.example.org/' } }).get('ens'),
    ).toBeDefined();
  });

  it('live mode over a fake node: POSTs to the configured URL only; OffchainLookup is never followed', async () => {
    const env = { OLCYS_SOURCE_HOSTS_ENS: 'node.example.org' };
    const live = liveSetup(
      (_url, body) => {
        const method = (JSON.parse(body ?? '{}') as { method?: string }).method;
        if (method === 'eth_blockNumber') return { status: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0x10"}' };
        if (method === 'eth_getBlockByNumber')
          return { status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{"number":"0x10","hash":"0xaa"}}' };
        return {
          status: 200,
          body: '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x556f1830deadbeef"}}',
        };
      },
      ['ens'],
      env,
    );
    const factory = createEnsCollector({
      rpcUrl: 'https://node.example.org/rpc',
      universalResolver: ENS_FIXTURE_RESOLVER,
    });
    const result = await live.run(factory, addressInput('evm:1', A().eth));
    expect(live.sent.every((s) => s.method === 'POST' && s.url === 'https://node.example.org/rpc')).toBe(true);
    expect(live.sent.map((s) => (JSON.parse(s.body ?? '{}') as { method: string }).method)).toEqual([
      'eth_blockNumber',
      'eth_getBlockByNumber',
      'eth_call',
    ]);
    expect(result.notes).toContain('unsupported_input: ccip-read disabled');
    const calls = live.sent.filter((s) => s.body?.includes('eth_call'));
    expect(calls.every((s) => s.body?.includes('"0x10"'))).toBe(true);
  });
});

describe('planner rules pivot.v3 and the persona run', () => {
  const all = ['keybase', 'bitlist', 'ens'];

  it('plans nick → BitList and Keybase, EVM address → ENS, .eth name → ENS', async () => {
    const scope = registry.resolveScope(
      { enabledSources: all, amberJustifications: { bitlist: JUSTIFICATION } },
      'offline',
    );
    const ctx = planner(scope, await testConfig(server));
    const plan = planInitial(
      [
        identifier('nickname', NICK),
        identifier('crypto_address', A().eth, { chain: 'evm:1' }),
        identifier('crypto_address', A().btc, { chain: 'bitcoin' }),
        identifier('nickname', ENS_NAME),
      ],
      ctx,
    );
    expect(plan.rulesVersion).toBe(PIVOT_RULES_VERSION);
    expect(PIVOT_RULES_VERSION).toBe('pivot.v3');
    const rules = plan.tasks.map((t) => `${t.sourceId}:${t.provenance.rule}`).toSorted();
    expect(rules).toContain('keybase:I2');
    expect(rules).toContain('bitlist:I2');
    expect(rules.filter((r) => r === 'ens:I7')).toHaveLength(1);
    expect(rules.filter((r) => r === 'bitlist:I7')).toHaveLength(2);
    expect(rules).toContain('ens:I8');
    // The .eth name is not a Keybase user name and not a BitList nick (dot is allowed there, hyphen too): checked by handle rules.
    expect(plan.tasks.some((t) => t.sourceId === 'keybase' && t.subjectKey.includes('.eth'))).toBe(false);
    expect(plan.tasks.find((t) => t.key === taskKey('ens', `address:evm:1:${A().eth.toLowerCase()}`))).toBeDefined();
  });

  it('the persona run: Keybase and BitList answer "not found", nothing else changes in the links', async () => {
    const scope = registry.resolveScope(
      { enabledSources: all, amberJustifications: { bitlist: JUSTIFICATION } },
      'offline',
    );
    const test = createTestRun(scope);
    const result = await collectCase({
      identifiers: PERSONA_IDENTIFIERS(),
      scope,
      sources: registry,
      ctx: test.ctx,
      config: await testConfig(server),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 2,
    });
    const status = (id: string) => result.tasks.filter((t) => t.sourceId === id).map((t) => t.status);
    expect(status('keybase')).toEqual(['not_found']);
    expect(status('bitlist')).toEqual(['not_found']);
    expect(result.observations.filter((o) => all.includes(o.sourceId))).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it('the test identity: BitList gives a uid that leads to the forum profile (E7); Keybase proofs lead to GitHub (E1)', async () => {
    const scope = registry.resolveScope(
      {
        enabledSources: [...all, 'bitcointalk', 'github'],
        amberJustifications: { bitlist: JUSTIFICATION, bitcointalk: JUSTIFICATION, github: JUSTIFICATION },
      },
      'offline',
    );
    const test = createTestRun(scope);
    const result = await collectCase({
      identifiers: [identifier('nickname', NICK)],
      scope,
      sources: registry,
      ctx: test.ctx,
      config: await testConfig(server),
      robots: test.robots,
      redactor: TEST_REDACTOR,
      maxPivotDepth: 2,
    });
    const bySource = (id: string) => result.tasks.filter((t) => t.sourceId === id);
    expect(bySource('bitlist')[0]?.status).toBe('ok');
    expect(bySource('keybase')[0]?.status).toBe('ok');
    expect(
      bySource('bitcointalk').some((t) => t.provenance.rule === 'E7' && t.subjectKey === 'id:bitcointalk:900201'),
    ).toBe(true);
    // The proven GitHub login was already probed as a same-nick candidate: the E1 follow-up is a recorded duplicate.
    expect(
      [...result.tasks, ...result.skipped].some(
        (t) =>
          t.sourceId === 'github' &&
          t.provenance.rule === 'E1' &&
          t.subjectKey === `handle:github:${TEST_IDENTITY.github}`,
      ),
    ).toBe(true);
    expect(result.observations.some((o) => o.property === 'verification.bitcoin_address' && o.value === A().btc)).toBe(
      true,
    );
  });
});

describe('review fixes', () => {
  it('Keybase carries the discovery method of the task into the account', async () => {
    const found = await fixtureJson('keybase/lookup-olcys_test_ewa.json');
    const method = async (input: CollectorInput) => {
      const { run } = liveSetup(() => ({ status: 200, body: found }), ['keybase']);
      const result = await run(createKeybaseCollector(), input);
      return result.accounts.find((a) => a.platform === 'keybase')?.discoveredVia.method;
    };
    expect(await method(handleInput('keybase', NICK))).toBe('input');
    expect(await method(probeInput(NICK))).toBe('enumeration');
    expect(
      await method({
        identifiers: [],
        accounts: [],
        addresses: [],
        depth: 1,
        values: [{ kind: 'url', value: `https://keybase.io/${NICK}`, method: 'cross_link' }],
      }),
    ).toBe('cross_link');
  });

  it('BitList treats a missing or renamed result list as an unreadable answer, not as not found', async () => {
    for (const body of [
      '{"result":"success","message":null,"data":null}',
      '{"result":"success","message":null,"data":{"total_results":0}}',
      '{"result":"success","message":null,"data":{"total_results":0,"results":[]}}',
    ]) {
      const { run } = liveSetup(() => ({ status: 200, body }), ['bitlist']);
      // oxlint-disable-next-line no-await-in-loop
      expect((await run(createBitlistCollector(), probeInput(NICK))).status).toBe('error');
    }
    expect(() => parseBitlistPosts({ result: 'success', data: { total_results: 0 } })).toThrow(/posts list/);
  });

  it('BitList applies its limit locally and notes it even when the total equals the returned count', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      address: `bc1qsynthetic${i}`,
      coin: 'BTC',
      post_id: i + 1,
      topic_id: 1,
      author: NICK,
      author_uid: 900201,
      title: 't',
      date: '2026-01-01T00:00:00.000Z',
      board_id: 142,
      board_name: 'Polski',
    }));
    const body = JSON.stringify({ result: 'success', message: null, data: { total_results: 3, addresses: items } });
    const { run } = liveSetup(() => ({ status: 200, body }), ['bitlist']);
    const result = await run(createBitlistCollector({ includePosts: false, limit: 2 }), probeInput(NICK));
    expect(values(result, 'archive.post.address')).toEqual(['bc1qsynthetic0', 'bc1qsynthetic1']);
    expect(result.notes).toContain('truncated: 2 of 3');
  });

  it('ENS masks a seed phrase and a private key from a text record everywhere and never stores the raw answer', async () => {
    const wif = createBase58check(sha256).encode(Uint8Array.from([0x80, ...new Uint8Array(32).fill(7), 0x01]));
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const secretText = `${wif} ${phrase}`;
    const zero = new Uint8Array(20);
    const answerFor = (inner: Uint8Array): string =>
      `0x${[
        ...abiEncode([
          { type: 'bytes', value: inner },
          { type: 'address', value: zero },
        ]),
      ]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
    const textAnswer = answerFor(abiEncode([{ type: 'string', value: secretText }]));
    const emptyAnswer = answerFor(abiEncode([{ type: 'address', value: zero }]));
    const live = liveSetup(
      (_url, body) => {
        const method = (JSON.parse(body ?? '{}') as { method?: string }).method;
        const result =
          method === 'eth_blockNumber'
            ? '0x10'
            : method === 'eth_getBlockByNumber'
              ? { number: '0x10', hash: '0xaa' }
              : body?.includes('59d1d43c')
                ? textAnswer
                : emptyAnswer;
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
      },
      ['ens'],
      { OLCYS_SOURCE_HOSTS_ENS: 'node.example.org' },
    );
    live.deps.redactor = createSecretRedactor();
    const factory = createEnsCollector({
      rpcUrl: 'https://node.example.org/rpc',
      universalResolver: ENS_FIXTURE_RESOLVER,
      textKeys: ['description'],
    });
    const result = await live.run(factory, handleInput(undefined, ENS_NAME));
    const everything = JSON.stringify([result, live.test.envelopes, live.test.logs]);
    expect(everything).not.toContain(wif);
    expect(everything).not.toContain('abandon abandon');
    expect(values(result, 'ens.text.description')[0]).toContain('[REDACTED');
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const hexOf = (text: string) =>
      [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
    for (const bytes of live.test.blobs.data.values()) {
      const text = new TextDecoder().decode(bytes);
      expect(text).not.toContain(wif);
      expect(text).not.toContain('abandon abandon');
      expect(text).not.toContain(hexOf(wif));
    }
    // No raw JSON-RPC answer is persisted: provenance keeps hashes only.
    expect(live.test.envelopes.every((e) => e.body.sha256.length === 64)).toBe(true);
    expect(live.test.blobs.data.size).toBeLessThanOrEqual(4);
  });
});
