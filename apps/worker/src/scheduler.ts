/**
 * Periodic re-runs, in-process: every `intervalSeconds` the scheduler evaluates each open case with an enabled schedule
 * and fires its due occurrence — the latest cron occurrence (UTC) up to now that is later than both the last schedule
 * change and the last handled occurrence. After downtime that is at most one catch-up run, for the latest missed
 * occurrence. Every handled occurrence becomes one append-only tick: `started` with its run, or why it was skipped
 * (closed case, disabled schedule, another run of the case still queued or running). The tick's unique job id makes
 * firing idempotent, also when several API processes run a scheduler against one database. There is no external
 * scheduler state: `reconcile()` derives everything from the database.
 */
import type {
  ActiveSchedule,
  AnalysisRun,
  Id,
  IsoDateTime,
  Repositories,
  ScheduleProblem,
  ScheduleRepository,
  ScheduleTick,
  ScheduleTickContext,
  ScheduleTickDecision,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { latestOccurrence, validateCron } from './cron.ts';
import type { Runtime } from './runtime.ts';

export interface SchedulingSettings {
  /** How often schedules are evaluated (`OLCYS_SCHEDULER_INTERVAL_SECONDS`, default 30). */
  intervalSeconds: number;
  /** Smallest interval between two occurrences in live mode (`OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`, default 60). */
  minIntervalMinutes: number;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

export function schedulingSettings(env: NodeJS.ProcessEnv = process.env): SchedulingSettings {
  return {
    intervalSeconds: positiveInteger(env, 'OLCYS_SCHEDULER_INTERVAL_SECONDS', 30),
    minIntervalMinutes: positiveInteger(env, 'OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES', 60),
  };
}

/** Job id of one occurrence of a case's schedule: the claim key of its tick. */
export function scheduleJobId(caseId: Id, scheduledFor: IsoDateTime): string {
  return `${caseId}@${scheduledFor}`;
}

/** A closed case, a disabled schedule or a queued or running run of the case skip the occurrence; else a run starts. */
export function decideTick(
  context: ScheduleTickContext,
  newRun: (previousRunId: Id | undefined) => AnalysisRun,
): ScheduleTickDecision {
  if (context.case.status === 'closed') return { outcome: 'skipped_case_closed' };
  if (!context.case.schedule?.enabled) return { outcome: 'skipped_disabled' };
  if (context.activeRunIds.length > 0) return { outcome: 'skipped_overlap' };
  return { outcome: 'started', run: newRun(context.previousRunId) };
}

/** The occurrence due now: the latest one up to `now` after both the schedule change and the last handled one. */
export function dueOccurrence(active: ActiveSchedule, now: Date): IsoDateTime | undefined {
  const since = Math.max(Date.parse(active.changedAt), Date.parse(active.lastScheduledFor ?? active.changedAt));
  const latest = latestOccurrence(active.schedule.cron, now);
  return latest && Date.parse(latest) > since ? latest : undefined;
}

export interface ScheduleReconcileReport {
  /** Open cases with an enabled schedule the scheduler evaluates. */
  scheduled: {
    caseId: Id;
    cron: string;
    nextRun?: IsoDateTime;
    /** A missed occurrence the next evaluation fires (at most one per case). */
    catchUp?: IsoDateTime;
    /** Queued or running runs of the case: its ticks are `skipped_overlap` until they finish. */
    activeRunIds?: Id[];
  }[];
  /** Enabled schedules not evaluated in this mode (e.g. too frequent for live mode); no tick is recorded for them. */
  notEvaluated: { caseId: Id; cron: string; problem: ScheduleProblem }[];
}

export interface Scheduler {
  /** Derives the schedule state from the database (there is no other scheduler state) and reports it. */
  reconcile(): Promise<ScheduleReconcileReport>;
  /** Evaluates every active schedule once; returns the ticks recorded by this evaluation. */
  evaluate(): Promise<ScheduleTick[]>;
  /** Handles one occurrence of a case's schedule; an occurrence already handled returns its tick (`claimed: false`). */
  fire(caseId: Id, scheduledFor: IsoDateTime): Promise<{ tick: ScheduleTick; claimed: boolean }>;
  /** `reconcile()`, a first evaluation (catch-up), then an evaluation every `intervalSeconds`. */
  start(): Promise<ScheduleReconcileReport>;
  /** Stops the timer and waits for an evaluation in progress. */
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  /** Scheduled runs use the runtime's repositories, mode and configuration snapshot; `launchRun` runs their pipeline. */
  runtime: Pick<Runtime, 'repos' | 'mode' | 'config' | 'logger' | 'launchRun'>;
  settings?: SchedulingSettings;
  clock?: () => Date;
}

const isActive = (run: { status: string }) => run.status === 'queued' || run.status === 'running';

/** The schedule repository (both `@olcys/db` implementations provide one). */
export function schedulesOf(repos: Pick<Repositories, 'schedules'>): ScheduleRepository {
  if (!repos.schedules) throw new Error('the repositories do not support schedules');
  return repos.schedules;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { repos, mode, config, logger } = options.runtime;
  const schedules = schedulesOf(repos);
  const settings = options.settings ?? schedulingSettings();
  const clock = options.clock ?? (() => new Date());
  const check = (cron: string, now: Date) =>
    validateCron(cron, { mode, minIntervalMinutes: settings.minIntervalMinutes, now });
  // Warn once per refused schedule, not at every evaluation.
  const warned = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let evaluating: Promise<unknown> | undefined;

  async function fire(caseId: Id, scheduledFor: IsoDateTime) {
    const firedAt = clock().toISOString();
    const claim = { caseId, jobId: scheduleJobId(caseId, scheduledFor), scheduledFor, firedAt };
    const result = await schedules.fire(claim, (context) =>
      decideTick(context, (previousRunId) => ({
        id: newId(),
        caseId,
        ...(previousRunId ? { previousRunId } : {}),
        trigger: 'schedule',
        mode,
        status: 'queued',
        config: config.snapshot,
        queuedAt: firedAt,
      })),
    );
    if (result.claimed) {
      const { outcome, runId } = result.tick;
      logger.info('schedule tick', { caseId, scheduledFor, outcome, ...(runId ? { runId } : {}) });
      if (runId) options.runtime.launchRun(runId);
    }
    return result;
  }

  async function evaluate(): Promise<ScheduleTick[]> {
    const now = clock();
    const fired = await Promise.all(
      (await schedules.listActive()).map(async (active): Promise<ScheduleTick | undefined> => {
        const checked = check(active.schedule.cron, now);
        if (!checked.ok) {
          const key = `${active.caseId}|${active.schedule.cron}`;
          if (!warned.has(key)) logger.warn('schedule not evaluated', { caseId: active.caseId, problem: checked.code });
          warned.add(key);
          return undefined;
        }
        const due = dueOccurrence(active, now);
        if (!due) return undefined;
        try {
          const { tick, claimed } = await fire(active.caseId, due);
          return claimed ? tick : undefined;
        } catch (error) {
          logger.error('schedule tick failed', { caseId: active.caseId, scheduledFor: due, error: String(error) });
          return undefined;
        }
      }),
    );
    return fired.filter((tick) => tick !== undefined);
  }

  async function reconcile(): Promise<ScheduleReconcileReport> {
    const now = clock();
    const report: ScheduleReconcileReport = { scheduled: [], notEvaluated: [] };
    for (const active of await schedules.listActive()) {
      const { caseId, schedule } = active;
      const checked = check(schedule.cron, now);
      if (!checked.ok) {
        report.notEvaluated.push({ caseId, cron: schedule.cron, problem: checked.code });
        continue;
      }
      const catchUp = dueOccurrence(active, now);
      // Sequential on purpose: start-up only, a handful of cases.
      // oxlint-disable-next-line no-await-in-loop
      const activeRunIds = (await repos.runs.listByCase(caseId)).filter(isActive).map((r) => r.id);
      report.scheduled.push({
        caseId,
        cron: schedule.cron,
        ...(checked.nextRuns[0] ? { nextRun: checked.nextRuns[0] } : {}),
        ...(catchUp ? { catchUp } : {}),
        ...(activeRunIds.length ? { activeRunIds } : {}),
      });
    }
    logger.info('schedules reconciled', {
      scheduled: report.scheduled.length,
      catchUp: report.scheduled.filter((s) => s.catchUp).length,
      waitingForRuns: report.scheduled.filter((s) => s.activeRunIds).length,
      notEvaluated: report.notEvaluated.length,
    });
    return report;
  }

  /** One evaluation at a time: a timer firing during a slow evaluation joins it instead of starting another. */
  function evaluateOnce(): Promise<unknown> {
    evaluating ??= evaluate()
      .catch((error: unknown) => logger.error('schedule evaluation failed', { error: String(error) }))
      .finally(() => {
        evaluating = undefined;
      });
    return evaluating;
  }

  return {
    reconcile,
    evaluate,
    fire,
    async start() {
      if (timer) throw new Error('the scheduler is already running');
      const report = await reconcile();
      await evaluateOnce();
      timer = setInterval(() => void evaluateOnce(), settings.intervalSeconds * 1000);
      timer.unref();
      return report;
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await evaluating;
    },
  };
}
