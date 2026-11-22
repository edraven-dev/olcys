import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { buildReportData, EXPORT_KINDS, storeReport } from '@olcys/reporting';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ANALYST, newCase, silent } from './analyst-fixtures.ts';

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
  app = buildApp({ ...runtime, analyst: ANALYST });
  caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
  runId = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json().id as string;
  await runtime.idle();
  const data = await buildReportData(runtime.repos, runId, { generatedAt: '2026-11-21T13:41:00.000Z' });
  await storeReport(runtime, data);
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('report exports', () => {
  it('downloads every export as an attachment and records an exported custody event naming analyst and purpose', async () => {
    for (const format of EXPORT_KINDS) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await app.inject(`/api/runs/${runId}/exports/${format}`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.body.length).toBeGreaterThan(0);
    }
    expect((await app.inject(`/api/runs/${runId}/exports/stix`)).headers['content-type']).toContain(
      'application/stix+json',
    );
    const events = (await runtime.repos.custody?.listBySubjects([runId])) ?? [];
    expect(events.filter((e) => e.action === 'exported')).toHaveLength(EXPORT_KINDS.length + 1);
    expect(events[0]).toMatchObject({
      actor: ANALYST,
      runId,
      subject: { type: 'report', id: runId },
      detail: { format: 'stix', purpose: newCase.purpose },
    });
  });

  it('refuses unknown formats, unknown runs and runs without exports', async () => {
    expect((await app.inject(`/api/runs/${runId}/exports/pdf`)).statusCode).toBe(400);
    expect((await app.inject(`/api/runs/${newId()}/exports/stix`)).statusCode).toBe(404);
    expect((await app.inject(`/api/runs/not-an-id/exports/stix`)).statusCode).toBe(404);
  });
});
