import { describe, expect, it } from 'vitest';
import { compareVersions, parseComposePs, parseVersion, renderDoctor, runDoctor, type DoctorDeps } from './doctor.ts';
import type { Exec } from './exec.ts';

const ps = (items: object[]): string => items.map((i) => JSON.stringify(i)).join('\n');
const noCompose: Exec = async (cmd) => ({ code: cmd === 'pnpm' ? 0 : 127, stdout: '12.22.0', stderr: '' });
const publishes = (port: number) => [{ URL: '127.0.0.1', TargetPort: port, PublishedPort: port, Protocol: 'tcp' }];
const HEALTHY = ps([
  { Service: 'postgres', State: 'running', Health: 'healthy', Publishers: publishes(5432) },
  { Service: 'gotenberg', State: 'running', Health: 'healthy', Publishers: publishes(3100) },
  { Service: 'fixture-site', State: 'running', Health: 'healthy', Publishers: publishes(4100) },
]);
/** Ports held by our own compose services and the dev servers (`portFree` is false for them). */
const busy =
  (...ports: number[]) =>
  async (p: number) =>
    !ports.includes(p);

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

  it('reads the published host ports of docker compose, podman and the Ports text', () => {
    const [docker, podman, text, exposed] =
      parseComposePs(
        ps([
          { Service: 'a', Publishers: [...publishes(5433), { TargetPort: 9, PublishedPort: 0, Protocol: 'tcp' }] },
          { Service: 'b', Ports: [{ host_ip: '127.0.0.1', container_port: 80, host_port: 8080, range: 2 }] },
          { Service: 'c', Ports: '127.0.0.1:3100->3000/tcp, [::1]:3100->3000/tcp' },
          { Service: 'd', Ports: '5432/tcp' },
        ]),
      ) ?? [];
    expect(docker?.published).toEqual([5433]);
    expect(podman?.published).toEqual([8080, 8081]);
    expect(text?.published).toEqual([3100, 3100]);
    expect(exposed?.published).toEqual([]);
  });
});

describe('runDoctor', () => {
  it('passes when everything is healthy, and our own services may hold their ports', async () => {
    const checks = await runDoctor(deps(HEALTHY, { portFree: busy(5432, 3100, 4100) }));
    const out = renderDoctor(checks);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('OK: all checks passed');
    expect(out.text).not.toContain('warning');
    expect(out.text).toMatch(/✔ port 5432: published by our postgres/);
  });

  it('fails when a running service publishes another port than the one configured in .env', async () => {
    // POSTGRES_PORT changed in .env, container not recreated; another process may hold 5433.
    const out = renderDoctor(
      await runDoctor(deps(HEALTHY, { env: { POSTGRES_PORT: '5433' }, portFree: busy(5432, 5433, 3100, 4100) })),
    );
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/✖ port 5433: POSTGRES_PORT is 5433 but the running postgres publishes 5432/);
  });

  it('without port data in compose ps a busy port only warns and a free one fails', async () => {
    const noPorts = ps([
      { Service: 'postgres', State: 'running', Health: 'healthy' },
      { Service: 'gotenberg', State: 'running', Health: 'healthy' },
      { Service: 'fixture-site', State: 'running', Health: 'healthy' },
    ]);
    const out = renderDoctor(await runDoctor(deps(noPorts, { portFree: busy(5432, 3100) })));
    expect(out.text).toMatch(/! port 5432: in use, but `compose ps` gave no port data/);
    expect(out.text).toMatch(/✖ port 4100: nothing listens on it although fixture-site is running/);
    expect(out.ok).toBe(false);
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
