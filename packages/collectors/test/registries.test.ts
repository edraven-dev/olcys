/**
 * Polish public registries (CEIDG, VAT white list, KRS) against synthetic responses in the documented shapes: request
 * URLs and headers, observations, namesake and third-party guards, quotas, the token kept out of every record, the
 * planner rules and an offline run over the fixture site. The network is a fake `fetch` behind the real egress client.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CollectorInput, CollectorResult, FetchMode, Id, SourceId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from '../../../apps/fixture-site/src/fixture-server.ts';
import {
  collectCase,
  createCeidgCollector,
  createCollectorConfig,
  createDefaultCollectorRegistry,
  createKrsCollector,
  createVatWhitelistCollector,
  isValidNip,
  isValidNrb,
  loadSourceRegistry,
  planExpansion,
  planInitial,
  runCollector,
  SourceCircuitBreaker,
  taskKey,
  type CollectorDeps,
  type CollectorFactory,
  type PlannedTask,
  type PlannerContext,
  type SourceRegistry,
} from '../src/index.ts';
import {
  createTestRun,
  demoRegistry,
  identifier,
  PERSONA_IDENTIFIERS,
  startFixture,
  testConfig,
  TEST_REDACTOR,
} from './helpers.ts';
import { syntheticNrb } from './polish-ids.test.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'registries');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const TOKEN = 'TEST-CEIDG-TOKEN-5e4d3c2b';
const NOW = new Date('2026-11-21T23:30:00Z');
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const NIP = '0001234562';
const KRS = '0009999901';

let registry: SourceRegistry;
beforeAll(async () => {
  registry = await demoRegistry();
});

interface Sent {
  url: string;
  headers: Record<string, string>;
}
type Answer = { status: number; body?: string; headers?: Record<string, string> };

function setup(
  answer: (url: string) => Answer | Promise<Answer>,
  options: { mode?: FetchMode; sources?: SourceId[] } = {},
) {
  const mode = options.mode ?? 'live';
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const { status, body, headers } = await answer(url);
    return new Response(status === 204 ? null : (body ?? ''), { status, headers: { ...JSON_TYPE, ...headers } });
  }) as typeof fetch;
  const scope = registry.resolveScope(
    { enabledSources: options.sources ?? ['ceidg', 'vat_whitelist', 'krs'], amberJustifications: {} },
    mode,
  );
  const test = createTestRun(scope, mode, 'run-registries', { fetchImpl });
  const ctx = { ...test.ctx, clock: { now: () => NOW } };
  const deps: CollectorDeps = {
    mode,
    config: createCollectorConfig({ mode, env: { OLCYS_COLLECTOR_NAME: 'test-analyst' } }),
    robots: { check: async () => ({ allowed: true }) },
    breaker: new SourceCircuitBreaker(),
    redactor: TEST_REDACTOR,
  };
  const run = (factory: CollectorFactory, input: CollectorInput): Promise<CollectorResult> =>
    runCollector(factory.create(registry.require(factory.sourceId), deps), input, ctx, scope, deps);
  return { sent, test, run, deps, scope };
}

const nameInput = (name: string): CollectorInput => ({
  identifiers: [identifier('full_name', name)],
  accounts: [],
  addresses: [],
  depth: 0,
});
const valuesInput = (kind: 'nip' | 'regon' | 'krs', ...values: string[]): CollectorInput => ({
  identifiers: [],
  accounts: [],
  addresses: [],
  depth: 1,
  values: values.map((value) => ({ kind, value, method: 'search' as const })),
});
const props = (r: CollectorResult, property: string) => r.observations.filter((o) => o.property === property);
const values = (r: CollectorResult, property: string) => props(r, property).map((o) => o.value);

/** A checksum-valid NIP from nine synthetic digits (leading 000: no tax office assigns it). */
function nipFrom(base: string): string {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = [...base].reduce((n, d, i) => n + Number(d) * (weights[i] ?? 0), 0) % 11;
  return `${base}${sum}`;
}

describe('CEIDG', () => {
  it('searches by first and last name with a Bearer token and emits the NIP and the match count', async () => {
    const { sent, run, test } = setup(async () => ({ status: 200, body: await fixture('ceidg-one.json') }));
    const result = await run(createCeidgCollector({ token: TOKEN }), nameInput('Kacper Fikcyjny'));
    expect(sent.map((s) => s.url)).toEqual([
      'https://dane.biznes.gov.pl/api/ceidg/v3/firmy?imie%5B%5D=Kacper&nazwisko%5B%5D=Fikcyjny&page=1&limit=25',
    ]);
    expect(sent[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(result.status).toBe('ok');
    expect(values(result, 'registry.nip')).toEqual([NIP]);
    expect(values(result, 'registry.ceidg.result_count')).toEqual(['1']);
    expect(values(result, 'registry.business_location')).toEqual(['Fikcyjna 1/2, 00-000 Testowo']);
    expect(props(result, 'registry.ceidg.result_count')[0]?.subject.key).toMatch(/^ceidg-search:[0-9a-f]{64}$/);
    expect(props(result, 'registry.nip')[0]?.subject.key).toBe('ceidg:00000000-0000-4000-8000-000000000001');
    // No property is named like a crypto address, and the business address is a location.
    expect(result.observations.some((o) => /address/.test(o.property))).toBe(false);
    // The token is in no log entry, provenance envelope, capture or stored blob.
    const everything = JSON.stringify([test.logs, test.envelopes, result.captures]);
    expect(everything).not.toContain(TOKEN);
    for (const bytes of test.blobs.data.values()) expect(new TextDecoder().decode(bytes)).not.toContain(TOKEN);
  });

  it('counts namesakes: three firms give count 3 and three NIP observations', async () => {
    const { run } = setup(async () => ({ status: 200, body: await fixture('ceidg-three.json') }));
    const result = await run(createCeidgCollector({ token: TOKEN }), nameInput('Anna Testowa'));
    expect(values(result, 'registry.ceidg.result_count')).toEqual(['3']);
    expect(props(result, 'registry.nip')).toHaveLength(3);
  });

  it('treats HTTP 204 and an empty list as not found', async () => {
    const none = setup(() => ({ status: 204 }));
    const r204 = await none.run(createCeidgCollector({ token: TOKEN }), nameInput('Anna Testowa'));
    expect([r204.status, r204.observations.length]).toEqual(['not_found', 0]);
    const empty = setup(() => ({ status: 200, body: '{"firmy":[],"count":0}' }));
    expect((await empty.run(createCeidgCollector({ token: TOKEN }), nameInput('Anna Testowa'))).status).toBe(
      'not_found',
    );
  });

  it('needs a first and last name, and a token in live mode', async () => {
    const live = setup(() => ({ status: 200, body: '{}' }));
    const withToken = createCeidgCollector({ token: TOKEN }).create(registry.require('ceidg'), live.deps);
    expect(withToken.supports(nameInput('Kacper'))).toBe(false);
    expect(withToken.supports(nameInput('Kacper Fikcyjny'))).toBe(true);
    const noToken = createCeidgCollector().create(registry.require('ceidg'), live.deps);
    expect(noToken.supports(nameInput('Kacper Fikcyjny'))).toBe(false);
    const offline = setup(() => ({ status: 200, body: '{}' }), { mode: 'offline' });
    expect(
      createCeidgCollector().create(registry.require('ceidg'), offline.deps).supports(nameInput('Kacper Fikcyjny')),
    ).toBe(true);
  });

  it('never sends the synthetic persona name to a live registry', async () => {
    const live = setup(() => ({ status: 200, body: '{}' }));
    live.deps.config = createCollectorConfig({
      mode: 'live',
      manifest: { hostPrefixes: {}, syntheticIdentifiers: ['Kacper Fikcyjny'], pages: [] },
    });
    const result = await live.run(createCeidgCollector({ token: TOKEN }), nameInput('Kacper Fikcyjny'));
    expect(live.sent).toEqual([]);
    expect(result.status).toBe('error');
    expect(result.notes.join('\n')).toContain('synthetic_identifier_refused');
  });

  it('reads business contact data of a single match when asked to', async () => {
    const { sent, run } = setup(async (url) => ({
      status: 200,
      body: await fixture(url.includes('/firma/') ? 'ceidg-details.json' : 'ceidg-one.json'),
    }));
    const result = await run(createCeidgCollector({ token: TOKEN, fetchDetails: true }), nameInput('Kacper Fikcyjny'));
    expect(sent[1]?.url).toBe('https://dane.biznes.gov.pl/api/ceidg/v3/firma/00000000-0000-4000-8000-000000000001');
    expect(values(result, 'registry.www')).toEqual(['https://example.org/fikcyjny-uslugi']);
    expect(values(result, 'registry.email')).toEqual(['biuro@example.org']);
    // The phone number is never read.
    expect(result.observations.some((o) => o.value.includes('+48'))).toBe(false);
  });

  it('stops after a rejected token and does not retry', async () => {
    const { sent, run } = setup(() => ({ status: 401, body: '{"message":"Unauthorized"}' }));
    const factory = createCeidgCollector({ token: TOKEN });
    const result = await run(factory, nameInput('Kacper Fikcyjny'));
    expect(result.status).toBe('login_wall');
    expect(sent).toHaveLength(1);
  });
});

describe('VAT white list', () => {
  it('looks a NIP up for the Warsaw date and emits bank accounts without any PESEL', async () => {
    const { sent, run } = setup(async () => ({ status: 200, body: await fixture('vat-subject.json') }));
    const result = await run(createVatWhitelistCollector(), valuesInput('nip', NIP));
    expect(sent.map((s) => s.url)).toEqual([
      `https://wykazpodatnikowvat.mf.gov.pl/api/search/nip/${NIP}?date=2026-11-22`,
    ]);
    expect(result.status).toBe('ok');
    const accounts = values(result, 'registry.bank_account');
    expect(accounts).toEqual(['25000000000000000000010001', '95000000000000000000010002']);
    expect(accounts.every(isValidNrb)).toBe(true);
    expect(result.notes.join('\n')).toContain('not a valid NRB');
    expect(values(result, 'registry.vat_request_id')).toEqual(['olcys-test0001']);
    expect(values(result, 'registry.vat_status')).toEqual(['Czynny']);
    expect(values(result, 'registry.has_virtual_accounts')).toEqual(['false']);
    expect(values(result, 'registry.krs')).toEqual([KRS]);
    for (const pesel of ['77777777770', '77777777771', '77777777772']) {
      expect(result.observations.some((o) => o.value.includes(pesel) || o.locator.includes('pesel'))).toBe(false);
    }
    expect(result.observations.some((o) => /pesel/i.test(o.property))).toBe(false);
  });

  it('removes PESEL values from the stored body and records it', async () => {
    const { run, test } = setup(async () => ({ status: 200, body: await fixture('vat-subject.json') }));
    const result = await run(createVatWhitelistCollector(), valuesInput('nip', NIP));
    const stored = [...test.blobs.data.values()].map((b) => new TextDecoder().decode(b)).join('\n');
    for (const pesel of ['77777777770', '77777777771', '77777777772']) expect(stored).not.toContain(pesel);
    expect(stored).toContain('Przykładowy');
    expect(result.captures[0]?.technical?.transformations.join('\n')).toContain('PESEL removed before storage');
    expect(values(result, 'registry.vat_request_id')).toEqual(['olcys-test0001']);
    expect(values(result, 'registry.bank_account')).toHaveLength(2);
  });

  it('records third parties as name and role only', async () => {
    const { run } = setup(async () => ({ status: 200, body: await fixture('vat-subject.json') }));
    const result = await run(createVatWhitelistCollector(), valuesInput('nip', NIP));
    expect(values(result, 'registry.representative')).toEqual([
      'Jan Przykładowy — reprezentant',
      'Ewa Testowa — prokurent',
    ]);
    expect(values(result, 'registry.partner')).toEqual(['Spółka Testowa — wspólnik']);
    // The home address of a sole proprietor is not read; a company seat (with a KRS number) is.
    expect(values(result, 'registry.business_location')).toEqual(['Fikcyjna 1, 00-000 Testowo']);
  });

  it('uses the date in Europe/Warsaw, not UTC', async () => {
    const { sent, run } = setup(async () => ({ status: 200, body: await fixture('vat-subject.json') }));
    await run(createVatWhitelistCollector(), valuesInput('regon', '001234562'));
    expect(sent[0]?.url).toBe('https://wykazpodatnikowvat.mf.gov.pl/api/search/regon/001234562?date=2026-11-22');
  });

  it('skips invalid checksums without a request', async () => {
    const { sent, run, deps } = setup(() => ({ status: 200, body: '{}' }));
    const collector = createVatWhitelistCollector().create(registry.require('vat_whitelist'), deps);
    expect(collector.supports(valuesInput('nip', '0001234563'))).toBe(false);
    expect(collector.supports(valuesInput('regon', '001234563'))).toBe(false);
    const result = await run(createVatWhitelistCollector(), valuesInput('nip', '0001234563'));
    expect([sent.length, result.status]).toEqual([0, 'error']);
  });

  it('caps the searches of a run and stops on HTTP 429', async () => {
    const nips = ['000123457', '000123458', '000123459'].map(nipFrom).filter(isValidNip);
    expect(nips).toHaveLength(3);
    const capped = setup(async () => ({ status: 200, body: await fixture('vat-subject.json') }));
    const result = await capped.run(
      createVatWhitelistCollector({ maxSearchCallsPerRun: 2 }),
      valuesInput('nip', ...nips),
    );
    expect(capped.sent).toHaveLength(2);
    expect(result.notes.join('\n')).toMatch(/truncated: search limit of 2 calls/);

    const limited = setup(() => ({ status: 429, body: '{"code":"WL-429"}', headers: { 'retry-after': '60' } }));
    const blocked = await limited.run(createVatWhitelistCollector(), valuesInput('nip', ...nips));
    expect(blocked.status).toBe('blocked');
    expect(blocked.notes.join('\n')).toContain('rate_limited');
    expect(limited.sent).toHaveLength(1);
  });

  it('treats a documented quota error as blocked and an empty subject as not found', async () => {
    const quota = setup(() => ({ status: 400, body: '{"code":"WL-999","message":"Przekroczono limit zapytań"}' }));
    const blocked = await quota.run(createVatWhitelistCollector(), valuesInput('nip', NIP));
    expect(blocked.status).toBe('blocked');
    const unknown = setup(() => ({ status: 200, body: '{"result":{"subject":null,"requestId":"x"}}' }));
    expect((await unknown.run(createVatWhitelistCollector(), valuesInput('nip', NIP))).status).toBe('not_found');
  });

  it('never contacts the previous API host (config)', async () => {
    const sources = await loadSourceRegistry();
    expect(sources.require('vat_whitelist').allowedHosts).toEqual(['wykazpodatnikowvat.mf.gov.pl']);
    for (const source of sources.list()) expect(source.allowedHosts).not.toContain('wl-api.mf.gov.pl');
    expect(sources.require('ceidg').rateLimit).toEqual({ requests: 1, perSeconds: 4 });
    const yaml = await readFile(resolve(import.meta.dirname, '..', '..', '..', 'config', 'sources.yaml'), 'utf8');
    expect(yaml).not.toContain('wl-api.mf.gov.pl');
  });
});

describe('KRS', () => {
  it('pads the number, retries the second register after a 404 and records board members as name and role', async () => {
    const { sent, run } = setup(async (url) =>
      url.includes('rejestr=P')
        ? { status: 404, body: '{"message":"not found"}' }
        : { status: 200, body: await fixture('krs-extract.json') },
    );
    const result = await run(createKrsCollector(), valuesInput('krs', '9999901'));
    expect(sent.map((s) => s.url)).toEqual([
      `https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${KRS}?rejestr=P&format=json`,
      `https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${KRS}?rejestr=S&format=json`,
    ]);
    expect(values(result, 'registry.krs')).toEqual([KRS]);
    expect(values(result, 'registry.nip')).toEqual([NIP]);
    expect(values(result, 'registry.representative')).toEqual([
      'JAN PRZYKŁADOWY — PREZES ZARZĄDU',
      'EWA TESTOWA — prokurent',
    ]);
    expect(values(result, 'registry.partner')).toEqual(['HOLDING TESTOWY — wspólnik']);
    expect(values(result, 'registry.business_location')).toEqual(['FIKCYJNA 1/2, 00-000 TESTOWO']);
    expect(result.observations.some((o) => o.value.includes('77777777771') || /pesel/i.test(o.locator))).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('reports the maintenance page (HTTP 200, HTML) as an error and does not try the other register', async () => {
    const { sent, run } = setup(async () => ({
      status: 200,
      body: await fixture('krs-maintenance.html'),
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const result = await run(createKrsCollector(), valuesInput('krs', KRS));
    expect(result.status).toBe('error');
    expect(result.notes.join('\n')).toContain('KRS API maintenance');
    expect(result.observations).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('says not found when neither register has the number', async () => {
    const { sent, run } = setup(() => ({ status: 404, body: '{}' }));
    const result = await run(createKrsCollector(), valuesInput('krs', KRS));
    expect([result.status, sent.length]).toEqual(['not_found', 2]);
  });
});

const ids = (mode: FetchMode, env: Record<string, string>) =>
  createDefaultCollectorRegistry({ mode, env })
    .list()
    .map((f) => f.sourceId);

describe('registration', () => {
  it('does not register CEIDG in a live run without its token, and registers it with one', () => {
    expect(ids('live', {})).not.toContain('ceidg');
    expect(ids('live', { CEIDG_API_TOKEN: '  ' })).not.toContain('ceidg');
    expect(ids('live', { CEIDG_API_TOKEN: TOKEN })).toContain('ceidg');
    expect(ids('live', {})).toEqual(expect.arrayContaining(['vat_whitelist', 'krs']));
    // Offline and replay read the synthetic fixture site: no token needed.
    expect(ids('offline', {})).toContain('ceidg');
    expect(ids('replay', {})).toContain('ceidg');
  });
});

function plannerContext(sources: SourceId[] = ['ceidg', 'vat_whitelist', 'krs']): {
  ctx: PlannerContext;
  test: ReturnType<typeof setup>;
} {
  const test = setup(() => ({ status: 200, body: '{}' }), { mode: 'offline', sources });
  const reg = createDefaultCollectorRegistry({ mode: 'offline' });
  const ctx: PlannerContext = {
    scope: test.scope,
    factories: reg.list(),
    collectors: reg.forScope(test.scope, registry, test.deps),
    known: new Set(),
    maxPivotDepth: 2,
    maxTasks: 40,
    counter: { planned: 0 },
    watchList: [],
    fixture: test.deps.config.fixture,
  };
  return { ctx, test };
}

const task = (ctx: PlannerContext, sourceId: SourceId, subjectKey: string): PlannedTask => ({
  key: taskKey(sourceId, subjectKey),
  sourceId,
  platform: sourceId,
  subjectKey,
  depth: 0,
  input: { identifiers: [], accounts: [], addresses: [], depth: 0 },
  provenance: { reason: 'input_identifier', rule: 'I6' },
});

const result = (observations: [string, string][]): CollectorResult => ({
  status: 'ok',
  captures: [],
  accounts: [],
  notes: [],
  observations: observations.map(([property, value], i) => ({
    id: `obs-${i}` as Id,
    runId: 'run' as Id,
    captureId: 'cap' as Id,
    sourceId: 'ceidg',
    subject: { type: 'page' as const, key: 'ceidg:x' },
    property,
    value,
    locator: `ceidg:x#${property}`,
    observedAt: '2026-11-22T10:00:00.000Z',
  })),
});

describe('pivot rules', () => {
  it('plans CEIDG for a full name (I6) and nothing for a nick', () => {
    const { ctx } = plannerContext();
    const plan = planInitial(
      [identifier('full_name', 'Kacper Fikcyjny'), identifier('nickname', 'fikcyjny_kacper')],
      ctx,
    );
    expect(plan.tasks.filter((t) => t.sourceId === 'ceidg').map((t) => [t.subjectKey, t.provenance.rule])).toEqual([
      ['name:kacper fikcyjny', 'I6'],
    ]);
  });

  it('follows a CEIDG NIP to the VAT white list only for a single match (E4)', () => {
    const { ctx } = plannerContext();
    const parent = task(ctx, 'ceidg', 'name:kacper fikcyjny');
    const single = planExpansion(
      parent,
      result([
        ['registry.ceidg.result_count', '1'],
        ['registry.nip', NIP],
      ]),
      ctx,
    );
    expect(single.tasks.map((t) => [t.sourceId, t.subjectKey, t.depth, t.input.values?.[0]?.kind])).toEqual([
      ['vat_whitelist', `nip:${NIP}`, 1, 'nip'],
    ]);
    expect(single.tasks[0]?.provenance.rule).toBe('E4');

    const { ctx: other } = plannerContext();
    const ambiguous = planExpansion(
      task(other, 'ceidg', 'name:anna testowa'),
      result([
        ['registry.ceidg.result_count', '3'],
        ['registry.nip', NIP],
        ['registry.nip', '0000000001'],
        ['registry.nip', '0000000002'],
      ]),
      other,
    );
    expect(ambiguous.tasks).toEqual([]);
    expect(ambiguous.skipped.map((s) => [s.sourceId, s.skip, s.subjectKey])).toEqual([
      ['vat_whitelist', 'ambiguous_namesake', 'ceidg-namesakes:3'],
    ]);
  });

  it('follows the KRS number of a white-list entry (E5) and never a third party', () => {
    const { ctx } = plannerContext();
    const parent = task(ctx, 'vat_whitelist', `nip:${NIP}`);
    const plan = planExpansion(
      parent,
      result([
        ['registry.krs', KRS],
        ['registry.representative', 'Jan Przykładowy — reprezentant'],
        ['registry.partner', 'Spółka Testowa — wspólnik'],
        ['registry.bank_account', syntheticNrb()],
      ]),
      ctx,
    );
    expect(plan.tasks.map((t) => [t.sourceId, t.subjectKey, t.input.values?.[0]?.kind])).toEqual([
      ['krs', `krs:${KRS}`, 'krs'],
    ]);
    expect(plan.tasks[0]?.input.identifiers).toEqual([]);
  });

  it('skips registries that the case does not enable', () => {
    const { ctx } = plannerContext(['vat_whitelist']);
    const plan = planInitial([identifier('full_name', 'Kacper Fikcyjny')], ctx);
    expect(plan.tasks).toEqual([]);
    expect(plan.skipped.map((s) => [s.sourceId, s.skip])).toContainEqual(['ceidg', 'source_not_enabled']);
  });
});

describe('offline run over the fixture site', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixture('v1');
  });
  afterAll(async () => {
    await server.close();
  });

  it('finds the persona firm in CEIDG and follows its NIP to the white list without a token', async () => {
    const scope = registry.resolveScope(
      { enabledSources: ['ceidg', 'vat_whitelist', 'krs'], amberJustifications: {} },
      'offline',
    );
    const test = createTestRun(scope, 'offline', 'run-offline');
    const config = await testConfig(server);
    const collected = await collectCase({
      identifiers: PERSONA_IDENTIFIERS().filter((i) => i.kind === 'full_name'),
      scope,
      sources: registry,
      ctx: test.ctx,
      config,
      robots: { check: async () => ({ allowed: true }) },
      redactor: TEST_REDACTOR,
      maxPivotDepth: 2,
      env: { OLCYS_SEARCH_MODE: 'off' },
    });
    expect(
      collected.tasks.filter((t) => t.sourceId !== 'fixture_site').map((t) => [t.sourceId, t.subjectKey, t.status]),
    ).toEqual([
      ['ceidg', 'name:kacper fikcyjny', 'ok'],
      ['vat_whitelist', `nip:${NIP}`, 'ok'],
    ]);
    const get = (property: string) => collected.observations.filter((o) => o.property === property).map((o) => o.value);
    expect(get('registry.nip')).toEqual([NIP, NIP]);
    expect(get('registry.ceidg.result_count')).toEqual(['1']);
    expect(get('registry.bank_account')).toEqual(['25000000000000000000010001', '95000000000000000000010002']);
    expect(get('registry.vat_request_id')).toHaveLength(1);
    // The persona has no KRS entry: nothing to follow, nothing requested from the court register.
    expect(collected.tasks.some((t) => t.sourceId === 'krs')).toBe(false);
    // Offline requests carry no token header and no Authorization at all.
    expect(JSON.stringify(test.logs)).not.toMatch(/authorization/i);
  });
});
