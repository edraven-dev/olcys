import { describe, expect, it } from 'vitest';
import { compareVersions, parseComposePs, parseVersion, renderDoctor, runDoctor, type DoctorDeps } from './doctor.ts';
import type { Exec } from './exec.ts';

const ps = (items: object[]): string => items.map((i) => JSON.stringify(i)).join('\n');
const noCompose: Exec = async (cmd) => ({ code: cmd === 'pnpm' ? 0 : 127, stdout: '12.22.0', stderr: '' });
const HEALTHY = ps([
  { Service: 'postgres', State: 'running', Health: 'healthy' },
  { Service: 'gotenberg', State: 'running', Health: 'healthy' },
  { Service: 'fixture-site', State: 'running', Health: 'healthy' },
]);

function deps(psOut: string, over: Partial<DoctorDeps> = {}): DoctorDeps {
  const run: Exec = async (cmd, args) => {
    if (cmd === 'pnpm') return { code: 0, stdout: '12.22.0\n', stderr: '' };
    if (args.includes('version')) return { code: 0, stdout: 'v5', stderr: '' };
    if (args.includes('ps')) return { code: 0, stdout: psOut, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return {
    run,
    env: {},
    nodeVersion: '26.13.1',
    requirements: { node: '>=26.13.1', pnpm: '12.22.0' },
    envFile: true,
    portFree: async () => true,
    ...over,
  };
}

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('>=26.13.1')).toEqual([26, 13, 1]);
    expect(compareVersions([26, 13, 0], [26, 13, 1])).toBeLessThan(0);
    expect(compareVersions([27, 0, 0], [26, 13, 1])).toBeGreaterThan(0);
  });
});

describe('parseComposePs', () => {
  it('reads NDJSON, arrays and ignores banner lines', () => {
    expect(parseComposePs(`>>>> banner\n${HEALTHY}`)).toHaveLength(3);
    expect(parseComposePs(JSON.stringify([{ Service: 'a', State: 'running' }]))).toEqual([
      { service: 'a', state: 'running', health: '' },
    ]);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('garbage')).toBeUndefined();
  });
});

describe('runDoctor', () => {
  it('passes when everything is healthy, and our own services may hold their ports', async () => {
    const checks = await runDoctor(deps(HEALTHY, { portFree: async (p) => p === 4000 || p === 5173 }));
    const out = renderDoctor(checks);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('OK: all checks passed');
  });

  it('fails on an unhealthy or missing service', async () => {
    const out = renderDoctor(
      await runDoctor(
        deps(
          ps([
            { Service: 'postgres', State: 'running', Health: 'unhealthy' },
            { Service: 'gotenberg', State: 'exited', Health: '' },
          ]),
        ),
      ),
    );
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/✖ service postgres: running but health is "unhealthy"/);
    expect(out.text).toMatch(/✖ service gotenberg/);
    expect(out.text).toMatch(/✖ service fixture-site: not created/);
    expect(out.text).toContain('FAIL:');
  });

  it('fails on old node, missing .env and a foreign process on a service port; app ports only warn', async () => {
    const out = renderDoctor(
      await runDoctor(
        deps('', { nodeVersion: '24.0.0', envFile: false, portFree: async (p) => p !== 5432 && p !== 4000 }),
      ),
    );
    expect(out.text).toMatch(/✖ node/);
    expect(out.text).toMatch(/✖ \.env/);
    expect(out.text).toMatch(/✖ port 5432: taken by another process/);
    expect(out.text).toMatch(/! port 4000/);
  });

  it('fails when no compose command works', async () => {
    const out = renderDoctor(await runDoctor(deps('', { run: noCompose })));
    expect(out.text).toMatch(/✖ compose/);
    expect(out.ok).toBe(false);
  });
});
