import { describe, expect, it } from 'vitest';
import { engineOf, resetDatabase } from './db-reset.ts';
import type { Exec, ExecResult } from './exec.ts';

const config = (volume: string): string =>
  JSON.stringify({ name: volume.split('_')[0], volumes: { 'postgres-data': { name: volume } } });
const isReadOnly = (call: string): boolean => call.endsWith(' version') || call.endsWith(' config --format json');

function harness(opts: { failAt?: string; env?: Record<string, string>; config?: ExecResult } = {}) {
  const calls: string[] = [];
  const log: string[] = [];
  let migrated = 0;
  const run: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (line.endsWith(' config --format json'))
      return opts.config ?? { code: 0, stdout: config('olcys_postgres-data'), stderr: '' };
    return { code: opts.failAt && line.includes(opts.failAt) ? 1 : 0, stdout: '', stderr: 'boom' };
  };
  return {
    calls,
    log,
    migrated: () => migrated,
    deps: {
      run,
      env: opts.env ?? {},
      log: (l: string) => log.push(l),
      migrate: async () => {
        migrated++;
        return { applied: ['0001_init.sql'] };
      },
    },
  };
}

describe('db:reset', () => {
  it('refuses without --yes, prints the plan and changes nothing', async () => {
    const h = harness();
    expect(await resetDatabase([], h.deps)).toBe(1);
    expect(h.log.join('\n')).toContain('DESTROY');
    expect(h.log.join('\n')).toContain('olcys_postgres-data');
    expect(h.log.join('\n')).toContain('Refusing');
    expect(h.calls.every(isReadOnly)).toBe(true);
    expect(h.migrated()).toBe(0);
  });

  it('--dry-run stops after the plan even with --yes', async () => {
    const h = harness();
    expect(await resetDatabase(['--yes', '--dry-run'], h.deps)).toBe(0);
    expect(h.calls.every(isReadOnly)).toBe(true);
    expect(h.migrated()).toBe(0);
  });

  it('with --yes removes container and volume, restarts postgres and migrates', async () => {
    const h = harness();
    expect(await resetDatabase(['--yes'], h.deps)).toBe(0);
    expect(h.calls.filter((c) => !isReadOnly(c))).toEqual([
      'docker compose stop postgres',
      'docker compose rm --force postgres',
      'docker volume rm --force olcys_postgres-data',
      'docker compose up -d --wait postgres',
    ]);
    expect(h.migrated()).toBe(1);
  });

  it('stops at the first failing step and does not migrate', async () => {
    const h = harness({ failAt: 'volume rm' });
    expect(await resetDatabase(['--yes'], h.deps)).toBe(1);
    expect(h.migrated()).toBe(0);
    expect(h.calls.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('takes the volume from the resolved compose config and keeps the engine context of OLCYS_COMPOSE', async () => {
    const h = harness({
      env: { OLCYS_COMPOSE: 'docker --context remote compose -p demo' },
      config: { code: 0, stdout: `>>>> banner\n${config('demo_postgres-data')}`, stderr: '' },
    });
    expect(await resetDatabase(['--yes'], h.deps)).toBe(0);
    expect(h.calls.filter((c) => !isReadOnly(c))).toEqual([
      'docker --context remote compose -p demo stop postgres',
      'docker --context remote compose -p demo rm --force postgres',
      'docker --context remote volume rm --force demo_postgres-data',
      'docker --context remote compose -p demo up -d --wait postgres',
    ]);
  });

  it('deletes nothing when the volume cannot be resolved or the engine is unknown', async () => {
    for (const h of [
      harness({ config: { code: 1, stdout: '', stderr: 'unknown flag: --format' } }),
      harness({ config: { code: 0, stdout: JSON.stringify({ name: 'olcys', volumes: {} }), stderr: '' } }),
      harness({ env: { OLCYS_COMPOSE: 'mycompose' } }),
    ]) {
      // Sequential: each harness records its own calls.
      // oxlint-disable-next-line no-await-in-loop
      expect(await resetDatabase(['--yes'], h.deps)).toBe(1);
      expect(h.calls.every(isReadOnly)).toBe(true);
      expect(h.log.join('\n')).toMatch(/refusing to delete anything|nothing was changed/);
      expect(h.migrated()).toBe(0);
    }
  });

  it('derives the engine for podman and the standalone compose binaries', () => {
    expect(engineOf(['podman', 'compose'])).toEqual(['podman']);
    expect(engineOf(['docker-compose', '-p', 'x'])).toEqual(['docker']);
    expect(engineOf(['/usr/bin/podman-compose'])).toEqual(['podman']);
    expect(engineOf(['mycompose'])).toBeUndefined();
  });
});
