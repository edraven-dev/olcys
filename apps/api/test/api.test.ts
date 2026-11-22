import type { Capture, Logger } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime, type Stage } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const LOC = 'bitcointalk:u=900001#profile.bitcoin_address';
const walletByRun: string[] = ['bc1qstaryadres', 'bc1qnowyadres'];

/** Stand-in for the collectors: one capture of the profile with the wallet address of this run. */
const fakeCollect: Stage = {
  step: 'collect.source',
  async run(ctx) {
    if (ctx.evidenceRunId !== ctx.run.id) return; // a rescore never collects
    const value = walletByRun.shift() ?? 'bc1qnowyadres';
    const capture: Capture = {
      id: newId(),
      runId: ctx.run.id,
      sourceId: 'bitcointalk',
      url: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001',
      finalUrl: 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001',
      collectedAt: nowIso(),
      collector: 'test',
      clockSynced: true,
      toolVersion: '0.1.0',
      userAgent: 'test',
      httpStatus: 200,
      status: 'ok',
      artifacts: [],
      manifestSha256: '0'.repeat(64),
      fetchIds: [],
    };
    await ctx.repos.evidence.addCaptures([capture]);
    await ctx.repos.evidence.addObservations([
      {
        id: newId(),
        runId: ctx.run.id,
        captureId: capture.id,
        sourceId: 'bitcointalk',
        subject: { type: 'account', key: 'bitcointalk:900001' },
        property: 'profile.bitcoin_address',
        value,
        locator: LOC,
        observedAt: nowIso(),
      },
    ]);
    await ctx.progress({ captures: 1 });
  },
};

const failing: Stage = {
  step: 'score.links',
  async run() {
    throw new Error('scoring exploded');
  },
};

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [fakeCollect],
  });
  app = buildApp(runtime);
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

const newCase = {
  title: 'Kacper Fikcyjny (test)',
  purpose: 'Test na danych syntetycznych',
  legalBasis: 'demonstracja',
  identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
  scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
};

const withSources = (enabledSources: string[], amberJustifications: Record<string, string> = {}) => ({
  ...newCase,
  scope: { ...newCase.scope, enabledSources, amberJustifications },
});

describe('api', () => {
  it('validates and creates cases', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/cases', payload: { title: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_input' });
    const created = await app.inject({ method: 'POST', url: '/api/cases', payload: newCase });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      title: newCase.title,
      identifiers: [{ value: 'fikcyjny_kacper', isAnchor: true }],
    });
    expect((await app.inject('/api/cases')).json().items).toHaveLength(1);
    expect((await app.inject(`/api/cases/${newId()}`)).statusCode).toBe(404);
  });

  it('runs the pipeline twice and reports the swapped wallet', async () => {
    const caseId = (await app.inject('/api/cases')).json().items[0].id as string;
    const first = await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} });
    expect(first.statusCode).toBe(202);
    await runtime.idle();
    const run1 = (await app.inject(`/api/runs/${first.json().id}`)).json();
    expect(run1).toMatchObject({ status: 'succeeded', mode: 'offline', progress: { step: 'run.finish', changes: 0 } });
    expect(run1.config.sourcesConfigSha256).toMatch(/^[0-9a-f]{64}$/);

    const second = await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} });
    await runtime.idle();
    const runId = second.json().id as string;
    expect((await app.inject(`/api/runs/${runId}`)).json()).toMatchObject({
      status: 'succeeded',
      previousRunId: run1.id,
    });
    const changes = (await app.inject(`/api/runs/${runId}/changes`)).json().items;
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'VALUE_CHANGED',
        wallet: true,
        before: 'bc1qstaryadres',
        after: 'bc1qnowyadres',
        key: expect.objectContaining({ locator: LOC }),
      }),
    ]);
    expect((await app.inject(`/api/runs/${runId}/observations`)).json().items).toHaveLength(1);
    expect((await app.inject(`/api/cases/${caseId}/runs`)).json().items).toHaveLength(2);
  });

  it('shows a rescore the evidence of the run that collected it', async () => {
    const caseId = (await app.inject('/api/cases')).json().items[0].id as string;
    const runs = (await app.inject(`/api/cases/${caseId}/runs`)).json().items as { id: string; trigger: string }[];
    const collected = runs.find((r) => r.trigger === 'manual')!.id;
    // The chain analysis of the collecting run (synthetic): its address types are read for the rescore too.
    const types = [
      {
        address: { chain: 'evm:1' as const, address: `0x${'5a'.repeat(20)}` },
        type: 'safe' as const,
        safeMasterCopy: '0x41675c099f32341bf84bfc5382af534df5c7461a',
        fetchIds: [newId(), newId()],
      },
    ];
    await runtime.repos.addressTypes!.add(collected, types);
    const rescore = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/runs`,
      payload: { trigger: 'rescore', rescoreOfRunId: collected },
    });
    expect(rescore.statusCode).toBe(202);
    await runtime.idle();
    const id = rescore.json().id as string;
    const own = (await app.inject(`/api/runs/${collected}/captures`)).json().items as { id: string }[];
    expect(own.length).toBeGreaterThan(0);
    expect((await app.inject(`/api/runs/${id}/captures`)).json().items).toEqual(own);
    expect((await app.inject(`/api/runs/${id}/observations`)).json().items.length).toBeGreaterThan(0);
    expect((await app.inject(`/api/runs/${collected}/address-types`)).json().items).toEqual(types);
    expect((await app.inject(`/api/runs/${id}/address-types`)).json().items).toEqual(types);
    expect((await app.inject(`/api/runs/${newId()}/address-types`)).statusCode).toBe(404);
  });

  it('marks a run failed when a stage throws', async () => {
    const broken = await createRuntime({
      env: {},
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      logger: silent,
      stages: () => [failing],
    });
    const created = await broken.repos.cases.create(newCase as Parameters<typeof broken.repos.cases.create>[0], 'test');
    const run = await broken.startRun(created.id, {});
    await broken.idle();
    expect(await broken.repos.runs.get(run.id)).toMatchObject({ status: 'failed', error: 'scoring exploded' });
  });

  it('answers client errors with 4xx, never 500', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });
    expect(malformed.statusCode).toBe(400);
    expect((await app.inject('/api/cases/not-a-uuid')).statusCode).toBe(404);
    expect((await app.inject('/api/runs/not-a-uuid/links')).statusCode).toBe(404);
    expect((await app.inject('/api/captures/123')).statusCode).toBe(404);
  });

  it('accepts rescores only of runs of the same case', async () => {
    const caseId = (await app.inject('/api/cases')).json().items[0].id as string;
    const other = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
    const runOfOther = (await app.inject({ method: 'POST', url: `/api/cases/${other}/runs`, payload: {} })).json().id;
    await runtime.idle();
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/runs`,
      payload: { trigger: 'rescore', rescoreOfRunId: runOfOther },
    });
    expect(foreign.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/runs`,
      payload: { trigger: 'rescore' },
    });
    expect(missing.statusCode).toBe(400);
    const ownRun = (await app.inject(`/api/cases/${caseId}/runs`)).json().items[0].id as string;
    const upper = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId.toUpperCase()}/runs`,
      payload: { trigger: 'rescore', rescoreOfRunId: ownRun },
    });
    expect(upper.statusCode).toBe(202);
    await runtime.idle();
  });

  it('refuses RED, unknown and unjustified AMBER sources server-side', async () => {
    const sources = (await app.inject('/api/sources')).json().items as { id: string; compliance: string }[];
    const red = sources.find((s) => s.compliance === 'RED')?.id;
    const amber = sources.find((s) => s.compliance === 'AMBER')?.id;
    for (const payload of [withSources([red!]), withSources(['no_such_source']), withSources([amber!])]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await app.inject({ method: 'POST', url: '/api/cases', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_scope' });
    }
    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: withSources([amber!], { [amber!]: 'za krótko' }),
    });
    expect(tooShort.statusCode).toBe(400);
    const justified = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: withSources([amber!], { [amber!]: 'Uzasadnienie sprawy testowej na danych syntetycznych' }),
    });
    expect(justified.statusCode).toBe(201);
  });

  it('lists the source register and serves evidence only as downloads', async () => {
    const sources = (await app.inject('/api/sources')).json().items as { id: string; compliance: string }[];
    expect(sources.find((s) => s.id === 'fixture_site')).toMatchObject({ compliance: 'GREEN' });
    const ref = await runtime.blobs.put(new TextEncoder().encode('<script>alert(1)</script>'), 'text/html');
    const blob = await app.inject(`/api/blobs/${ref.sha256}`);
    expect(blob.headers['content-disposition']).toContain('attachment');
    expect(blob.headers['content-type']).toBe('application/octet-stream');
    expect(blob.headers['content-security-policy']).toContain('sandbox');
    expect((await app.inject('/api/blobs/xyz')).statusCode).toBe(400);
  });
});
