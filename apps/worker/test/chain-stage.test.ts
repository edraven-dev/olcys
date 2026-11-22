/**
 * The chain stage's boundaries on a case whose synthetic persona addresses are given as identifiers (no collection):
 * only the providers the case enables receive its addresses, a history that could not be fetched marks the run
 * partial, a rescore keeps that reason without fetching, and the labels used are stored. In-process fixture site,
 * in-memory store, no network.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger, NormalizedTransfer } from '@olcys/core';
import { transferKey } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { createChainStage, createRuntime, type Runtime } from '../src/index.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let server: FixtureServer;
let runtime: Runtime;
/** Every `addTransfers` call of the shared repositories, in order. */
const stored: NormalizedTransfer[][] = [];
/** Every progress record written to a run (the last one replaces the stage details with the finish summary). */
const progressLog: Record<string, unknown>[] = [];
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
  const repos = createMemoryRepositories();
  const addTransfers = repos.chain.addTransfers.bind(repos.chain);
  repos.chain.addTransfers = async (runId, address, transfers, options) => {
    stored.push(transfers);
    await addTransfers(runId, address, transfers, options);
  };
  const updateRun = repos.runs.update.bind(repos.runs);
  repos.runs.update = async (id, patch) => {
    if (patch.progress) progressLog.push(patch.progress);
    await updateRun(id, patch);
  };
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos,
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
      // The NBP source is not enabled for this case either, so no transfer has a PLN value: stated, not silent.
      expect(run?.progress['partial']).toEqual([
        'chain data incomplete for 1 address(es): tron no enabled provider (1)',
        expect.stringMatching(/^PLN valuation unavailable for \d+ transfer\(s\)/),
      ]);
      const codes = (run?.progress['partialCodes'] ?? []) as { code: string }[];
      expect(codes[0]).toMatchObject({
        params: { count: 1, items: [{ chain: 'tron', status: 'no_enabled_provider', count: 1 }] },
      });
      expect(codes.map((r) => r.code)).toEqual(['chain_incomplete', 'valuation_unavailable']);

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

  it('analyses only the chains the case selects and notes the skipped ones without making the run partial', async () => {
    const kase = await runtime.repos.cases.create(
      {
        title: 'Wybór łańcuchów (test)',
        purpose: 'Test wyboru łańcuchów sprawy na danych syntetycznych',
        legalBasis: 'test',
        identifiers: [
          { kind: 'crypto_address', value: addressOf('BTC-1'), chain: 'bitcoin', isAnchor: true },
          { kind: 'crypto_address', value: addressOf('TRON-1'), chain: 'tron', isAnchor: false },
        ],
        scope: {
          enabledSources: ['mempool_space', 'nbp_api'],
          amberJustifications: {},
          chains: ['bitcoin'],
          maxPivotDepth: 0,
        },
      },
      'test',
    );
    progressLog.length = 0;
    const started = await runtime.startRun(kase.id, {});
    await runtime.idle();
    const run = await runtime.repos.runs.get(started.id);
    expect(progressLog.find((p) => p['skippedByChain'] !== undefined)).toMatchObject({
      skippedByChain: 1,
      skippedChains: ['tron'],
    });
    expect(run?.status).toBe('succeeded');
    // TRON was not selected, so its missing provider is not an incomplete history either.
    expect(JSON.stringify(run?.progress['partial'] ?? [])).not.toContain('tron');
    const activity = await runtime.repos.analysis.listActivity(started.id);
    expect(activity.map((a) => a.address.chain)).toEqual(['bitcoin']);
  });

  it('stores a transfer between two analysed addresses once per run', async () => {
    const kase = await runtime.repos.cases.create(
      {
        title: 'Wspólny transfer (test)',
        purpose: 'Test jednokrotnego zapisu transferu między analizowanymi adresami',
        legalBasis: 'test',
        identifiers: [
          { kind: 'crypto_address', value: addressOf('BTC-1'), chain: 'bitcoin', isAnchor: true },
          { kind: 'crypto_address', value: addressOf('BTC-2'), chain: 'bitcoin', isAnchor: false },
        ],
        scope: { enabledSources: ['mempool_space', 'nbp_api'], amberJustifications: {}, chains: [], maxPivotDepth: 0 },
      },
      'test',
    );
    stored.length = 0;
    const started = await runtime.startRun(kase.id, {});
    await runtime.idle();
    expect((await runtime.repos.analysis.listActivity(started.id)).length).toBe(2);
    const keys = stored.flat().map(transferKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    const listed = (await runtime.repos.chain.listTransfers(started.id)).map(transferKey);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('looks an address of unknown EVM chain up on the selected EVM chain, not on Ethereum', async () => {
    const kase = await runtime.repos.cases.create(
      {
        title: 'Wybrany łańcuch EVM (test)',
        purpose: 'Test zapytań o adres bez znanego łańcucha EVM',
        legalBasis: 'test',
        identifiers: [{ kind: 'crypto_address', value: addressOf('ETH-2'), chain: 'evm:unknown', isAnchor: true }],
        scope: {
          enabledSources: ['etherscan_v2'],
          amberJustifications: { etherscan_v2: 'Test: adres syntetyczny, zapytania do strony testowej' },
          chains: ['evm:137'],
          maxPivotDepth: 0,
        },
      },
      'test',
    );
    const started = await runtime.startRun(kase.id, {});
    await runtime.idle();
    const urls = (await runtime.repos.evidence.listEgressLog(started.id))
      .filter((e) => e.sourceId === 'etherscan_v2')
      .map((e) => e.urlRedacted);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes('chainid=137'))).toBe(true);
  });
});
