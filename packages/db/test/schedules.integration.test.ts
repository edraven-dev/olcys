/**
 * SQL schedules: the case schedule with its change log, ticks claimed once per occurrence (also from two connection
 * pools, as two API processes would), the overlap guard under concurrency, and append-only privileges.
 */
import type {
  AnalysisRun,
  Id,
  RunConfigSnapshot,
  ScheduleRepository,
  ScheduleTickContext,
  ScheduleTickDecision,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createSqlRepositories, migrate, sqlScheduleRepository, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

const CONFIG: RunConfigSnapshot = {
  toolVersion: '0.0.0',
  sourcesConfigSha256: 'a',
  weightsVersion: 'weights.v1',
  weightsSha256: 'b',
  rulesVersions: {},
};
const REASON = 'weryfikacja okresowa';

/** The scheduler's decision, restated: packages never import the worker. */
const decide =
  (firedAt: string) =>
  (context: ScheduleTickContext): ScheduleTickDecision => {
    if (context.case.status === 'closed') return { outcome: 'skipped_case_closed' };
    if (!context.case.schedule?.enabled) return { outcome: 'skipped_disabled' };
    if (context.activeRunIds.length) return { outcome: 'skipped_overlap' };
    const run: AnalysisRun = {
      id: newId(),
      caseId: context.case.id,
      ...(context.previousRunId ? { previousRunId: context.previousRunId } : {}),
      trigger: 'schedule',
      mode: 'offline',
      status: 'queued',
      config: CONFIG,
      queuedAt: firedAt,
    };
    return { outcome: 'started', run };
  };

const claim = (caseId: Id, scheduledFor: string, firedAt = scheduledFor) => ({
  caseId,
  jobId: `${caseId}@${scheduledFor}`,
  scheduledFor,
  firedAt,
});

const fire = (schedules: ScheduleRepository, caseId: Id, scheduledFor: string) =>
  schedules.fire(claim(caseId, scheduledFor), decide(scheduledFor));

describe.skipIf(!enabled)('SQL schedules (integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;
  /** A second pool: another API process against the same database. */
  let other: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
    other = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
    await other?.destroy();
  });

  async function newCase(cron?: string, at = '2026-11-21T10:00:00.000Z') {
    const kase = await createSqlRepositories(db).cases.create(
      {
        title: 'Sprawa syntetyczna (harmonogram)',
        purpose: 'Test integracyjny harmonogramu na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
        scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
      },
      'test',
    );
    if (cron) {
      const set = await sqlScheduleRepository(db).setSchedule(
        kase.id,
        { cron, enabled: true },
        { changedBy: 'test', reason: REASON, at },
      );
      if (!set.ok) throw new Error(`schedule not set: ${set.error}`);
    }
    return kase;
  }

  async function addRun(caseId: Id, status: AnalysisRun['status'], queuedAt: string): Promise<Id> {
    const run: AnalysisRun = {
      id: newId(),
      caseId,
      trigger: 'manual',
      mode: 'offline',
      status,
      config: CONFIG,
      queuedAt,
    };
    await createSqlRepositories(db).runs.create(run);
    return run.id;
  }

  it('replaces the schedule of an open case and logs every change', async () => {
    const schedules = sqlScheduleRepository(db);
    const kase = await newCase();
    const first = await schedules.setSchedule(
      kase.id,
      { cron: '0 3 * * *', enabled: true },
      { changedBy: 'analityk testowy', reason: REASON, at: '2026-11-21T10:00:00.000Z' },
    );
    expect(first).toEqual({
      ok: true,
      change: {
        id: expect.any(String),
        caseId: kase.id,
        after: { cron: '0 3 * * *', enabled: true },
        changedBy: 'analityk testowy',
        reason: REASON,
        at: '2026-11-21T10:00:00.000Z',
      },
    });
    await schedules.setSchedule(
      kase.id,
      { cron: '0 3 * * *', enabled: false },
      { changedBy: 'analityk testowy', reason: 'wstrzymanie', at: '2026-11-21T11:00:00.000Z' },
    );
    expect((await createSqlRepositories(db).cases.get(kase.id))?.schedule).toEqual({
      cron: '0 3 * * *',
      enabled: false,
    });
    expect(
      (await schedules.listChanges(kase.id, 10)).map((c) => [c.before?.enabled, c.after.enabled, c.reason]),
    ).toEqual([
      [true, false, 'wstrzymanie'],
      [undefined, true, REASON],
    ]);
    expect(
      await schedules.setSchedule(
        newId(),
        { cron: '0 3 * * *', enabled: true },
        { changedBy: 't', reason: REASON, at: '2026-11-21T12:00:00.000Z' },
      ),
    ).toEqual({ ok: false, error: 'case_not_found' });
  });

  it('lists open cases with an enabled schedule, the change time and the last handled occurrence', async () => {
    const schedules = sqlScheduleRepository(db);
    const kase = await newCase('0 3 * * *', '2026-11-21T10:00:00.000Z');
    const mine = async () => (await schedules.listActive()).find((a) => a.caseId === kase.id);
    expect(await mine()).toEqual({
      caseId: kase.id,
      schedule: { cron: '0 3 * * *', enabled: true },
      changedAt: '2026-11-21T10:00:00.000Z',
    });
    await fire(schedules, kase.id, '2026-11-22T03:00:00.000Z');
    expect(await mine()).toMatchObject({ lastScheduledFor: '2026-11-22T03:00:00.000Z' });
    const disabled = await newCase('0 3 * * *');
    await schedules.setSchedule(
      disabled.id,
      { cron: '0 3 * * *', enabled: false },
      { changedBy: 'test', reason: 'wstrzymanie', at: '2026-11-21T10:05:00.000Z' },
    );
    expect((await schedules.listActive()).some((a) => a.caseId === disabled.id)).toBe(false);
  });

  it('starts one run per occurrence, linked to the latest completed run, from any number of processes', async () => {
    const kase = await newCase('0 3 * * *');
    const done = await addRun(kase.id, 'succeeded', '2026-11-21T01:00:00.000Z');
    await addRun(kase.id, 'failed', '2026-11-21T02:00:00.000Z');
    const results = await Promise.all([
      fire(sqlScheduleRepository(db), kase.id, '2026-11-22T03:00:00.000Z'),
      fire(sqlScheduleRepository(other), kase.id, '2026-11-22T03:00:00.000Z'),
      fire(sqlScheduleRepository(other), kase.id, '2026-11-22T03:00:00.000Z'),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const tick = results.find((r) => r.claimed)!.tick;
    for (const r of results) expect(r.tick).toEqual(tick);
    expect(tick).toMatchObject({ outcome: 'started', scheduledFor: '2026-11-22T03:00:00.000Z' });
    const scheduled = (await createSqlRepositories(db).runs.listByCase(kase.id)).filter(
      (r) => r.trigger === 'schedule',
    );
    expect(scheduled).toEqual([expect.objectContaining({ id: tick.runId, previousRunId: done, status: 'queued' })]);
    expect(await sqlScheduleRepository(db).listTicks(kase.id, 10)).toEqual([tick]);
  });

  it('never overlaps runs of one case, also when two occurrences are handled concurrently', async () => {
    const idle = await newCase('*/2 * * * *');
    const results = await Promise.all([
      fire(sqlScheduleRepository(db), idle.id, '2026-11-22T03:02:00.000Z'),
      fire(sqlScheduleRepository(other), idle.id, '2026-11-22T03:04:00.000Z'),
    ]);
    expect(results.map((r) => r.tick.outcome).toSorted()).toEqual(['skipped_overlap', 'started']);
    expect(await createSqlRepositories(db).runs.listByCase(idle.id)).toHaveLength(1);

    const busy = await newCase('0 3 * * *');
    await addRun(busy.id, 'running', '2026-11-22T02:59:00.000Z');
    expect((await fire(sqlScheduleRepository(db), busy.id, '2026-11-22T03:00:00.000Z')).tick).toMatchObject({
      outcome: 'skipped_overlap',
    });
    expect(await createSqlRepositories(db).runs.listByCase(busy.id)).toHaveLength(1);
  });

  it('skips the occurrences of a closed case and refuses to change its schedule', async () => {
    const schedules = sqlScheduleRepository(db);
    const kase = await newCase('0 3 * * *');
    await db.updateTable('cases').set({ status: 'closed' }).where('id', '=', kase.id).execute();
    const { tick } = await fire(schedules, kase.id, '2026-11-22T03:00:00.000Z');
    expect(tick).toMatchObject({ outcome: 'skipped_case_closed' });
    expect(tick.runId).toBeUndefined();
    expect(
      await schedules.setSchedule(
        kase.id,
        { cron: '0 4 * * *', enabled: true },
        { changedBy: 'test', reason: REASON, at: '2026-11-22T04:00:00.000Z' },
      ),
    ).toEqual({ ok: false, error: 'case_closed' });
    expect((await schedules.listActive()).some((a) => a.caseId === kase.id)).toBe(false);
  });

  it('keeps ticks and schedule changes append-only for the application role', async () => {
    const kase = await newCase('0 3 * * *');
    await fire(sqlScheduleRepository(db), kase.id, '2026-11-22T03:00:00.000Z');
    const denied = expect.objectContaining({ code: '42501' });
    await expect(
      db.updateTable('schedule_tick').set({ outcome: 'skipped_overlap' }).where('case_id', '=', kase.id).execute(),
    ).rejects.toEqual(denied);
    await expect(db.deleteFrom('schedule_tick').where('case_id', '=', kase.id).execute()).rejects.toEqual(denied);
    await expect(
      db.updateTable('case_schedule_change').set({ reason: 'zmienione' }).where('case_id', '=', kase.id).execute(),
    ).rejects.toEqual(denied);
    await expect(db.deleteFrom('case_schedule_change').where('case_id', '=', kase.id).execute()).rejects.toEqual(
      denied,
    );
    // Only the schedule and the status of a case are mutable.
    await expect(
      db.updateTable('cases').set({ title: 'zmieniony' }).where('id', '=', kase.id).execute(),
    ).rejects.toEqual(denied);
  });
});
