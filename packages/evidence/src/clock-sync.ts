import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Clock, ClockSyncMethod, ClockSyncStatus } from '@olcys/core';

export interface ClockSyncCheck {
  status(): Promise<ClockSyncStatus>;
}

export const TIMESYNC_MARKER = '/run/systemd/timesync/synchronized';
const PROBE_TIMEOUT_MS = 2000;

function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: the arguments are fixed, the binary is looked up in PATH.
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this machine's clock is NTP-disciplined, read from local OS state only (chrony, systemd-timedated, the
 * systemd-timesyncd marker file). It never queries an NTP server, an HTTP `Date` header or any other network service.
 * The result is cached (60 s by default); a machine where no probe works (a container) reports `unknown`.
 */
export function createClockSyncCheck(options: {
  clock: Clock;
  exec?: (file: string, args: string[]) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  maxOffsetMs?: number;
  cacheMs?: number;
  /** Monotonic milliseconds for the cache (default `performance.now()`); immune to wall-clock steps. */
  monotonicMs?: () => number;
}): ClockSyncCheck {
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? defaultExists;
  const maxOffsetMs = options.maxOffsetMs ?? 1000;
  const cacheMs = options.cacheMs ?? 60_000;
  const monotonicMs = options.monotonicMs ?? (() => performance.now());
  let cached: { mono: number; wall: number; value: Promise<ClockSyncStatus> } | undefined;

  const result = (
    synced: boolean,
    method: ClockSyncMethod,
    extra: { source?: string; offsetMs?: number } = {},
  ): ClockSyncStatus => ({
    synced,
    method,
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.offsetMs !== undefined ? { offsetMs: extra.offsetMs } : {}),
    checkedAt: options.clock.now().toISOString(),
  });

  async function probe(): Promise<ClockSyncStatus> {
    try {
      // `chronyc -c tracking`: CSV; field 3 reference name, field 5 system-time offset (s), field 14 leap status.
      const fields = (await exec('chronyc', ['-c', 'tracking'])).trim().split(',');
      const offsetSeconds = Number(fields[4]);
      if (fields.length >= 14 && Number.isFinite(offsetSeconds)) {
        const offsetMs = Math.abs(offsetSeconds) * 1000;
        return result(fields[13] === 'Normal' && offsetMs <= maxOffsetMs, 'chrony', {
          ...(fields[1] ? { source: fields[1] } : {}),
          offsetMs,
        });
      }
    } catch {
      // chrony is not installed or not running: try the next probe
    }
    try {
      const out = (await exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])).trim();
      if (out === 'yes' || out === 'no') return result(out === 'yes', 'timedatectl');
    } catch {
      // not a systemd host
    }
    try {
      if (await exists(TIMESYNC_MARKER)) return result(true, 'timesyncd_marker');
    } catch {
      // unreadable marker: unknown
    }
    return result(false, 'unknown');
  }

  return {
    status() {
      const mono = monotonicMs();
      const wall = options.clock.now().getTime();
      // The cache ages on the monotonic clock; a wall clock that moved backwards (the very thing being checked) also
      // expires it.
      if (!cached || mono - cached.mono >= cacheMs || wall < cached.wall) {
        cached = { mono, wall, value: probe() };
      }
      return cached.value;
    },
  };
}

/** A fixed status for tests and for deployments that vouch for their clock out of band. */
export function injectedClockSync(synced: boolean, clock: Clock): ClockSyncCheck {
  return {
    async status() {
      return { synced, method: 'injected', checkedAt: clock.now().toISOString() };
    },
  };
}
