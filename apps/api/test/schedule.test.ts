/**
 * `GET`/`PUT /api/cases/:caseId/schedule` on the in-memory store with a fixed clock. Synthetic data only.
 */
import type { CaseScheduleState, FetchMode, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const REASON = 'weryfikacja okresowa';

function appFor(mode: FetchMode, repos: Repositories = createMemoryRepositories()) {
  const app = buildApp({
    repos,
    blobs: new InMemoryBlobStore(),
    sources: [],
    startRun: async () => {
      throw new Error('runs are not started in these tests');
    },
    mode,
    schedule: { minIntervalMinutes: 60, analyst: 'analityk testowy', clock: () => NOW },
  });
  return { app, repos };
}

async function newCase(repos: Repositories): Promise<string> {
  const kase = await repos.cases.create(
    {
      title: 'Sprawa syntetyczna (harmonogram)',
      purpose: 'Test harmonogramu na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
    },
    'test',
  );
  return kase.id;
}

const put = (app: ReturnType<typeof appFor>['app'], caseId: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/cases/${caseId}/schedule`, payload: payload as Record<string, unknown> });

describe('case schedule API', () => {
  it('sets a schedule, records who and why, and previews the next runs in UTC', async () => {
    const { app, repos } = appFor('live');
    const caseId = await newCase(repos);
    expect((await app.inject(`/api/cases/${caseId}/schedule`)).json()).toMatchObject({ nextRuns: [], recentTicks: [] });

    const response = await put(app, caseId, { cron: '0 3 * * *', enabled: true, reason: REASON });
    expect(response.statusCode).toBe(200);
    const state = response.json() as CaseScheduleState;
    expect(state).toMatchObject({
      schedule: { cron: '0 3 * * *', enabled: true },
      nextRuns: ['2026-11-22T03:00:00.000Z', '2026-11-23T03:00:00.000Z', '2026-11-24T03:00:00.000Z'],
      recentTicks: [],
      minIntervalMinutes: 60,
    });
    expect(state.recentChanges).toEqual([
      expect.objectContaining({
        after: { cron: '0 3 * * *', enabled: true },
        changedBy: 'analityk testowy',
        reason: REASON,
        at: NOW.toISOString(),
      }),
    ]);
    expect((await repos.cases.get(caseId))?.schedule).toEqual({ cron: '0 3 * * *', enabled: true });
    expect((await app.inject(`/api/cases/${caseId}/schedule`)).json()).toEqual(state);
    await app.close();
  });

  it('refuses unsupported and, in live mode, too frequent expressions', async () => {
    const { app, repos } = appFor('live');
    const caseId = await newCase(repos);
    for (const cron of ['61 * * * *', '0 0 3 * * *', '@reboot', 'H 3 * * *', 'FREQ=DAILY']) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await put(app, caseId, { cron, enabled: true, reason: REASON });
      expect([cron, response.statusCode, response.json().error]).toEqual([cron, 400, 'invalid_cron']);
    }
    const frequent = await put(app, caseId, { cron: '*/5 * * * *', enabled: true, reason: REASON });
    expect([frequent.statusCode, frequent.json().error]).toEqual([400, 'schedule_too_frequent']);
    expect((await repos.cases.get(caseId))?.schedule).toBeUndefined();

    const offline = appFor('offline', repos);
    expect((await put(offline.app, caseId, { cron: '*/5 * * * *', enabled: true, reason: REASON })).statusCode).toBe(
      200,
    );
    // A schedule stored in offline mode is not evaluated by a live server.
    expect((await app.inject(`/api/cases/${caseId}/schedule`)).json()).toMatchObject({
      schedule: { cron: '*/5 * * * *', enabled: true },
      nextRuns: [],
      problem: 'schedule_too_frequent',
    });
    await app.close();
    await offline.app.close();
  });

  it('disables a schedule with a recorded reason', async () => {
    const { app, repos } = appFor('live');
    const caseId = await newCase(repos);
    await put(app, caseId, { cron: '0 3 * * *', enabled: true, reason: REASON });
    const disabled = await put(app, caseId, { cron: '0 3 * * *', enabled: false, reason: 'wstrzymanie analiz' });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ schedule: { cron: '0 3 * * *', enabled: false }, nextRuns: [] });
    expect(
      (disabled.json() as CaseScheduleState).recentChanges?.map((c) => [c.before?.enabled, c.after.enabled]),
    ).toEqual([
      [true, false],
      [undefined, true],
    ]);
    await app.close();
  });

  it('answers unknown cases with 404, closed cases with 409 and bad bodies with 400', async () => {
    const closed = new Set<string>();
    const base = createMemoryRepositories();
    const repos: Repositories = {
      ...base,
      cases: {
        ...base.cases,
        async get(id) {
          const found = await base.cases.get(id);
          return found && closed.has(id) ? { ...found, status: 'closed' } : found;
        },
      },
    };
    const { app } = appFor('live', repos);
    const caseId = await newCase(repos);
    const body = { cron: '0 3 * * *', enabled: true, reason: REASON };
    for (const id of [newId(), 'not-a-uuid']) {
      // oxlint-disable-next-line no-await-in-loop
      const [getMissing, putMissing] = await Promise.all([app.inject(`/api/cases/${id}/schedule`), put(app, id, body)]);
      expect([getMissing.statusCode, getMissing.json().error]).toEqual([404, 'case_not_found']);
      expect([putMissing.statusCode, putMissing.json().error]).toEqual([404, 'case_not_found']);
    }
    for (const payload of [
      { cron: '0 3 * * *', enabled: true },
      { ...body, reason: ' ' },
      { ...body, changedBy: 'x' },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await put(app, caseId, payload);
      expect([response.statusCode, response.json().error]).toEqual([400, 'invalid_input']);
    }
    expect((await put(app, caseId, body)).statusCode).toBe(200);
    closed.add(caseId);
    const refused = await put(app, caseId, { ...body, cron: '0 4 * * *' });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'case_closed']);
    expect((await app.inject(`/api/cases/${caseId}/schedule`)).json()).toMatchObject({
      schedule: { cron: '0 3 * * *', enabled: true },
      nextRuns: [],
    });
    await app.close();
  });
});
