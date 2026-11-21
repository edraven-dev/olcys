/**
 * The scheduler on the in-memory store with a fake clock and a fake pipeline launcher: idempotent ticks, the overlap
 * guard, skipped occurrences, catch-up after downtime and start-up reconciliation. Synthetic data only.
 */
import type { FetchMode, Logger, Repositories, RunConfigSnapshot, ScheduleRepository } from '@olcys/core';
import { nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { createRun, createScheduler, decideTick, schedulesOf, schedulingSettings } from '../src/index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const CONFIG: RunConfigSnapshot = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: 'a'.repeat(64),
  weightsVersion: 'weights.v1',
  weightsSha256: 'b'.repeat(64),
  rulesVersions: {},
};
const CREATED = '2026-11-21T10:00:00.000Z';
const REASON = 'weryfikacja okresowa';

function setup(options: { mode?: FetchMode; repos?: Repositories; logger?: Logger } = {}) {
  const repos = options.repos ?? createMemoryRepositories();
  const clock = { now: new Date(CREATED) };
  const launched: string[] = [];
  const scheduler = createScheduler({
    runtime: {
      repos,
      mode: options.mode ?? 'offline',
      config: { sources: [], snapshot: CONFIG },
      logger: options.logger ?? silent,
      launchRun: (runId) => launched.push(runId),
    },
    settings: { intervalSeconds: 3600, minIntervalMinutes: 60 },
    clock: () => clock.now,
  });
  const at = (iso: string) => {
    clock.now = new Date(iso);
  };
  return { repos, schedules: schedulesOf(repos), scheduler, launched, at };
}

async function newCase(repos: Repositories, title = 'Sprawa syntetyczna (harmonogram)') {
  return repos.cases.create(
    {
      title,
      purpose: 'Test harmonogramu na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
    },
    'test',
  );
}

async function scheduledCase(schedules: ScheduleRepository, repos: Repositories, cron: string, at = CREATED) {
  const kase = await newCase(repos);
  const set = await schedules.setSchedule(kase.id, { cron, enabled: true }, { changedBy: 'test', reason: REASON, at });
  expect(set.ok).toBe(true);
  return kase;
}

const newRun = () => {
  throw new Error('no run expected');
};

/** A schedule repository whose decisions see the case closed — a job handled after the case was closed. */
function closedMeanwhile(schedules: ScheduleRepository): ScheduleRepository {
  return {
    ...schedules,
    fire: (claim, decide) =>
      schedules.fire(claim, (context) => decide({ ...context, case: { ...context.case, status: 'closed' } })),
  };
}

describe('scheduled runs', () => {
  it('starts one run for an idle case, linked to the latest completed run even when a newer one failed', async () => {
    const { repos, schedules, scheduler, launched, at } = setup();
    const kase = await scheduledCase(schedules, repos, '0 3 * * *');
    const done = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    await repos.runs.update(done.id, { status: 'succeeded', finishedAt: nowIso() });
    const failed = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    await repos.runs.update(failed.id, { status: 'failed', finishedAt: nowIso(), error: 'test' });

    at('2026-11-22T03:00:20.000Z');
    const ticks = await scheduler.evaluate();
    expect(ticks).toEqual([
      expect.objectContaining({
        caseId: kase.id,
        jobId: `${kase.id}@2026-11-22T03:00:00.000Z`,
        scheduledFor: '2026-11-22T03:00:00.000Z',
        firedAt: '2026-11-22T03:00:20.000Z',
        outcome: 'started',
      }),
    ]);
    const runs = (await repos.runs.listByCase(kase.id)).filter((r) => r.trigger === 'schedule');
    expect(runs).toEqual([
      expect.objectContaining({
        id: ticks[0]?.runId,
        trigger: 'schedule',
        previousRunId: done.id,
        mode: 'offline',
        status: 'queued',
        config: CONFIG,
      }),
    ]);
    expect(launched).toEqual([ticks[0]?.runId]);
    expect(await schedules.listTicks(kase.id, 10)).toEqual(ticks);
  });

  it('handles an occurrence once, however often it is delivered', async () => {
    const { repos, schedules, scheduler, launched, at } = setup();
    const kase = await scheduledCase(schedules, repos, '0 3 * * *');
    at('2026-11-22T03:00:05.000Z');
    const first = await scheduler.fire(kase.id, '2026-11-22T03:00:00.000Z');
    const again = await scheduler.fire(kase.id, '2026-11-22T03:00:00.000Z');
    const [concurrentA, concurrentB] = await Promise.all([
      scheduler.fire(kase.id, '2026-11-22T03:00:00.000Z'),
      scheduler.fire(kase.id, '2026-11-22T03:00:00.000Z'),
    ]);
    expect(first.claimed).toBe(true);
    for (const repeat of [again, concurrentA, concurrentB])
      expect(repeat).toEqual({ tick: first.tick, claimed: false });
    expect(await scheduler.evaluate()).toEqual([]);
    expect(await repos.runs.listByCase(kase.id)).toHaveLength(1);
    expect(await schedules.listTicks(kase.id, 10)).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });

  it('never overlaps runs of one case', async () => {
    const { repos, schedules, scheduler, launched, at } = setup();
    const busy = await scheduledCase(schedules, repos, '0 3 * * *');
    const manual = await createRun(repos, { caseId: busy.id, mode: 'offline' }, CONFIG);
    at('2026-11-22T03:00:10.000Z');
    expect(await scheduler.evaluate()).toEqual([expect.objectContaining({ outcome: 'skipped_overlap' })]);
    await repos.runs.update(manual.id, { status: 'running' });
    expect((await scheduler.fire(busy.id, '2026-11-23T03:00:00.000Z')).tick.outcome).toBe('skipped_overlap');
    expect(await repos.runs.listByCase(busy.id)).toHaveLength(1);

    // Two different occurrences handled concurrently for an idle case: exactly one run.
    const idle = await scheduledCase(schedules, repos, '*/2 * * * *');
    const results = await Promise.all([
      scheduler.fire(idle.id, '2026-11-22T03:02:00.000Z'),
      scheduler.fire(idle.id, '2026-11-22T03:04:00.000Z'),
    ]);
    expect(results.map((r) => r.tick.outcome).toSorted()).toEqual(['skipped_overlap', 'started']);
    expect(await repos.runs.listByCase(idle.id)).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });

  it('records skipped occurrences of a disabled schedule or a closed case', async () => {
    const { repos, schedules, scheduler, at } = setup();
    const kase = await scheduledCase(schedules, repos, '0 3 * * *');
    await schedules.setSchedule(
      kase.id,
      { cron: '0 3 * * *', enabled: false },
      { changedBy: 'test', reason: 'wstrzymanie', at: '2026-11-21T11:00:00.000Z' },
    );
    at('2026-11-22T03:00:10.000Z');
    // A disabled schedule is not evaluated; an occurrence already being handled is skipped.
    expect(await scheduler.evaluate()).toEqual([]);
    expect((await scheduler.fire(kase.id, '2026-11-22T03:00:00.000Z')).tick.outcome).toBe('skipped_disabled');
    expect((await schedules.listChanges(kase.id, 10)).map((c) => [c.before?.enabled, c.after.enabled])).toEqual([
      [true, false],
      [undefined, true],
    ]);

    const other = await scheduledCase(schedules, repos, '0 3 * * *');
    const closing = setup({ repos: { ...repos, schedules: closedMeanwhile(schedules) } });
    closing.at('2026-11-22T03:00:10.000Z');
    expect(await closing.scheduler.evaluate()).toEqual([
      expect.objectContaining({ caseId: other.id, outcome: 'skipped_case_closed' }),
    ]);
    expect(await repos.runs.listByCase(other.id)).toEqual([]);
    expect(closing.launched).toEqual([]);
  });

  it('decides closed before disabled before overlap', () => {
    const base = { id: 'c', title: 't', purpose: 'p', legalBasis: 'l', createdAt: CREATED, createdBy: 'test' };
    const scope = { enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 1 };
    const closed = { ...base, scope, status: 'closed' as const, schedule: { cron: '0 3 * * *', enabled: false } };
    expect(decideTick({ case: closed, activeRunIds: ['r'] }, newRun)).toEqual({ outcome: 'skipped_case_closed' });
    const disabled = { ...closed, status: 'open' as const };
    expect(decideTick({ case: disabled, activeRunIds: ['r'] }, newRun)).toEqual({ outcome: 'skipped_disabled' });
    const enabled = { ...disabled, schedule: { cron: '0 3 * * *', enabled: true } };
    expect(decideTick({ case: enabled, activeRunIds: ['r'] }, newRun)).toEqual({ outcome: 'skipped_overlap' });
  });

  it('catches up at most one missed occurrence after downtime', async () => {
    const { repos, schedules, scheduler, at } = setup();
    const kase = await scheduledCase(schedules, repos, '0 * * * *', '2026-11-21T10:30:00.000Z');
    at('2026-11-21T10:45:00.000Z');
    // 10:00 was before the schedule was set.
    expect(await scheduler.evaluate()).toEqual([]);
    at('2026-11-21T11:00:30.000Z');
    const [eleven] = await scheduler.evaluate();
    expect(eleven).toMatchObject({ scheduledFor: '2026-11-21T11:00:00.000Z', outcome: 'started' });
    await repos.runs.update(eleven!.runId!, { status: 'succeeded', finishedAt: nowIso() });

    // Down from 11:05 to 15:30: 12:00…15:00 were missed; only the latest is fired.
    at('2026-11-21T15:30:00.000Z');
    expect(await scheduler.evaluate()).toEqual([
      expect.objectContaining({
        scheduledFor: '2026-11-21T15:00:00.000Z',
        firedAt: '2026-11-21T15:30:00.000Z',
        outcome: 'started',
      }),
    ]);
    at('2026-11-21T15:45:00.000Z');
    expect(await scheduler.evaluate()).toEqual([]);
    expect((await repos.runs.listByCase(kase.id)).filter((r) => r.trigger === 'schedule')).toHaveLength(2);

    // Occurrences missed while the schedule was disabled are not caught up after it is enabled again.
    const disable = { changedBy: 'test', reason: 'wstrzymanie', at: '2026-11-21T15:50:00.000Z' };
    await schedules.setSchedule(kase.id, { cron: '0 * * * *', enabled: false }, disable);
    const enable = { changedBy: 'test', reason: 'wznowienie', at: '2026-11-21T19:10:00.000Z' };
    await schedules.setSchedule(kase.id, { cron: '0 * * * *', enabled: true }, enable);
    at('2026-11-21T19:20:00.000Z');
    expect(await scheduler.evaluate()).toEqual([]);
  });

  it('reconciles from the database at start-up and catches up on the first evaluation', async () => {
    const { repos, schedules } = setup();
    const missed = await scheduledCase(schedules, repos, '0 3 * * *');
    const current = await scheduledCase(schedules, repos, '0 4 * * *', '2026-11-22T03:30:00.000Z');
    const busyRun = await createRun(repos, { caseId: current.id, mode: 'offline' }, CONFIG);
    const disabled = await scheduledCase(schedules, repos, '0 5 * * *');
    await schedules.setSchedule(
      disabled.id,
      { cron: '0 5 * * *', enabled: false },
      { changedBy: 'test', reason: 'wstrzymanie', at: CREATED },
    );
    const tooFrequent = await scheduledCase(schedules, repos, '*/2 * * * *');

    const restarted = setup({ repos, mode: 'live' });
    restarted.at('2026-11-22T03:40:00.000Z');
    const report = await restarted.scheduler.start();
    expect(report).toEqual({
      scheduled: [
        {
          caseId: missed.id,
          cron: '0 3 * * *',
          nextRun: '2026-11-23T03:00:00.000Z',
          catchUp: '2026-11-22T03:00:00.000Z',
        },
        { caseId: current.id, cron: '0 4 * * *', nextRun: '2026-11-22T04:00:00.000Z', activeRunIds: [busyRun.id] },
      ],
      notEvaluated: [{ caseId: tooFrequent.id, cron: '*/2 * * * *', problem: 'schedule_too_frequent' }],
    });
    await restarted.scheduler.stop();
    // The first evaluation fired the catch-up run, in the runtime's mode.
    expect(restarted.launched).toHaveLength(1);
    expect(await repos.runs.get(restarted.launched[0]!)).toMatchObject({ caseId: missed.id, mode: 'live' });
    expect(await schedules.listTicks(tooFrequent.id, 10)).toEqual([]);
    expect(await schedules.listTicks(disabled.id, 10)).toEqual([]);
  });
});

describe('scheduler settings and logging', () => {
  it('reads the intervals from the environment and refuses unusable values', () => {
    expect(schedulingSettings({})).toEqual({ intervalSeconds: 30, minIntervalMinutes: 60 });
    expect(
      schedulingSettings({ OLCYS_SCHEDULER_INTERVAL_SECONDS: '5', OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES: ' 120 ' }),
    ).toEqual({ intervalSeconds: 5, minIntervalMinutes: 120 });
    for (const value of ['0', '-1', '1.5', 'abc', '3000000']) {
      expect(() => schedulingSettings({ OLCYS_SCHEDULER_INTERVAL_SECONDS: value })).toThrow(
        /OLCYS_SCHEDULER_INTERVAL_SECONDS/,
      );
    }
    expect(() => schedulingSettings({ OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES: '0' })).toThrow(
      /OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES/,
    );
  });

  it('warns once about a schedule it does not evaluate', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silent, warn: (message) => warnings.push(message) };
    const { repos, schedules, scheduler, at } = setup({ mode: 'live', logger });
    await scheduledCase(schedules, repos, '*/2 * * * *');
    at('2026-11-21T10:02:30.000Z');
    expect(await scheduler.evaluate()).toEqual([]);
    at('2026-11-21T10:04:30.000Z');
    expect(await scheduler.evaluate()).toEqual([]);
    expect(warnings).toEqual(['schedule not evaluated']);
  });
});
