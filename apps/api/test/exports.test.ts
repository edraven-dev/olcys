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
const missing = new Set<string>();
const damaged = new Set<string>();

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
    has: async (sha) => !missing.has(sha) && blobs.has(sha),
    async get(sha) {
      const bytes = await blobs.get(sha);
      return damaged.has(sha) ? new TextEncoder().encode('damaged') : bytes;
    },
  };
  app = buildApp({ ...runtime, blobs: faulty, analyst: ANALYST });
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

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const exported = async () =>
    ((await runtime.repos.custody?.listBySubjects([runId])) ?? []).filter((e) => e.action === 'exported').length;

  it('lists the available exports of the current report', async () => {
    const items = (await app.inject(`/api/runs/${runId}/exports`)).json().items as { format: string }[];
    expect(items.map((i) => i.format)).toEqual([...EXPORT_KINDS]);
    expect((await app.inject(`/api/runs/${newId()}/exports`)).statusCode).toBe(404);
  });

  it('does not record an export for HEAD, a missing blob or a damaged blob', async () => {
    const before = await exported();
    expect((await app.inject({ method: 'HEAD', url: `/api/runs/${runId}/exports/misp` })).statusCode).toBe(200);
    expect(await exported()).toBe(before);

    const items = (await app.inject(`/api/runs/${runId}/exports`)).json().items as { format: string; sha256: string }[];
    const sha = (format: string) => items.find((i) => i.format === format)!.sha256;
    missing.add(sha('csv_links'));
    expect((await app.inject(`/api/runs/${runId}/exports/csv_links`)).statusCode).toBe(404);
    damaged.add(sha('csv_changes'));
    expect((await app.inject(`/api/runs/${runId}/exports/csv_changes`)).statusCode).toBe(500);
    expect(await exported()).toBe(before);
    missing.clear();
    damaged.clear();
  });

  it('offers nothing for a run whose newest HTML report has no matching exports', async () => {
    const sha = (await runtime.blobs.put(new TextEncoder().encode('<p>x</p>'), 'text/html')).sha256;
    await runtime.repos.analysis.addReport({ runId, kind: 'html', blobSha256: sha, mediaType: 'text/html' });
    expect((await app.inject(`/api/runs/${runId}/exports`)).json().items).toEqual([]);
    expect((await app.inject(`/api/runs/${runId}/exports/stix`)).statusCode).toBe(404);
  });
});
