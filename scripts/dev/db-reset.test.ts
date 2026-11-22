import { describe, expect, it } from 'vitest';
import { buildPlan, resetDatabase } from './db-reset.ts';
import type { Exec } from './exec.ts';

function harness(failAt?: string) {
  const calls: string[] = [];
  const log: string[] = [];
  let migrated = 0;
  const run: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    return { code: failAt && line.includes(failAt) ? 1 : 0, stdout: '', stderr: 'boom' };
  };
  return {
    calls,
    log,
    migrated: () => migrated,
    deps: {
      run,
      env: {},
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
    expect(h.calls.every((c) => c.endsWith('version'))).toBe(true);
    expect(h.migrated()).toBe(0);
  });

  it('--dry-run stops after the plan even with --yes', async () => {
    const h = harness();
    expect(await resetDatabase(['--yes', '--dry-run'], h.deps)).toBe(0);
    expect(h.calls.every((c) => c.endsWith('version'))).toBe(true);
    expect(h.migrated()).toBe(0);
  });

  it('with --yes removes container and volume, restarts postgres and migrates', async () => {
    const h = harness();
    expect(await resetDatabase(['--yes'], h.deps)).toBe(0);
    const steps = h.calls.filter((c) => !c.endsWith('version'));
    expect(steps).toEqual([
      'docker compose stop postgres',
      'docker compose rm --force postgres',
      'docker volume rm --force olcys_postgres-data',
      'docker compose up -d --wait postgres',
    ]);
    expect(h.migrated()).toBe(1);
  });

  it('stops at the first failing step and does not migrate', async () => {
    const h = harness('volume rm');
    expect(await resetDatabase(['--yes'], h.deps)).toBe(1);
    expect(h.migrated()).toBe(0);
    expect(h.calls.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('honours COMPOSE_PROJECT_NAME and podman', () => {
    const plan = buildPlan(['podman', 'compose'], { COMPOSE_PROJECT_NAME: 'x' });
    expect(plan.steps[2]).toMatchObject({ command: 'podman', args: ['volume', 'rm', '--force', 'x_postgres-data'] });
  });
});
