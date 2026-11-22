/**
 * Schedule form model: the checks the console makes before `PUT /api/cases/:caseId/schedule` (the server checks the
 * cron expression itself) and the request body. Who made the change is recorded by the server and never sent.
 */
import type { CaseScheduleState, UpdateScheduleInput } from '@olcys/core';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';

/** Same minimum as the API. */
export const MIN_SCHEDULE_REASON = 3;
/** Refresh interval of the schedule panel and, while a schedule is active, of the case's run list. */
export const SCHEDULE_POLL_MS = 30_000;

export interface ScheduleFormState {
  cron: string;
  enabled: boolean;
  reason: string;
}

export type ScheduleFormErrors = Partial<Record<'cron' | 'reason', string>>;

export function initialScheduleForm(state: CaseScheduleState | undefined): ScheduleFormState {
  return { cron: state?.schedule?.cron ?? '', enabled: state?.schedule?.enabled ?? true, reason: '' };
}

export function validateScheduleForm(form: ScheduleFormState): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  if (!form.cron.trim()) errors.cron = pl.schedule.cronRequired;
  if (form.reason.trim().length < MIN_SCHEDULE_REASON) {
    errors.reason = t(pl.schedule.reasonTooShort, { min: MIN_SCHEDULE_REASON });
  }
  return errors;
}

export function scheduleRequest(form: ScheduleFormState): UpdateScheduleInput {
  return { cron: form.cron.trim().split(/\s+/).join(' '), enabled: form.enabled, reason: form.reason.trim() };
}

/** A schedule that starts analyses: enabled, on an open case, and accepted in the server's mode. */
export function isScheduleActive(state: CaseScheduleState | undefined, caseOpen: boolean): boolean {
  return caseOpen && Boolean(state?.schedule?.enabled) && !state?.problem;
}
