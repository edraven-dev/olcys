/**
 * The stack of the acceptance test as one child process: the API with its in-process worker (memory store, offline
 * mode) and the fixture site with the variant switch, both on free loopback ports. Prints one `READY {json}` line.
 * Stopped with SIGTERM by the global setup (by PID).
 */
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../apps/api/src/app.ts';
import { reportRenderer } from '../../apps/api/src/stages.ts';
import { createFixtureServer } from '../../apps/fixture-site/src/fixture-server.ts';
import { createRuntime, defaultStages } from '../../apps/worker/src/index.ts';
import { createMemoryRepositories } from '../../packages/db/src/index.ts';
import { InMemoryBlobStore } from '../../packages/evidence/src/index.ts';
import { REPO_ROOT } from '../../scripts/demo/expectations.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const webPort = process.env['E2E_WEB_PORT'];
if (!webPort) throw new Error('E2E_WEB_PORT is required (the API origin guard allows only the console origin).');

const fixture = await createFixtureServer({
  root: join(REPO_ROOT, 'apps/fixture-site/public'),
  variant: 'v1',
  host: '127.0.0.1',
  port: 0,
  allowVariantSwitch: true,
});
const runtime = await createRuntime({
  env: {
    OLCYS_MODE: 'offline',
    // Optional: the local model (OVMS from .env.example) suggests roles; it never decides.
    ...(process.env['E2E_LLM'] === '1'
      ? {
          LLM_ENABLED: 'true',
          LLM_MAX_MENTIONS_PER_RUN: '1',
          LLM_BASE_URL: process.env['LLM_BASE_URL'] ?? 'http://localhost:2140/v3',
          LLM_MODEL: process.env['LLM_MODEL'] ?? 'qwen3.6-35b-ov',
          LLM_CHAT_TEMPLATE_KWARGS: '{"enable_thinking":false}',
        }
      : {}),
  },
  repos: createMemoryRepositories(),
  blobs: new InMemoryBlobStore(),
  logger: silent,
  stages: (rt) =>
    defaultStages({
      mode: rt.mode,
      sources: rt.sources,
      llm: rt.llm,
      env: {
        OLCYS_FIXTURE_BASE_URL: fixture.url,
        FIXTURE_SITE_URL: fixture.url,
        ...(process.env['E2E_LLM'] === '1' ? { LLM_MAX_MENTIONS_PER_RUN: '1' } : {}),
      },
    }),
});
const app = buildApp({ ...runtime, renderReport: reportRenderer(runtime), guard: { webPort } });
await app.listen({ host: '127.0.0.1', port: 0 });
const apiPort = (app.server.address() as AddressInfo).port;

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await runtime.idle();
  await runtime.close();
  await fixture.close();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

console.log(`READY ${JSON.stringify({ apiPort, fixtureUrl: fixture.url })}`);
