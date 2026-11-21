/**
 * Cron expressions of case schedules: exactly five fields (minute, hour, day of month, month, day of week), evaluated
 * in UTC with cron-parser. Refused: macros (`@daily`, `@reboot`), a seconds field, Jenkins-style `H`, RRULE text and
 * restricting both day fields at once (ambiguous). In live mode occurrences must be at least the configured minimum
 * apart (politeness towards the sources); in offline and replay mode one minute.
 */
import type { FetchMode, IsoDateTime, ScheduleProblem } from '@olcys/core';
import { CronExpressionParser, type CronExpression } from 'cron-parser';

/** How many upcoming occurrences `validateCron` returns as `nextRuns`. */
export const NEXT_RUNS_SHOWN = 3;
/** Upcoming occurrences checked for the minimum interval. */
const INTERVAL_SAMPLE = 10;

const MONTH_NAMES = /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/gi;
const DAY_NAMES = /SUN|MON|TUE|WED|THU|FRI|SAT/gi;

/** Characters allowed per field once month and day names are removed: no letter but `L` (last), so no `H`. */
const FIELDS: readonly { name: string; allowed: RegExp; names?: RegExp }[] = [
  { name: 'minute', allowed: /^[\d*,/-]+$/ },
  { name: 'hour', allowed: /^[\d*,/-]+$/ },
  { name: 'day of month', allowed: /^[\d*,/?L-]+$/ },
  { name: 'month', allowed: /^[\d*,/-]*$/, names: MONTH_NAMES },
  { name: 'day of week', allowed: /^[\d*,/?L#-]*$/, names: DAY_NAMES },
];

export type CronCheck =
  | { ok: true; /** The expression with normalised spacing. */ cron: string; nextRuns: IsoDateTime[] }
  | { ok: false; code: ScheduleProblem; message: string };

type Parsed =
  | { ok: true; cron: string; expression: CronExpression }
  | { ok: false; code: 'invalid_cron'; message: string };

const invalid = (message: string): { ok: false; code: 'invalid_cron'; message: string } => ({
  ok: false,
  code: 'invalid_cron',
  message,
});

function parseCron(cron: string, currentDate: Date): Parsed {
  if (cron.includes('@')) return invalid('macros such as @daily are not supported; use five cron fields');
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return invalid(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  for (const [index, field] of fields.entries()) {
    const rule = FIELDS[index];
    if (!rule) return invalid('too many fields');
    if (!rule.allowed.test(rule.names ? field.replace(rule.names, '') : field)) {
      return invalid(`unsupported ${rule.name} field "${field}"`);
    }
  }
  try {
    // Strict mode (both day fields restricted, out-of-range values) expects six fields: seconds are always 0.
    const expression = CronExpressionParser.parse(`0 ${fields.join(' ')}`, { tz: 'UTC', strict: true, currentDate });
    return { ok: true, cron: fields.join(' '), expression };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

function upcoming(expression: CronExpression, count: number): Date[] | undefined {
  try {
    return expression.take(count).map((date) => date.toDate());
  } catch {
    return undefined;
  }
}

/** Smallest allowed interval between two occurrences, in minutes. */
export function minIntervalFor(mode: FetchMode, liveMinimumMinutes: number): number {
  return mode === 'live' ? liveMinimumMinutes : 1;
}

/**
 * Checks a schedule's cron expression and previews it: `nextRuns` are the next occurrences after `now`. The interval
 * between consecutive occurrences (over the next ten) must be at least `minIntervalMinutes` in live mode, one minute
 * otherwise.
 */
export function validateCron(
  cron: string,
  options: { mode: FetchMode; minIntervalMinutes: number; now: Date },
): CronCheck {
  const parsed = parseCron(cron, options.now);
  if (!parsed.ok) return parsed;
  const sample = upcoming(parsed.expression, INTERVAL_SAMPLE);
  if (!sample?.length) return invalid('the expression has no upcoming occurrence');
  const minimum = minIntervalFor(options.mode, options.minIntervalMinutes);
  for (const [index, date] of sample.entries()) {
    const previous = sample[index - 1];
    const minutes = previous ? (date.getTime() - previous.getTime()) / 60_000 : Infinity;
    if (minutes < minimum) {
      return {
        ok: false,
        code: 'schedule_too_frequent',
        message: `occurrences ${minutes} min apart; the minimum in ${options.mode} mode is ${minimum} min`,
      };
    }
  }
  return {
    ok: true,
    cron: parsed.cron,
    nextRuns: sample.slice(0, NEXT_RUNS_SHOWN).map((date) => date.toISOString()),
  };
}

/** The next `count` occurrences after `after` (none for an expression `validateCron` refuses). */
export function nextOccurrences(cron: string, after: Date, count: number): IsoDateTime[] {
  const parsed = parseCron(cron, after);
  return parsed.ok ? (upcoming(parsed.expression, count)?.map((date) => date.toISOString()) ?? []) : [];
}

/** The latest occurrence at or before `notAfter`. */
export function latestOccurrence(cron: string, notAfter: Date): IsoDateTime | undefined {
  // `prev()` is strictly before its start: start one millisecond later so an occurrence at `notAfter` counts.
  const parsed = parseCron(cron, new Date(notAfter.getTime() + 1));
  if (!parsed.ok) return undefined;
  try {
    return parsed.expression.prev().toDate().toISOString();
  } catch {
    return undefined;
  }
}
