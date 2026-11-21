import { describe, expect, it } from 'vitest';
import { latestOccurrence, minIntervalFor, nextOccurrences, validateCron } from '../src/index.ts';

const now = new Date('2026-11-21T10:00:00.000Z');
const live = { mode: 'live', minIntervalMinutes: 60, now } as const;
const offline = { mode: 'offline', minIntervalMinutes: 60, now } as const;

describe('validateCron', () => {
  it('accepts a daily schedule and previews the next three occurrences in UTC', () => {
    expect(validateCron('0 3 * * *', live)).toEqual({
      ok: true,
      cron: '0 3 * * *',
      nextRuns: ['2026-11-22T03:00:00.000Z', '2026-11-23T03:00:00.000Z', '2026-11-24T03:00:00.000Z'],
    });
  });

  it('refuses anything but five plain cron fields', () => {
    const refused = [
      '61 * * * *',
      '0 0 3 * * *',
      '@reboot',
      '@daily',
      'H 3 * * *',
      'H/15 * * * *',
      '0 H * * *',
      'FREQ=DAILY',
      'RRULE:FREQ=DAILY;BYHOUR=3',
      '0 3 1 * 1',
      '0 3 30 2 *',
      '',
      '0 3 * *',
    ];
    for (const cron of refused) {
      for (const options of [live, offline]) {
        expect([cron, validateCron(cron, options)]).toEqual([cron, expect.objectContaining({ code: 'invalid_cron' })]);
      }
    }
  });

  it('accepts month and day names, ranges, steps and lists', () => {
    for (const cron of ['0 3 * * THU', '30 2 * JAN-MAR MON-FRI', '0 */6 * * *', '15 3 1,15 * *', '0 3 L * *']) {
      expect([cron, validateCron(cron, live).ok]).toEqual([cron, true]);
    }
  });

  it('keeps the minimum interval in live mode only', () => {
    expect(validateCron('*/5 * * * *', live)).toMatchObject({ ok: false, code: 'schedule_too_frequent' });
    expect(validateCron('0,30 3 * * *', live)).toMatchObject({ ok: false, code: 'schedule_too_frequent' });
    expect(validateCron('*/5 * * * *', offline)).toMatchObject({ ok: true });
    expect(validateCron('*/2 * * * *', { ...offline, mode: 'replay' })).toMatchObject({ ok: true });
    // Exactly the minimum is allowed.
    expect(validateCron('0 * * * *', live)).toMatchObject({ ok: true });
    expect(validateCron('*/5 * * * *', { ...live, minIntervalMinutes: 5 })).toMatchObject({ ok: true });
    expect([minIntervalFor('live', 60), minIntervalFor('offline', 60), minIntervalFor('replay', 60)]).toEqual([
      60, 1, 1,
    ]);
  });

  it('normalises the spacing of the stored expression', () => {
    expect(validateCron('  0   3 *  * * ', live)).toMatchObject({ ok: true, cron: '0 3 * * *' });
  });
});

describe('occurrences', () => {
  it('finds the latest occurrence up to and including a time', () => {
    expect(latestOccurrence('0 3 * * *', new Date('2026-11-22T03:00:00.000Z'))).toBe('2026-11-22T03:00:00.000Z');
    expect(latestOccurrence('0 3 * * *', new Date('2026-11-22T02:59:59.999Z'))).toBe('2026-11-21T03:00:00.000Z');
    expect(latestOccurrence('not a cron', now)).toBeUndefined();
  });

  it('lists the next occurrences strictly after a time', () => {
    expect(nextOccurrences('*/2 * * * *', new Date('2026-11-21T10:00:00.000Z'), 2)).toEqual([
      '2026-11-21T10:02:00.000Z',
      '2026-11-21T10:04:00.000Z',
    ]);
    expect(nextOccurrences('@daily', now, 2)).toEqual([]);
  });
});
