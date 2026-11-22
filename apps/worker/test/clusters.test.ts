/**
 * The expansion of co-spend partners (apps/worker/src/clusters.ts): rounds bounded by depth, labelled services never
 * fetched, incomplete histories reported as outcomes. A scripted Bitcoin provider (no network), synthetic addresses.
 */
import { ChainProviderError, ChainProviderRegistry, TipCache } from '@olcys/chain-adapters';
import type { ChainProvider, RunContext, UtxoTransaction } from '@olcys/core';
import { fromBaseUnits, newId } from '@olcys/core';
import { loadExclusionRules, loadDenyList, MemoryLabelLookup, type ExclusionDeps } from '@olcys/labels';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusterBitcoin } from '../src/clusters.ts';
import { historyGaps } from '../src/chain-data.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const rules = loadExclusionRules(read('config/rules/exclusion.v1.yaml'));
const denyList = loadDenyList(read('config/rules/deny-list.v1.yaml'));

const runCtx: RunContext = {
  runId: newId(),
  caseId: newId(),
  mode: 'offline',
  http: { fetch: () => Promise.reject(new Error('tests never use the network')) },
  blobs: {
    put: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    has: () => Promise.resolve(false),
  },
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

const a = (name: string): string => `bc1q-${name}`;
const spend = (name: string, height: number, inputs: string[]): UtxoTransaction => ({
  chain: 'bitcoin',
  txid: `tx-${name}`,
  blockHeight: height,
  blockTime: '2026-01-01T00:00:00.000Z',
  inputs: inputs.map((address, i) => ({ address, value: '0.001', prevTxid: `funding-${name}-${i}`, vout: 0 })),
  outputs: [{ address: a(`out-${name}`), value: fromBaseUnits('50000', 8), n: 0 }],
  fetchId: newId(),
});

/** History per address; an address in `failing` answers with a provider error. */
function scripted(history: Record<string, UtxoTransaction[]>, failing: string[] = []) {
  const requests: string[] = [];
  const provider: ChainProvider = {
    id: 'scripted',
    chains: ['bitcoin'],
    getTip: () => Promise.resolve({ height: 1_000_000, hash: 'tip', observedAt: '2026-11-21T12:00:00.000Z' }),
    getAddressSummary: () => Promise.reject(new Error('not used')),
    listTransfers: () => Promise.resolve({ items: [] }),
    listUtxoTransactions: (address) => {
      requests.push(address.address);
      if (failing.includes(address.address)) {
        return Promise.reject(new ChainProviderError('rate_limited', 'scripted', 'HTTP 429'));
      }
      return Promise.resolve({ items: history[address.address] ?? [] });
    },
  };
  const registry = new ChainProviderRegistry();
  registry.register(provider, {
    id: 'scripted',
    kind: 'esplora',
    sourceId: 'mempool_space',
    baseUrl: 'https://example.invalid',
    chains: ['bitcoin'],
    priority: 1,
  });
  return { registry, requests };
}

const exclusionDeps = (labels: MemoryLabelLookup): ExclusionDeps => ({ labels, rules, denyList, runId: runCtx.runId });
const input = (txs: UtxoTransaction[], registry: ChainProviderRegistry, labels = new MemoryLabelLookup([])) => ({
  seeds: [a('A')],
  txs,
  fetched: new Set([a('A')]),
  exclusionDeps: exclusionDeps(labels),
  providers: registry,
  runCtx,
  chainSources: ['mempool_space'],
  tips: new TipCache(),
  runId: runCtx.runId,
});

describe('clusterBitcoin', () => {
  it('fetches the partners of the seeds round by round, at most two hops deep', async () => {
    const t1 = spend('t1', 100, [a('A'), a('B')]);
    const t2 = spend('t2', 101, [a('B'), a('C')]);
    const t3 = spend('t3', 102, [a('C'), a('D')]);
    const t4 = spend('t4', 103, [a('D'), a('E')]);
    const { registry, requests } = scripted({ [a('B')]: [t1, t2], [a('C')]: [t2, t3], [a('D')]: [t3, t4] });
    const result = await clusterBitcoin(input([t1], registry));
    // Round 1 fetches B (partner of the seed), round 2 fetches C; D is found but not fetched (depth bound).
    expect(requests).toEqual([a('B'), a('C')]);
    expect(result.expanded).toBe(2);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.members).toEqual([a('A'), a('B'), a('C'), a('D')]);
    expect(result.clusters[0]?.mergeEvidence.map((e) => e.txid)).toEqual(['tx-t1', 'tx-t2', 'tx-t3']);
    expect(result.outcomes.every((o) => o.status === 'ok')).toBe(true);
  });

  it('never fetches a labelled service and does not merge through it', async () => {
    const t1 = spend('t1', 100, [a('A'), a('SERVICE')]);
    const label = {
      id: newId(),
      address: { chain: 'bitcoin' as const, address: a('SERVICE') },
      entity: 'Giełda Testowa (SYNTHETIC)',
      category: 'exchange' as const,
      attributes: {},
      provenance: {
        datasetId: 'test-por',
        url: 'https://example.invalid',
        license: 'CC0-1.0',
        lastmod: '2026-01-01T00:00:00Z',
        retrievedAt: '2026-01-01T00:00:00Z',
        sourceType: 'por_file' as const,
        deciding: true,
        synthetic: true,
      },
      confidence: 95,
    };
    const { registry, requests } = scripted({ [a('SERVICE')]: [spend('t2', 101, [a('SERVICE'), a('CUSTOMER')])] });
    const result = await clusterBitcoin(input([t1], registry, new MemoryLabelLookup([label])));
    expect(requests).toEqual([]);
    expect(result.clusters[0]?.members).toEqual([a('A')]);
    expect(result.clusters[0]?.flags.serviceMerge).toBe(true);
  });

  it('reports a partner whose history could not be fetched', async () => {
    const t1 = spend('t1', 100, [a('A'), a('B')]);
    const { registry, requests } = scripted({}, [a('B')]);
    const result = await clusterBitcoin(input([t1], registry));
    expect(requests).toEqual([a('B')]);
    expect(result.clusters[0]?.members).toEqual([a('A'), a('B')]);
    expect(historyGaps(result.outcomes)).toMatchObject({
      count: 1,
      items: [{ chain: 'bitcoin', status: 'rate_limited', count: 1 }],
    });
  });

  it('does not expand a seed that merged with nothing', async () => {
    const { registry, requests } = scripted({});
    const result = await clusterBitcoin(input([spend('t1', 100, [a('A')])], registry));
    expect(requests).toEqual([]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.size).toBe(1);
  });

  it('keeps the expansion within 200 addresses', async () => {
    const partners = Array.from({ length: 250 }, (_, i) => a(`p${String(i).padStart(3, '0')}`));
    const t1 = spend('t1', 100, [a('A'), ...partners]);
    const { registry, requests } = scripted({});
    await clusterBitcoin(input([t1], registry));
    expect(requests).toHaveLength(200);
  });
});
