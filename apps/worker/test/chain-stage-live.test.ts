/**
 * Live runs never use the synthetic demo data: no demo labels reach the store and no synthetic price is offered.
 * Chain selection of a case (`scope.chains`) is a pure rule tested here as well. No network (no address, no request).
 */
import type { Logger } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { chainSelected, createChainStage, createRuntime, noPriceSource, trackUnpriced } from '../src/index.ts';

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

describe('chain stage in live mode with demo labels already in the store', () => {
  it('neither uses nor cites the synthetic labels', async () => {
    const repos = createMemoryRepositories();
    const exchange = '0x00000000000000000000000000000000000000a1';
    // As an offline run leaves them: the demo dataset's labels, flagged synthetic.
    await repos.labels.upsert([
      {
        id: newId(),
        address: { chain: 'evm:1', address: exchange },
        entity: 'Giełda Testowa (SYNTHETIC)',
        category: 'exchange',
        attributes: {},
        provenance: {
          datasetId: 'demo-curated',
          url: 'fixtures',
          license: 'CC0-1.0',
          lastmod: '2026-11-15T00:00:00.000Z',
          retrievedAt: '2026-11-15T00:00:00.000Z',
          deciding: true,
          synthetic: true,
        },
        confidence: 90,
      },
    ]);
    const runtime = await createRuntime({
      env: { OLCYS_MODE: 'live' },
      repos,
      blobs: new InMemoryBlobStore(),
      logger: silent,
      stages: (rt) => [createChainStage({ mode: rt.mode, sources: rt.sources, env: {} })],
    });
    const kase = await repos.cases.create(
      {
        title: 'Tryb live, etykiety w magazynie (test)',
        purpose: 'Test pominięcia etykiet syntetycznych w trybie live',
        legalBasis: 'test',
        // The address has a synthetic exchange label; no request can be made without an enabled provider.
        identifiers: [{ kind: 'crypto_address', value: exchange, chain: 'evm:1', isAnchor: true }],
        scope: { enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 0 },
      },
      'test',
    );
    const started = await runtime.startRun(kase.id, {});
    await runtime.idle();
    // The demo label would have excluded the address (A1) before any fetch; live ignores it.
    const decisions = await repos.analysis.listExclusions(started.id);
    expect(decisions.flatMap((d) => d.evidence.labelIds ?? [])).toEqual([]);
    expect(decisions.some((d) => d.ruleId === 'A1')).toBe(false);
    await runtime.close();
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

describe('missing valuations', () => {
  it('counts transfers, not price calculations: equal transfers of two transactions are two missing values', async () => {
    const asset = { chain: 'evm:1', symbol: 'ETH', decimals: 18 } as const;
    const transfer = (txHash: string) => ({
      chain: 'evm:1' as const,
      txHash,
      blockHeight: 1,
      blockTime: '2026-11-01T10:00:00.000Z',
      from: '0xa',
      to: '0xb',
      asset,
      amount: '1',
      kind: 'native' as const,
      fetchId: 'f',
    });
    const tracked = trackUnpriced({
      value: async () => ({ status: 'unpriced', reason: 'no_candle' }) as const,
    });
    const [one, two] = [transfer('0x1'), transfer('0x2')];
    await tracked.valuator.value({ asset, amount: '1', at: one.blockTime }, {} as never);
    expect(tracked.unpricedTransfers([one, two, one])).toBe(2);
    expect(tracked.unpricedTransfers([])).toBe(0);
  });

  it('counts a Bitcoin net amount that could not be valued, once per transaction (a self-send costs the fee)', async () => {
    const address = { chain: 'bitcoin', address: 'bc1qself' } as const;
    // A self-send: 0.0010 BTC in, 0.0009 BTC back to the same address; no transfer, but a net fee of 0.0001 BTC.
    const tx = {
      chain: 'bitcoin' as const,
      txid: 'tx-self',
      blockTime: '2026-11-01T10:00:00.000Z',
      inputs: [{ address: address.address, value: '0.0010', prevTxid: 'p', vout: 0 }],
      outputs: [{ address: address.address, value: '0.0009', n: 0 }],
      fetchId: 'f',
    };
    const tracked = trackUnpriced({ value: async () => ({ status: 'unpriced', reason: 'no_candle' }) as const });
    await tracked.valuator.value(
      { asset: { chain: 'bitcoin', symbol: 'BTC', decimals: 8 }, amount: '0.0001', at: tx.blockTime },
      {} as never,
    );
    expect(tracked.unpricedTransfers([])).toBe(0);
    expect(tracked.unpricedNetTxs(address, [tx, tx])).toEqual(['bitcoin|tx-self', 'bitcoin|tx-self']);
    expect(new Set(tracked.unpricedNetTxs(address, [tx, tx])).size).toBe(1);
  });
});
