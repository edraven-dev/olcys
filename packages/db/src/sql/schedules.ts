import type { CaseSchedule, CaseScheduleChange, ScheduleRepository, ScheduleTick } from '@olcys/core';
import { sql } from 'kysely';
import { iso, json, type Db } from '../client.ts';
import { sqlCaseRepository } from './cases.ts';
import { sqlRunRepository } from './runs.ts';

interface ChangeRow {
  id: string;
  case_id: string;
  before: CaseSchedule | null;
  after: CaseSchedule;
  changed_by: string;
  reason: string;
  at: Date;
}

interface TickRow {
  id: string;
  case_id: string;
  job_id: string;
  scheduled_for: Date;
  fired_at: Date;
  outcome: ScheduleTick['outcome'];
  run_id: string | null;
}

function toChange(row: ChangeRow): CaseScheduleChange {
  return {
    id: row.id,
    caseId: row.case_id,
    ...(row.before ? { before: row.before } : {}),
    after: row.after,
    changedBy: row.changed_by,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

function toTick(row: TickRow): ScheduleTick {
  return {
    id: row.id,
    caseId: row.case_id,
    jobId: row.job_id,
    scheduledFor: row.scheduled_for.toISOString(),
    firedAt: row.fired_at.toISOString(),
    outcome: row.outcome,
    ...(row.run_id ? { runId: row.run_id } : {}),
  };
}

/**
 * Serialises schedule changes and tick decisions of one case across connections and processes until the transaction
 * ends.
 */
async function lockCaseSchedule(trx: Db, caseId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`case-schedule:${caseId}`}))`.execute(trx);
}

export function sqlScheduleRepository(db: Db): ScheduleRepository {
  return {
    async setSchedule(caseId, schedule, change) {
      return db.transaction().execute(async (trx) => {
        await lockCaseSchedule(trx, caseId);
        // The row lock orders concurrent changes, so every change row's `before` is the value it replaced.
        const current = await trx
          .selectFrom('cases')
          .select(['status', 'schedule'])
          .where('id', '=', caseId)
          .forUpdate()
          .executeTakeFirst();
        if (!current) return { ok: false, error: 'case_not_found' } as const;
        if (current.status === 'closed') return { ok: false, error: 'case_closed' } as const;
        await trx
          .updateTable('cases')
          .set({ schedule: json(schedule) })
          .where('id', '=', caseId)
          .execute();
        const row = await trx
          .insertInto('case_schedule_change')
          .values({
            case_id: caseId,
            before: current.schedule ? json(current.schedule) : null,
            after: json(schedule),
            changed_by: change.changedBy,
            reason: change.reason,
            at: change.at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { ok: true, change: toChange(row) } as const;
      });
    },

    async listChanges(caseId, limit) {
      const rows = await db
        .selectFrom('case_schedule_change')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toChange);
    },

    async listTicks(caseId, limit) {
      const rows = await db
        .selectFrom('schedule_tick')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('scheduled_for', 'desc')
        .orderBy('fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toTick);
    },

    async listActive() {
      const rows = await db
        .selectFrom('cases as c')
        .select((eb) => [
          'c.id',
          'c.schedule',
          'c.created_at',
          eb
            .selectFrom('case_schedule_change as ch')
            .select((e) => e.fn.max('ch.at').as('at'))
            .whereRef('ch.case_id', '=', 'c.id')
            .as('changed_at'),
          eb
            .selectFrom('schedule_tick as t')
            .select((e) => e.fn.max('t.scheduled_for').as('scheduled_for'))
            .whereRef('t.case_id', '=', 'c.id')
            .as('last_scheduled_for'),
        ])
        .where('c.status', '=', 'open')
        .where('c.schedule', 'is not', null)
        .orderBy('c.created_at')
        .execute();
      return rows.flatMap((row) => {
        if (!row.schedule?.enabled) return [];
        const lastScheduledFor = iso(row.last_scheduled_for);
        return [
          {
            caseId: row.id,
            schedule: row.schedule,
            changedAt: iso(row.changed_at) ?? row.created_at.toISOString(),
            ...(lastScheduledFor ? { lastScheduledFor } : {}),
          },
        ];
      });
    },

    async fire(claim, decide) {
      const result = await db.transaction().execute(async (trx) => {
        await lockCaseSchedule(trx, claim.caseId);
        const existing = await trx
          .selectFrom('schedule_tick')
          .selectAll()
          .where('job_id', '=', claim.jobId)
          .executeTakeFirst();
        if (existing) return { tick: toTick(existing), claimed: false };
        const kase = await sqlCaseRepository(trx).get(claim.caseId);
        if (!kase) throw new Error(`case ${claim.caseId} not found`);
        const active = await trx
          .selectFrom('runs')
          .select('id')
          .where('case_id', '=', claim.caseId)
          .where('status', 'in', ['queued', 'running'])
          .execute();
        const previous = await sqlRunRepository(trx).latestCompleted(claim.caseId);
        // The schedule as it is now: an occurrence chosen before a change (or before a later one was handled) is
        // no longer due.
        const changed = await trx
          .selectFrom('case_schedule_change')
          .select((e) => e.fn.max('at').as('at'))
          .where('case_id', '=', claim.caseId)
          .executeTakeFirst();
        const handled = await trx
          .selectFrom('schedule_tick')
          .select((e) => e.fn.max('scheduled_for').as('at'))
          .where('case_id', '=', claim.caseId)
          .executeTakeFirst();
        const lastScheduledFor = iso(handled?.at);
        const decision = decide({
          case: kase,
          changedAt: iso(changed?.at) ?? kase.createdAt,
          ...(lastScheduledFor ? { lastScheduledFor } : {}),
          activeRunIds: active.map((r) => r.id),
          ...(previous ? { previousRunId: previous.id } : {}),
        });
        if (decision.outcome === 'not_due') return { claimed: false };
        const run = decision.outcome === 'started' ? decision.run : undefined;
        if (run && run.caseId !== claim.caseId)
          throw new Error(`a tick of case ${claim.caseId} cannot start ${run.id}`);
        // The insert is the claim; the run (deferred foreign key) is created only when it succeeds.
        const inserted = await trx
          .insertInto('schedule_tick')
          .values({
            case_id: claim.caseId,
            job_id: claim.jobId,
            scheduled_for: claim.scheduledFor,
            fired_at: claim.firedAt,
            outcome: decision.outcome,
            run_id: run?.id ?? null,
          })
          .onConflict((oc) => oc.column('job_id').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (!inserted) return undefined;
        if (run) await sqlRunRepository(trx).create(run);
        return { tick: toTick(inserted), claimed: true };
      });
      if (result) return result;
      // Claimed by a writer that did not take the lock: nothing was written here; report the stored tick.
      const stored = await db
        .selectFrom('schedule_tick')
        .selectAll()
        .where('job_id', '=', claim.jobId)
        .executeTakeFirstOrThrow();
      return { tick: toTick(stored), claimed: false };
    },
  };
}
