import type { AddressLabel, NormalizedTransfer } from '@olcys/core';
import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { createMemoryRepositories } from '../src/index.ts';

const label = (category: AddressLabel['category'], lastmod: string): AddressLabel => ({
  id: newId(),
  address: { chain: 'evm:1', address: '0x00000000000000000000000000000000000000a1' },
  entity: 'Giełda Testowa (SYNTHETIC)',
  category,
  attributes: {},
  provenance: {
    datasetId: 'demo-curated',
    url: 'fixtures',
    license: 'CC0-1.0',
    lastmod,
    retrievedAt: new Date().toISOString(),
  },
  confidence: 90,
});

describe('memory repositories', () => {
  it('keep the newest label version regardless of import order', async () => {
    const repos = createMemoryRepositories();
    await repos.labels.upsert([label('exchange', '2026-11-15T00:00:00.000Z')]);
    await repos.labels.upsert([label('unknown_service', '2026-11-01T00:00:00.000Z')]);
    await repos.labels.upsert([label('exchange', '2026-11-15T00:00:00.000Z')]);
    expect((await repos.labels.list()).map((l) => l.category)).toEqual(['exchange']);
  });

  it('store a copy of the case scope', async () => {
    const repos = createMemoryRepositories();
    const scope = { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 1 };
    const created = await repos.cases.create(
      {
        title: 'T',
        purpose: 'P',
        legalBasis: 'L',
        identifiers: [{ kind: 'nickname', value: 'x', isAnchor: true }],
        scope,
      },
      'test',
    );
    scope.enabledSources.push('mutated');
    expect((await repos.cases.get(created.id))?.scope.enabledSources).toEqual(['fixture_site']);
  });

  it('list a transfer stored under two analysed addresses once', async () => {
    const repos = createMemoryRepositories();
    const a = '0x00000000000000000000000000000000000000a1';
    const b = '0x00000000000000000000000000000000000000b2';
    const transfer: NormalizedTransfer = {
      chain: 'evm:1',
      txHash: '0xabc',
      blockHeight: 1,
      blockTime: '2026-11-01T00:00:00.000Z',
      from: a,
      to: b,
      asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
      amount: '1',
      kind: 'native',
      fetchId: newId(),
    };
    const runId = newId();
    await repos.chain.addTransfers(runId, { chain: 'evm:1', address: a }, [transfer]);
    await repos.chain.addTransfers(runId, { chain: 'evm:1', address: b }, [{ ...transfer, fetchId: newId() }]);
    expect(await repos.chain.listTransfers(runId)).toHaveLength(1);
  });
});

describe('memory addExtractions', () => {
  it('stores nothing when a later result cannot be written', async () => {
    const repos = createMemoryRepositories();
    const ok = { captureId: newId(), candidates: [], rejected: [], secrets: [], extractorVersion: 'test' };
    // A function is not cloneable, so the second write fails.
    const bad = { ...ok, captureId: newId(), extractorVersion: (() => 1) as unknown as string };
    const runId = newId();
    await expect(repos.evidence.addExtractions!(runId, [ok, bad])).rejects.toThrow(/clone/i);
    expect(await repos.evidence.listExtractionResults(runId)).toEqual([]);
    await repos.evidence.addExtractions!(runId, [ok]);
    expect(await repos.evidence.listExtractionResults(runId)).toHaveLength(1);
  });
});
