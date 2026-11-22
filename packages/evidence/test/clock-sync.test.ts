import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClockSyncCheck } from '../src/index.ts';
import { FIXED, fixedClock } from './helpers.ts';

const csv = (name: string) => readFile(join(import.meta.dirname, 'fixtures', 'clock', name), 'utf8');
const failing = async () => {
  throw new Error('not available');
};

describe('clock sync check (local probes only)', () => {
  it('reads chrony: small offset is synced, 2.5 s is not', async () => {
    const synced = createClockSyncCheck({ clock: fixedClock, exec: async () => csv('chrony-synced.csv') });
    expect(await synced.status()).toMatchObject({ synced: true, method: 'chrony', source: 'ntp1.example.test' });
    const off = createClockSyncCheck({ clock: fixedClock, exec: async () => csv('chrony-offset.csv') });
    expect(await off.status()).toMatchObject({ synced: false, method: 'chrony' });
  });

  it('falls back to timedatectl, then the timesyncd marker, then unknown', async () => {
    const timedatectl = createClockSyncCheck({
      clock: fixedClock,
      exec: async (file) => (file === 'chronyc' ? failing() : 'yes\n'),
    });
    expect(await timedatectl.status()).toMatchObject({ synced: true, method: 'timedatectl' });
    const marker = createClockSyncCheck({ clock: fixedClock, exec: failing, exists: async () => true });
    expect(await marker.status()).toMatchObject({ synced: true, method: 'timesyncd_marker' });
    const none = createClockSyncCheck({ clock: fixedClock, exec: failing, exists: async () => false });
    expect(await none.status()).toEqual({ synced: false, method: 'unknown', checkedAt: FIXED.toISOString() });
  });

  it('caches the result for 60 s', async () => {
    let calls = 0;
    let now = FIXED.getTime();
    const check = createClockSyncCheck({
      clock: { now: () => new Date(now) },
      monotonicMs: () => now - FIXED.getTime(),
      exec: async () => {
        calls += 1;
        return csv('chrony-synced.csv');
      },
    });
    await check.status();
    now += 30_000;
    await check.status();
    expect(calls).toBe(1);
    now += 31_000;
    await check.status();
    expect(calls).toBe(2);
  });

  it('ages the cache on the monotonic clock and expires it when the wall clock steps back', async () => {
    let calls = 0;
    let wall = FIXED.getTime();
    let mono = 0;
    const check = createClockSyncCheck({
      clock: { now: () => new Date(wall) },
      monotonicMs: () => mono,
      exec: async () => {
        calls += 1;
        return csv('chrony-synced.csv');
      },
    });
    await check.status();
    // The wall clock jumps back an hour: the cached result is not trusted any longer.
    wall -= 3_600_000;
    await check.status();
    expect(calls).toBe(2);
    // The wall clock stays put while monotonic time passes: the cache expires after 60 s.
    mono += 61_000;
    await check.status();
    expect(calls).toBe(3);
    mono += 1_000;
    await check.status();
    expect(calls).toBe(3);
  });
});
