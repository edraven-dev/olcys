/**
 * Periodic re-runs of a case. The case's schedule is a five-field cron expression evaluated in UTC; every change of
 * it and every handled occurrence ("tick") is recorded append-only. An occurrence is handled at most once, a tick never
 * starts a run while another run of the case is queued or running, and after downtime at most one missed occurrence
 * (the latest) is caught up.
 */
import { z } from 'zod';
import type { CaseSchedule } from './case.ts';
import type { Id, IsoDateTime } from './common.ts';

export const SCHEDULE_TICK_OUTCOMES = [
  'started',
  'skipped_overlap',
  'skipped_disabled',
  'skipped_case_closed',
] as const;
export type ScheduleTickOutcome = (typeof SCHEDULE_TICK_OUTCOMES)[number];

/** One handled occurrence of a case's schedule. */
export interface ScheduleTick {
  id: Id;
  caseId: Id;
  /** `<caseId>@<scheduledFor>` — unique, so an occurrence is handled at most once (also across processes). */
  jobId: string;
  /** The cron occurrence this tick handles. */
  scheduledFor: IsoDateTime;
  /** When it was handled; later than `scheduledFor` for a catch-up after downtime. */
  firedAt: IsoDateTime;
  outcome: ScheduleTickOutcome;
  /** The run the tick started (outcome `started` only). */
  runId?: Id;
}

/** One change of a case's schedule: who changed it, why, and the value before and after. */
export interface CaseScheduleChange {
  id: Id;
  caseId: Id;
  /** Absent when the case had no schedule before. */
  before?: CaseSchedule;
  after: CaseSchedule;
  changedBy: string;
  reason: string;
  at: IsoDateTime;
}

/** Why a cron expression is refused: not a supported expression, or more frequent than the mode allows. */
export const SCHEDULE_PROBLEMS = ['invalid_cron', 'schedule_too_frequent'] as const;
export type ScheduleProblem = (typeof SCHEDULE_PROBLEMS)[number];

/** Response of `GET` and `PUT /api/cases/:caseId/schedule`. */
export interface CaseScheduleState {
  schedule?: CaseSchedule;
  /** Next occurrences (UTC, at most 3) while the schedule is enabled, valid and the case open; otherwise empty. */
  nextRuns: IsoDateTime[];
  /** Latest ticks, newest first. */
  recentTicks: ScheduleTick[];
  /** Latest schedule changes, newest first. */
  recentChanges?: CaseScheduleChange[];
  /** Smallest interval between two occurrences allowed in the server's mode. */
  minIntervalMinutes?: number;
  /** Set when the stored schedule is not evaluated in the server's mode (e.g. too frequent for live mode). */
  problem?: ScheduleProblem;
}

/** Body of `PUT /api/cases/:caseId/schedule`. Who made the change is never taken from the request. */
export const UpdateScheduleSchema = z.strictObject({
  cron: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;
