/**
 * The chain stage's boundaries on a case whose synthetic persona addresses are given as identifiers (no collection):
 * only the providers the case enables receive its addresses, a history that could not be fetched marks the run
 * partial, a rescore keeps that reason without fetching, and the labels used are stored. In-process fixture site,
 * in-memory store, no network.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { createChainStage, createRuntime, type Runtime } from '../src/index.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let server: FixtureServer;
let runtime: Runtime;
let manifest: { addresses: Record<string, { address: string }> };
const addressOf = (slot: string): string => manifest.addresses[slot]?.address ?? '';

beforeAll(async () => {
  manifest = JSON.parse(await readFile(join(REPO, 'fixtures/persona/manifest.json'), 'utf8')) as typeof manifest;
  server = await createFixtureServer({
    root: join(REPO, 'apps/fixture-site/public'),
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: false,
  });
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: (rt) => [
      createChainStage({
        mode: rt.mode,
        sources: rt.sources,
        env: { OLCYS_FIXTURE_BASE_URL: server.url, FIXTURE_SITE_URL: server.url },
      }),
    ],
  });
});
afterAll(async () => {
  await runtime?.idle();
  await runtime?.close();
  await server?.close();
});

describe('chain stage', () => {
  it(
    'sends addresses only to enabled providers and keeps missing histories visible in rescores',
    { timeout: 60_000 },
    async () => {
      const kase = await runtime.repos.cases.create(
        {
          title: 'Adresy podane wprost (test)',
          purpose: 'Test granic etapu analizy łańcucha na danych syntetycznych',
          legalBasis: 'test',
          identifiers: [
            { kind: 'crypto_address', value: addressOf('BTC-1'), chain: 'bitcoin', isAnchor: true },
            { kind: 'crypto_address', value: addressOf('TRON-1'), chain: 'tron', isAnchor: false },
          ],
          // TronGrid (AMBER) is not enabled for this case: the TRON address must not reach it.
          scope: { enabledSources: ['mempool_space'], amberJustifications: {}, chains: [], maxPivotDepth: 0 },
        },
        'test',
      );

      const first = await runtime.startRun(kase.id, {});
      await runtime.idle();
      const run = await runtime.repos.runs.get(first.id);
      expect(run?.status).toBe('partial');
      expect(run?.progress['partial']).toEqual([
        'chain data incomplete for 1 address(es): tron no enabled provider (1)',
      ]);

      const egress = await runtime.repos.evidence.listEgressLog(first.id);
      expect(egress.filter((e) => e.allowed).length).toBeGreaterThan(0);
      expect(new Set(egress.filter((e) => e.allowed).map((e) => e.sourceId))).toEqual(new Set(['mempool_space']));
      expect(egress.filter((e) => e.sourceId === 'trongrid' || e.sourceId === 'etherscan_v2')).toEqual([]);
      expect((await runtime.repos.analysis.listActivity(first.id)).length).toBeGreaterThan(0);
      // The labels the analysis used are stored for the report and the API.
      expect((await runtime.repos.labels.list()).length).toBeGreaterThan(0);

      const rescore = await runtime.startRun(kase.id, { trigger: 'rescore', rescoreOfRunId: first.id });
      await runtime.idle();
      const rescored = await runtime.repos.runs.get(rescore.id);
      expect(rescored?.status).toBe('partial');
      expect(rescored?.progress['partial']).toEqual(run?.progress['partial']);
      expect(await runtime.repos.evidence.listEgressLog(rescore.id)).toEqual([]);
    },
  );
});
