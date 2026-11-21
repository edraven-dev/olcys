import type { CaptureStatus, CollectorResult } from '@olcys/core';

export type CollectorStatus = CollectorResult['status'];

/** Statuses at which collection from a source stops for the rest of the run (no retry, no evasion). */
export const BARRIER_STATUSES = ['captcha', 'login_wall', 'blocked'] as const;
export type BarrierStatus = (typeof BARRIER_STATUSES)[number];

export function isBarrierStatus(status: string): status is BarrierStatus {
  return (BARRIER_STATUSES as readonly string[]).includes(status);
}

/** Codes of the `notes` strings (`<code>: <detail>`); the UI translates the code, the detail is shown as is. */
export const NOTE_CODES = [
  'robots_disallowed',
  'allow_list_denied',
  'barrier_blocked',
  'barrier_login_wall',
  'barrier_captcha',
  'rate_limited',
  'source_stopped',
  'replay_miss',
  'fetch_error',
  'no_fixture_for_host',
  'unsupported_input',
  'synthetic_identifier_refused',
  'not_found',
  'no_identifier_match',
  'unrecognised_markup',
  'malformed_link',
  'redirect_limit',
  'redirect_invalid',
  'truncated',
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export function note(code: NoteCode, detail: string): string {
  return `${code}: ${detail}`;
}

/** The code of a note produced by `note()`. */
export function noteCode(text: string): string {
  const index = text.indexOf(':');
  return index < 0 ? text : text.slice(0, index);
}

/** 2xx ok · 404/410 not_found · 401/407 login_wall · 403/429/451 blocked · anything else error. */
export function statusFromHttp(httpStatus: number): CaptureStatus {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok';
  if (httpStatus === 404 || httpStatus === 410) return 'not_found';
  if (httpStatus === 401 || httpStatus === 407) return 'login_wall';
  if (httpStatus === 403 || httpStatus === 429 || httpStatus === 451) return 'blocked';
  return 'error';
}

/**
 * Status of one collector run from its page statuses: all `ok` → ok; `ok` plus anything → partial; otherwise the
 * strongest barrier (captcha > login_wall > blocked); all `not_found` → not_found; nothing fetched → not_found only
 * when the source affirmatively said so, else error. A source that did not answer is never "not found".
 */
export function rollupStatus(statuses: readonly CaptureStatus[], affirmativeNotFound: boolean): CollectorStatus {
  if (statuses.length === 0) return affirmativeNotFound ? 'not_found' : 'error';
  const ok = statuses.filter((s) => s === 'ok').length;
  if (ok === statuses.length) return 'ok';
  if (ok > 0) return 'partial';
  for (const barrier of BARRIER_STATUSES) if (statuses.includes(barrier)) return barrier;
  if (statuses.every((s) => s === 'not_found')) return 'not_found';
  return 'error';
}

/**
 * Status of a source over all its tasks in a run. A `not_found` task (a nick that does not exist there) does not
 * degrade a source that answered; a barrier or error next to a successful task makes it `partial`.
 */
export function rollupOutcomes(statuses: readonly CollectorStatus[]): CollectorStatus {
  if (statuses.length === 0) return 'not_found';
  const answered = statuses.some((s) => s === 'ok' || s === 'partial');
  const failed = statuses.some((s) => s === 'error' || isBarrierStatus(s));
  if (answered) return failed || statuses.includes('partial') ? 'partial' : 'ok';
  for (const barrier of BARRIER_STATUSES) if (statuses.includes(barrier)) return barrier;
  if (statuses.includes('error')) return 'error';
  return 'not_found';
}
