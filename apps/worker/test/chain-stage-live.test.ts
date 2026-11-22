/**
 * Live runs never use the synthetic demo data: no demo labels reach the store and no synthetic price is offered.
 * Chain selection of a case (`scope.chains`) is a pure rule tested here as well. No network (no address, no request).
 */
import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { chainSelected, createChainStage, createRuntime, noPriceSource } from '../src/index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('chain stage in live mode', () => {
  it('stores no synthetic labels and offers no price', async () => {
    const runtime = await createRuntime({
      env: { OLCYS_MODE: 'live' },
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      logger: silent,
      stages: (rt) => [createChainStage({ mode: rt.mode, sources: rt.sources, env: {} })],
    });
    const kase = await runtime.repos.cases.create(
      {
        title: 'Tryb live bez adresów (test)',
        purpose: 'Test braku danych syntetycznych w trybie live',
        legalBasis: 'test',
        identifiers: [{ kind: 'nickname', value: 'x', isAnchor: true }],
        scope: { enabledSources: ['mempool_space'], amberJustifications: {}, chains: [], maxPivotDepth: 0 },
      },
      'test',
    );
    const started = await runtime.startRun(kase.id, {});
    await runtime.idle();
    expect((await runtime.repos.runs.get(started.id))?.status).toBe('succeeded');
    expect(await runtime.repos.labels.list()).toEqual([]);
    expect(await runtime.repos.evidence.listEgressLog(started.id)).toEqual([]);
    await runtime.close();
  });

  it('has a price source that never prices', async () => {
    await expect(noPriceSource().price('BTC', 'USD', '2026-11-01T00:00:00.000Z')).rejects.toMatchObject({
      reason: 'no_candle',
    });
  });
});

describe('chainSelected', () => {
  it('selects everything when the case lists no chains', () => {
    expect(chainSelected('tron', [])).toBe(true);
  });
  it('selects listed chains only', () => {
    expect(chainSelected('bitcoin', ['bitcoin'])).toBe(true);
    expect(chainSelected('tron', ['bitcoin'])).toBe(false);
    expect(chainSelected('evm:1', ['evm:137'])).toBe(false);
  });
  it('analyses an address of unknown EVM chain when any EVM chain is selected', () => {
    expect(chainSelected('evm:unknown', ['evm:137'])).toBe(true);
    expect(chainSelected('evm:unknown', ['bitcoin'])).toBe(false);
  });
});
