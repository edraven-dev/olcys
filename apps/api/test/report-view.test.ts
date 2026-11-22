import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { buildReportData, EXPORT_KINDS, renderReport, storeReport } from '@olcys/reporting';
import { createRuntime, type Runtime } from '@olcys/worker';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ANALYST, newCase, silent } from './analyst-fixtures.ts';

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let runId: string;

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [],
  });
  app = buildApp({
    ...runtime,
    analyst: ANALYST,
    llm: { enabled: false },
    settings: {
      llm: { baseUrl: 'http://user:secret@127.0.0.1:2140/v3?key=abc', model: 'qwen-test' },
      extractorVersion: 'x.1',
      env: { DO_NOT_TRACK: '1', HF_HUB_OFFLINE: '0', LLM_API_KEY: 'sk-never-shown' },
    },
  });
  const caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
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
    const html = (await app.inject(`/api/runs/${runId}/report`)).body;
    const data = (await app.inject(`/api/runs/${runId}/report/data`)).json();
    expect(renderReport(data)).toBe(html);
    expect(view.report.reportId).toBe(data.reportId);
  });

  it('answers 404 for a run without a report and for unknown ids', async () => {
    expect((await app.inject(`/api/runs/01900000-0000-7000-8000-00000000dead/report/view`)).statusCode).toBe(404);
    expect((await app.inject(`/api/runs/not-an-id/report/view`)).statusCode).toBe(404);
    expect((await app.inject(`/api/runs/not-an-id/report/data`)).statusCode).toBe(404);
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
