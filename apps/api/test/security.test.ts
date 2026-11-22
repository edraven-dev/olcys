/** Security headers, the report CSP, the access log and log redaction. Fastify's inject, in-memory store. */
import { createHash } from 'node:crypto';
import type { Capture } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { buildReportData, storeReport } from '@olcys/reporting';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PERMISSIONS_POLICY } from '../src/security.ts';
import { ANALYST, newCase, silent } from './analyst-fixtures.ts';

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let tlsApp: ReturnType<typeof buildApp>;
let caseId: string;
let runId: string;
const logLines: string[] = [];

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
    httpLog: true,
    logStream: { write: (line) => void logLines.push(line) },
  });
  tlsApp = buildApp({ ...runtime, analyst: ANALYST, hsts: true });
  caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
  runId = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json().id as string;
  await runtime.idle();
  await storeReport(runtime, await buildReportData(runtime.repos, runId, { generatedAt: '2026-11-21T13:41:00.000Z' }));
});
afterAll(async () => {
  await app.close();
  await tlsApp.close();
  await runtime.close();
});

describe('security headers', () => {
  it('sets a strict CSP and the hardening headers on JSON responses, also on errors', async () => {
    for (const url of ['/api/health', '/api/cases', '/api/cases/not-a-uuid', '/nope']) {
      // oxlint-disable-next-line no-await-in-loop
      const { headers } = await app.inject(url);
      expect(headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('adds HSTS only when switched on for TLS', async () => {
    expect((await tlsApp.inject('/api/health')).headers['strict-transport-security']).toMatch(/^max-age=\d+/);
  });

  it('keeps stricter CSPs of stored blobs', async () => {
    const response = await app.inject(`/api/blobs/${'0'.repeat(64)}`);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('lets the report render: its inline styles are allowed by hash, scripts never', async () => {
    const response = await app.inject(`/api/runs/${runId}/report`);
    expect(response.statusCode).toBe(200);
    const csp = response.headers['content-security-policy'] as string;
    const styles = [...response.body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
    expect(styles.length).toBeGreaterThan(0);
    for (const m of styles) {
      expect(csp).toContain(
        `'sha256-${createHash('sha256')
          .update(m[1] ?? '')
          .digest('base64')}'`,
      );
    }
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response.body).not.toMatch(/<script\b/i);
    expect(response.body).not.toMatch(/\sstyle\s*=/i);
  });
});

describe('access log', () => {
  it('records who viewed a case, run, report and export, with the purpose and the outcome', async () => {
    await app.inject(`/api/cases/${caseId}`);
    await app.inject(`/api/runs/${runId}/report`);
    await app.inject({
      url: `/api/runs/${runId}/exports/csv`,
      headers: { 'x-olcys-purpose': 'przekazanie do kontroli' },
    });
    await app.inject(`/api/cases/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`);
    // The log is written after the response; give the hooks a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { items } = (await app.inject(`/api/access-log?caseId=${caseId}`)).json();
    const actions = items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['case.view', 'report.view']));
    const caseView = items.find((e: { action: string }) => e.action === 'case.view');
    expect(caseView).toMatchObject({ actor: ANALYST, caseId, outcome: 'ok' });
    expect(caseView.purpose).toBeUndefined();
    const report = items.find((e: { action: string }) => e.action === 'report.view');
    expect(report).toMatchObject({ runId, caseId, outcome: 'ok' });
    const exp = items.find((e: { action: string }) => e.action === 'export.download');
    expect(exp).toMatchObject({
      runId,
      purpose: 'przekazanie do kontroli',
      resource: '/api/runs/:runId/exports/:format#csv',
    });
  });

  it('does not log writes, and records a failed read as such', async () => {
    const before = (await runtime.repos.accessLog!.list({ limit: 500 })).length;
    await app.inject({ method: 'POST', url: '/api/cases', payload: newCase });
    await app.inject(`/api/runs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const all = await runtime.repos.accessLog!.list({ limit: 500 });
    expect(all.length).toBe(before + 1);
    expect(all[0]).toMatchObject({ action: 'run.view', outcome: 'failed' });
  });

  it('validates the query of the read endpoint', async () => {
    expect((await app.inject('/api/access-log?caseId=x')).statusCode).toBe(400);
    expect((await app.inject('/api/access-log?limit=0')).statusCode).toBe(400);
  });
});

describe('request log', () => {
  it('redacts credentials and drops query strings', async () => {
    logLines.length = 0;
    await app.inject({
      url: '/api/cases?q=fikcyjny_kacper',
      headers: { authorization: 'Bearer sekret-token-123', cookie: 'olcys_session=sekret-cookie-456' },
    });
    const text = logLines.join('');
    expect(text).toContain('/api/cases');
    expect(text).not.toContain('sekret-token-123');
    expect(text).not.toContain('sekret-cookie-456');
    expect(text).not.toContain('fikcyjny_kacper');
  });
});

describe('access log actor', () => {
  it('is the fixed local actor when no analyst is configured', async () => {
    const plain = buildApp({ ...runtime });
    await plain.inject(`/api/cases/${caseId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [latest] = await runtime.repos.accessLog!.list({ caseId, limit: 1 });
    expect(latest).toMatchObject({ actor: 'local', action: 'case.view' });
    await plain.close();
  });
});

describe('access log dedupe window', () => {
  it('logs polling once per window, and every export download', async () => {
    let clock = 1_000_000;
    const polled = buildApp({
      ...runtime,
      analyst: 'poller',
      accessLog: { dedupeWindowMs: 60_000, nowMs: () => clock },
    });
    const rows = async (action: string) =>
      (await runtime.repos.accessLog!.list({ actor: 'poller', limit: 500 })).filter((e) => e.action === action).length;
    await polled.inject(`/api/runs/${runId}`);
    await polled.inject(`/api/runs/${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rows('run.view')).toBe(1);
    clock += 61_000;
    await polled.inject(`/api/runs/${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rows('run.view')).toBe(2);
    await polled.inject(`/api/runs/${runId}/exports/csv`);
    await polled.inject(`/api/runs/${runId}/exports/csv`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rows('export.download')).toBe(2);
    await polled.close();
  });
});

const captureOf = (): Capture => ({
  id: newId(),
  runId,
  sourceId: 'fixture_site',
  url: 'https://forum.example.test/profile/fikcyjny_kacper',
  finalUrl: 'https://forum.example.test/profile/fikcyjny_kacper',
  collectedAt: '2026-11-21T10:00:00.000Z',
  collector: 'test',
  clockSynced: true,
  toolVersion: '0.0.0',
  userAgent: 'test',
  httpStatus: 200,
  status: 'ok',
  artifacts: [],
  manifestSha256: '0'.repeat(64),
  fetchIds: [],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('access log evidence identity, failures and purpose', () => {
  it('tells captures apart within the dedupe window and resolves their run and case', async () => {
    const [a, b] = [captureOf(), captureOf()] as [Capture, Capture];
    await runtime.repos.evidence.addCaptures([a, b]);
    const reader = buildApp({ ...runtime, analyst: 'capture-reader' });
    await Promise.all([a, b].map((c) => reader.inject(`/api/captures/${c.id}`)));
    await reader.inject(`/api/captures/${a.id}`);
    await tick();
    const rows = await runtime.repos.accessLog!.list({ actor: 'capture-reader', limit: 50 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.resource).toSorted()).toEqual(
      [`/api/captures/:captureId#${a.id}`, `/api/captures/:captureId#${b.id}`].toSorted(),
    );
    expect(rows[0]).toMatchObject({ runId, caseId, action: 'evidence.view' });
    await reader.close();
  });

  it('records the next read after a failed write', async () => {
    const real = runtime.repos.accessLog!;
    let failures = 1;
    const flaky = {
      ...real,
      async add(entry: Parameters<typeof real.add>[0]) {
        if (failures-- > 0) throw new Error('store down');
        return real.add(entry);
      },
    };
    const a = buildApp({ ...runtime, repos: { ...runtime.repos, accessLog: flaky }, analyst: 'flaky-reader' });
    await a.inject(`/api/runs/${runId}`);
    await tick();
    expect(await real.list({ actor: 'flaky-reader' })).toHaveLength(0);
    await a.inject(`/api/runs/${runId}`);
    await tick();
    expect(await real.list({ actor: 'flaky-reader' })).toHaveLength(1);
    await a.close();
  });

  it('decodes a percent-encoded purpose, keeps a malformed one raw and caps its length', async () => {
    const reader = buildApp({ ...runtime, analyst: 'purpose-reader', accessLog: { dedupeWindowMs: 0 } });
    const read = async (value: string) => {
      await reader.inject({ url: `/api/runs/${runId}/exports/csv`, headers: { 'x-olcys-purpose': value } });
      await tick();
      return (await runtime.repos.accessLog!.list({ actor: 'purpose-reader', limit: 1 }))[0]?.purpose;
    };
    expect(await read(encodeURIComponent('Kontrola podatkowa – ł'))).toBe('Kontrola podatkowa – ł');
    expect(await read('100%zle')).toBe('100%zle');
    expect((await read('x'.repeat(900)))?.length).toBe(500);
    await reader.close();
  });
});
