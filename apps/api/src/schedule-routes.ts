/**
 * Case schedules (periodic re-runs): `GET` and `PUT /api/cases/:caseId/schedule`. The cron expression is checked with
 * the scheduler's own rules (five fields, UTC, minimum interval in live mode). Who changed a schedule is the
 * configured analyst — never a value from the request; why is required and stored with every change.
 */
import type { CaseScheduleState, FetchMode, Id, Repositories } from '@olcys/core';
import { parse, UpdateScheduleSchema } from '@olcys/core';
import { minIntervalFor, schedulesOf, validateCron } from '@olcys/worker';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface ScheduleRouteOptions {
  repos: Repositories;
  mode: FetchMode;
  /** Smallest interval between occurrences in live mode (`OLCYS_SCHEDULE_MIN_INTERVAL_MINUTES`). */
  minIntervalMinutes: number;
  /** Recorded as `changedBy` of every schedule change. */
  analyst: string;
  clock: () => Date;
  /** Canonical case id from the URL, or undefined when it cannot exist. */
  idOf: (value: string) => string | undefined;
}

const RECENT_TICKS = 10;
const RECENT_CHANGES = 5;

const caseNotFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: 'case_not_found', message: 'case not found' });
const caseClosed = (reply: FastifyReply) =>
  reply.code(409).send({ error: 'case_closed', message: 'the case is closed; its schedule cannot change' });

export function registerScheduleRoutes(app: FastifyInstance, options: ScheduleRouteOptions): void {
  const { repos, mode } = options;
  const check = (cron: string) =>
    validateCron(cron, { mode, minIntervalMinutes: options.minIntervalMinutes, now: options.clock() });

  async function stateOf(caseId: Id): Promise<CaseScheduleState> {
    const schedules = schedulesOf(repos);
    const [kase, recentTicks, recentChanges] = await Promise.all([
      repos.cases.get(caseId),
      schedules.listTicks(caseId, RECENT_TICKS),
      schedules.listChanges(caseId, RECENT_CHANGES),
    ]);
    const schedule = kase?.schedule;
    // A schedule stored in another mode may be refused here (e.g. too frequent for live mode): it is not evaluated.
    const checked = schedule ? check(schedule.cron) : undefined;
    const active = Boolean(schedule?.enabled) && kase?.status === 'open';
    return {
      ...(schedule ? { schedule } : {}),
      nextRuns: active && checked?.ok ? checked.nextRuns : [],
      recentTicks,
      recentChanges,
      minIntervalMinutes: minIntervalFor(mode, options.minIntervalMinutes),
      ...(checked && !checked.ok ? { problem: checked.code } : {}),
    };
  }

  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/schedule', async (request, reply) => {
    const caseId = options.idOf(request.params.caseId);
    const kase = caseId ? await repos.cases.get(caseId) : undefined;
    if (!kase) return caseNotFound(reply);
    return stateOf(kase.id);
  });

  app.put<{ Params: { caseId: string } }>('/api/cases/:caseId/schedule', async (request, reply) => {
    const caseId = options.idOf(request.params.caseId);
    const kase = caseId ? await repos.cases.get(caseId) : undefined;
    if (!kase) return caseNotFound(reply);
    const input = parse(UpdateScheduleSchema, request.body);
    if (kase.status === 'closed') return caseClosed(reply);
    const checked = check(input.cron);
    if (!checked.ok) return reply.code(400).send({ error: checked.code, message: checked.message });
    const result = await schedulesOf(repos).setSchedule(
      kase.id,
      { cron: checked.cron, enabled: input.enabled },
      { changedBy: options.analyst, reason: input.reason, at: options.clock().toISOString() },
    );
    if (!result.ok) return result.error === 'case_closed' ? caseClosed(reply) : caseNotFound(reply);
    return stateOf(kase.id);
  });
}
