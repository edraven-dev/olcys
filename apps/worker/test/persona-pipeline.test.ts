/**
 * The demo scenario end to end on the synthetic persona: the runtime with the real stages (collectors over the egress
 * client and robots.txt, address extraction, scoring) against the in-process fixture site, then a v2 re-run that must
 * report the swapped wallet. In-memory store, no network.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { createRuntime, defaultStages, type Runtime } from '../src/index.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const JUSTIFICATION = 'Sprawa demonstracyjna: dane syntetyczne persony';

let server: FixtureServer;
let runtime: Runtime;
let manifest: { addresses: Record<string, { address: string }> };
const addressOf = (slot: string): string => manifest.addresses[slot]?.address.toLowerCase() ?? '';

beforeAll(async () => {
  manifest = JSON.parse(await readFile(join(REPO, 'fixtures/persona/manifest.json'), 'utf8')) as typeof manifest;
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
  await runtime?.close();
  await server?.close();
});

describe('demo scenario on the synthetic persona', () => {
  it('collects, extracts and scores the persona, then detects the swapped wallet on re-run', async () => {
    const kase = await runtime.repos.cases.create(
      {
        title: 'Kacper Fikcyjny (demonstracja)',
        purpose: 'Demonstracja na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [
          { kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true },
          { kind: 'full_name', value: 'Kacper Fikcyjny', isAnchor: false },
          { kind: 'email', value: 'kacper.fikcyjny@example.org', isAnchor: false },
        ],
        scope: {
          enabledSources: ['bitcointalk', 'wykop', 'github', 'telegram_preview'],
          amberJustifications: {
            bitcointalk: JUSTIFICATION,
            wykop: JUSTIFICATION,
            github: JUSTIFICATION,
            telegram_preview: JUSTIFICATION,
          },
          chains: [],
          maxPivotDepth: 2,
        },
      },
      'test',
    );

    const first = await runtime.startRun(kase.id, {});
    await runtime.idle();
    const run1 = await runtime.repos.runs.get(first.id);
    expect(run1?.status).toBe('succeeded');
    expect(run1?.config.weightsVersion).toBe('weights.v2');

    const links = await runtime.repos.analysis.listLinks(first.id);
    const score = (slot: string) =>
      links.filter((l) => l.address.address.toLowerCase() === addressOf(slot)).map((l) => l.score);
    expect(score('BTC-1')).toContain(99);
    expect(score('TRON-1')).toContain(77);
    expect(score('ETH-2')).toContain(24);

    // Nothing secret or third-party-only becomes an ownership link with a positive score.
    expect(score('TRON-2').every((s) => s === 0)).toBe(true);
    const egress = await runtime.repos.evidence.listEgressLog(first.id);
    expect(egress.length).toBeGreaterThan(0);
    expect(egress.every((e) => e.host === '127.0.0.1')).toBe(true);

    const switched = await fetch(`${server.url}/__fixture/variant`, { method: 'POST', body: 'v2' });
    expect(switched.status).toBe(204);
    const second = await runtime.startRun(kase.id, {});
    await runtime.idle();
    expect((await runtime.repos.runs.get(second.id))?.previousRunId).toBe(first.id);
    const changes = await runtime.repos.analysis.listChanges(second.id);
    const swap = changes.find((c) => c.kind === 'VALUE_CHANGED' && c.key.property === 'profile.bitcoin_address');
    expect(swap).toMatchObject({
      before: manifest.addresses['BTC-1']?.address,
      after: manifest.addresses['BTC-2']?.address,
    });

    // A rescore of the first run re-scores its saved evidence: no fetching, the v1 data, no data changes.
    const rescore = await runtime.startRun(kase.id, { trigger: 'rescore', rescoreOfRunId: first.id });
    await runtime.idle();
    const rescored = await runtime.repos.runs.get(rescore.id);
    expect(rescored).toMatchObject({ status: 'succeeded', previousRunId: first.id, rescoreOfRunId: first.id });
    expect(await runtime.repos.evidence.listCaptures(rescore.id)).toEqual([]);
    expect(await runtime.repos.evidence.listEgressLog(rescore.id)).toEqual([]);
    const rescoredLinks = await runtime.repos.analysis.listLinks(rescore.id);
    const rescoredScore = (slot: string) =>
      rescoredLinks.filter((l) => l.address.address.toLowerCase() === addressOf(slot)).map((l) => l.score);
    expect(rescoredScore('BTC-1')).toContain(99);
    expect(rescoredScore('BTC-2')).toEqual([]);
    expect(await runtime.repos.analysis.listChanges(rescore.id)).toEqual([]);

    // Rescoring a rescore still reads the evidence of the run that collected it.
    const again = await runtime.startRun(kase.id, { trigger: 'rescore', rescoreOfRunId: rescore.id });
    await runtime.idle();
    expect(await runtime.repos.runs.get(again.id)).toMatchObject({
      status: 'succeeded',
      rescoreOfRunId: first.id,
      previousRunId: rescore.id,
    });
    const againLinks = await runtime.repos.analysis.listLinks(again.id);
    expect(
      againLinks.filter((l) => l.address.address.toLowerCase() === addressOf('BTC-1')).map((l) => l.score),
    ).toContain(99);
  });
});
