/**
 * The whole demo script against an in-process stack: the API app (memory store, offline mode) and the fixture site,
 * both on 127.0.0.1 with free ports. No network beyond loopback.
 */
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.ts';
import { reportRenderer } from '../../apps/api/src/stages.ts';
import { createFixtureServer, type FixtureServer } from '../../apps/fixture-site/src/fixture-server.ts';
import { createRuntime, defaultStages, type Runtime } from '../../apps/worker/src/index.ts';
import { createMemoryRepositories } from '../../packages/db/src/index.ts';
import { InMemoryBlobStore } from '../../packages/evidence/src/index.ts';
import { REPO_ROOT } from './expectations.ts';
import { runDemo } from './run.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let fixture: FixtureServer;
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let apiUrl = '';

beforeAll(async () => {
  fixture = await createFixtureServer({
    root: join(REPO_ROOT, 'apps/fixture-site/public'),
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: true,
  });
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: (rt) =>
      defaultStages({
        mode: rt.mode,
        sources: rt.sources,
        env: { OLCYS_FIXTURE_BASE_URL: fixture.url, FIXTURE_SITE_URL: fixture.url },
      }),
  });
  app = buildApp({ ...runtime, renderReport: reportRenderer(runtime) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
  await runtime?.idle();
  await runtime?.close();
  await fixture?.close();
});

describe('pnpm demo against an in-process stack', () => {
  it('runs v1 and v2 and passes its own self-check', { timeout: 240_000 }, async () => {
    const lines: string[] = [];
    const result = await runDemo({
      apiUrl,
      fixtureUrl: fixture.url,
      ci: true,
      pollMs: 200,
      log: (line) => lines.push(line),
    });
    expect(result.mismatches).toEqual([]);
    expect(result.exitCode).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Wariant strony testowej: v2');
    expect(text).toContain('Samokontrola:');
    expect(text).toContain(`/api/runs/${result.runIds[1]}/report`);
  });
});
