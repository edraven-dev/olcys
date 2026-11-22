import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { buildReportData, EXPORT_KINDS, renderReport, storeReport } from '@olcys/reporting';
import { createRuntime, type Runtime } from '@olcys/worker';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ANALYST, newCase, silent } from './analyst-fixtures.ts';

const damaged = new Set<string>();
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let runId: string;
let caseId: string;

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [],
  });
  const blobs = runtime.blobs;
  const faulty: typeof blobs = {
    ...blobs,
    put: (bytes, mediaType) => blobs.put(bytes, mediaType),
    has: (sha) => blobs.has(sha),
    async get(sha) {
      if (damaged.has(sha)) return new TextEncoder().encode('{damaged');
      return blobs.get(sha);
    },
  };
  app = buildApp({
    ...runtime,
    blobs: faulty,
    analyst: ANALYST,
    llm: { enabled: false },
    settings: {
      llm: { baseUrl: 'http://user:secret@127.0.0.1:2140/v3?key=abc', model: 'qwen-test' },
      extractorVersion: 'x.1',
      env: { DO_NOT_TRACK: '1', HF_HUB_OFFLINE: '0', LLM_API_KEY: 'sk-never-shown' },
    },
  });
  caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
  runId = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json().id as string;
  await runtime.idle();
  await storeReport(runtime, await buildReportData(runtime.repos, runId, { generatedAt: '2026-11-21T13:41:00.000Z' }));
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('report view', () => {
  it('serves the report model and the files with digests that match the served bytes', async () => {
    const response = await app.inject(`/api/runs/${runId}/report/view`);
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.report).toMatchObject({ runId, language: 'pl' });
    expect(view.report.reproducibility.dataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(view.report.facts)).toBe(true);
    const kinds = view.files.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['html', 'pdf', 'manifest', ...EXPORT_KINDS]));
    expect(view.files.find((f: { kind: string }) => f.kind === 'pdf')).toMatchObject({ available: false });
    for (const file of view.files.filter((f: { available: boolean }) => f.available)) {
      // oxlint-disable-next-line no-await-in-loop
      const served = await app.inject(file.path);
      expect(served.statusCode).toBe(200);
      expect(sha256(served.body)).toBe(file.sha256);
      expect(served.rawPayload.length).toBe(file.bytes);
    }
  });

  it('builds the model from the same data as the HTML renderer', async () => {
    const view = (await app.inject(`/api/runs/${runId}/report/view`)).json();
    const path = (kind: string) => view.files.find((f: { kind: string }) => f.kind === kind).path as string;
    const data = (await app.inject(path('manifest'))).json();
    expect(renderReport(data)).toBe((await app.inject(path('html'))).body);
    expect(view.report.reportId).toBe(data.reportId);
    expect(view.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds every listed link to the listed version: a later regeneration changes nothing', async () => {
    const view = (await app.inject(`/api/runs/${runId}/report/view`)).json();
    const before = new Map<string, string>();
    for (const file of view.files.filter((f: { available: boolean }) => f.available)) {
      // oxlint-disable-next-line no-await-in-loop
      before.set(file.path, (await app.inject(file.path)).body);
    }
    await storeReport(
      runtime,
      await buildReportData(runtime.repos, runId, { generatedAt: '2026-11-22T08:00:00.000Z' }),
    );
    const after = (await app.inject(`/api/runs/${runId}/report/view`)).json();
    expect(after.version).not.toBe(view.version);
    for (const [path, body] of before) {
      // oxlint-disable-next-line no-await-in-loop
      const served = await app.inject(path);
      expect(served.statusCode).toBe(200);
      expect(sha256(served.body)).toBe(sha256(body));
    }
  });

  it('does not list a version that is only partly published, and refuses foreign versions', async () => {
    const view = (await app.inject(`/api/runs/${runId}/report/view`)).json();
    const html = await runtime.blobs.put(new TextEncoder().encode('<p>nowy</p>'), 'text/html');
    await runtime.repos.analysis.addReport({ runId, kind: 'html', blobSha256: html.sha256, mediaType: 'text/html' });
    expect((await app.inject(`/api/runs/${runId}/report/view`)).statusCode).toBe(404);
    // the earlier complete version stays downloadable through its own links
    expect((await app.inject(view.files[0].path)).statusCode).toBe(200);
    const foreign = view.files[0].path.replace(runId, '01900000-0000-7000-8000-00000000dead');
    expect((await app.inject(foreign)).statusCode).toBe(404);
    const unknown = view.files[0].path.replace(view.version, 'f'.repeat(64));
    expect((await app.inject(unknown)).statusCode).toBe(404);
    expect((await app.inject(view.files[0].path.replace(view.version, 'x'))).statusCode).toBe(404);
  });

  it('answers 500 for a stored report that cannot be read and 404 only when no report row exists', async () => {
    const other = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json()
      .id as string;
    await runtime.idle();
    expect((await app.inject(`/api/runs/${other}/report/view`)).statusCode).toBe(404);
    await storeReport(
      runtime,
      await buildReportData(runtime.repos, other, { generatedAt: '2026-11-21T13:41:00.000Z' }),
    );
    const set = await runtime.repos.analysis.latestReport(other, 'export_set');
    const stored = JSON.parse(new TextDecoder().decode(await runtime.blobs.get(set?.blobSha256 ?? ''))) as {
      dataSha256: string;
    };
    expect((await app.inject(`/api/runs/${other}/report/view`)).statusCode).toBe(200);
    damaged.add(stored.dataSha256);
    expect((await app.inject(`/api/runs/${other}/report/view`)).statusCode).toBe(500);
    damaged.clear();
  });

  it('answers 404 for a run without a report and for unknown ids', async () => {
    expect((await app.inject(`/api/runs/01900000-0000-7000-8000-00000000dead/report/view`)).statusCode).toBe(404);
    expect((await app.inject(`/api/runs/not-an-id/report/view`)).statusCode).toBe(404);
  });
});

describe('download purpose', () => {
  const purpose = 'Przekazanie do akt sprawy kontrolnej';
  const stixPath = async () => {
    const view = (await app.inject(`/api/runs/${runId}/report/view`)).json();
    return view.files.find((f: { kind: string }) => f.kind === 'stix').path as string;
  };
  beforeAll(async () => {
    await storeReport(
      runtime,
      await buildReportData(runtime.repos, runId, { generatedAt: '2026-11-23T08:00:00.000Z' }),
    );
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('records the stated purpose in the access log and the custody event, never deduplicating downloads', async () => {
    const path = await stixPath();
    const headers = { 'x-olcys-purpose': encodeURIComponent(purpose) };
    expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
    expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
    await tick();
    const rows =
      (await runtime.repos.accessLog?.list({ limit: 500 }))?.filter((r) => r.resource.endsWith('#stix')) ?? [];
    expect(rows.filter((r) => r.purpose === purpose)).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'export.download', runId, outcome: 'ok' });
    const events = (await runtime.repos.custody?.listBySubjects([runId])) ?? [];
    expect(events.some((e) => e.action === 'exported' && e.detail?.['purpose'] === purpose)).toBe(true);
  });

  it('downloads without a purpose; the custody event then carries the case purpose', async () => {
    const path = await stixPath();
    const before = ((await runtime.repos.custody?.listBySubjects([runId])) ?? []).length;
    expect((await app.inject(path)).statusCode).toBe(200);
    expect((await app.inject(path.replace('/stix', '/html'))).statusCode).toBe(200);
    await tick();
    const events = (await runtime.repos.custody?.listBySubjects([runId])) ?? [];
    expect(events.length).toBe(before + 1);
    const last = events.at(-1);
    expect(last?.detail?.['purpose']).not.toBe(purpose);
    const rows = (await runtime.repos.accessLog?.list({ limit: 500 })) ?? [];
    expect(rows.some((r) => r.resource.endsWith('#html') && r.purpose === undefined)).toBe(true);
  });
});

describe('meta settings', () => {
  it('shows the model host only, the telemetry opt-outs and never a secret', async () => {
    const response = await app.inject('/api/meta');
    const meta = response.json();
    expect(meta.llm).toEqual({ enabled: false, baseUrlHost: '127.0.0.1:2140', model: 'qwen-test' });
    expect(meta.extractorVersion).toBe('x.1');
    expect(meta.telemetryOptOuts).toEqual(
      expect.arrayContaining([
        { name: 'DO_NOT_TRACK', set: true },
        { name: 'HF_HUB_OFFLINE', set: false },
      ]),
    );
    expect(meta.scoring.weightsStatus).toBe('uncalibrated');
    for (const secret of ['secret', 'sk-never-shown', 'key=abc', 'user:']) expect(response.body).not.toContain(secret);
  });
});
