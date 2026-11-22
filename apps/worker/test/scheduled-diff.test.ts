/**
 * Two consecutive scheduled runs of the synthetic persona against the in-process fixture site, switched from variant
 * v1 to v2 between them: the second run is compared with the first and reports the swapped wallet. The case enables
 * only the forum source, so both runs stay short. In-memory store, no network.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { createRuntime, createScheduler, defaultStages, schedulesOf, type Runtime } from '../src/index.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let server: FixtureServer;
let runtime: Runtime;
let wallets: Record<string, { address: string }>;

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(join(REPO, 'fixtures/persona/manifest.json'), 'utf8')) as {
    addresses: typeof wallets;
  };
  wallets = manifest.addresses;
  server = await createFixtureServer({
    root: join(REPO, 'apps/fixture-site/public'),
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
        env: { OLCYS_FIXTURE_BASE_URL: server.url, FIXTURE_SITE_URL: server.url },
      }),
  });
});
afterAll(async () => {
  await runtime?.idle();
  await runtime?.close();
  await server?.close();
});

describe('scheduled re-runs of the synthetic persona', () => {
  it('compares the second scheduled run with the first and reports the wallet swap', { timeout: 60_000 }, async () => {
    const kase = await runtime.repos.cases.create(
      {
        title: 'Kacper Fikcyjny (harmonogram, demonstracja)',
        purpose: 'Demonstracja analiz okresowych na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
        scope: {
          enabledSources: ['bitcointalk'],
          amberJustifications: { bitcointalk: 'Sprawa demonstracyjna: dane syntetyczne persony' },
          chains: [],
          maxPivotDepth: 1,
        },
      },
      'test',
    );
    const clock = { now: new Date('2026-11-21T10:00:00.000Z') };
    await schedulesOf(runtime.repos).setSchedule(
      kase.id,
      { cron: '*/2 * * * *', enabled: true },
      { changedBy: 'test', reason: 'demonstracja analiz okresowych', at: clock.now.toISOString() },
    );
    const scheduler = createScheduler({
      runtime,
      settings: { intervalSeconds: 3600, minIntervalMinutes: 60 },
      clock: () => clock.now,
    });

    clock.now = new Date('2026-11-21T10:02:10.000Z');
    const [first] = await scheduler.evaluate();
    await runtime.idle();
    const switched = await fetch(`${server.url}/__fixture/variant`, { method: 'POST', body: 'v2' });
    expect(switched.status).toBe(204);
    clock.now = new Date('2026-11-21T10:04:10.000Z');
    const [second] = await scheduler.evaluate();
    await runtime.idle();

    expect(first).toMatchObject({ outcome: 'started', scheduledFor: '2026-11-21T10:02:00.000Z' });
    expect(second).toMatchObject({ outcome: 'started', scheduledFor: '2026-11-21T10:04:00.000Z' });
    // Without chain providers in scope the runs are partial — still completed runs the next one is compared with.
    expect(['succeeded', 'partial']).toContain((await runtime.repos.runs.get(first!.runId!))?.status);
    expect(await runtime.repos.runs.get(second!.runId!)).toMatchObject({
      trigger: 'schedule',
      previousRunId: first!.runId,
    });
    const changes = await runtime.repos.analysis.listChanges(second!.runId!);
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: 'VALUE_CHANGED',
        wallet: true,
        before: wallets['BTC-1']?.address,
        after: wallets['BTC-2']?.address,
        key: expect.objectContaining({ property: 'profile.bitcoin_address' }),
      }),
    );
  });
});
