import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildCoSpendClusters, clusterId, MemoryLabelLookup, toClusterSummary } from '../src/index.ts';
import { addr, rules, serviceLabel, shuffled, tx, txid } from './cospend-helpers.ts';

const runId = newId();
const deps = (extra: Partial<Parameters<typeof buildCoSpendClusters>[2]> = {}) => ({
  labels: new MemoryLabelLookup([]),
  prevTxs: new Map(),
  rules,
  ...extra,
});

describe('co-spend clustering', () => {
  it('AC1: chains co-spends into one cluster with merge evidence, independent of the input order', async () => {
    const txs = [
      tx('t1', [addr('A'), addr('B')], { height: 100 }),
      tx('t2', [addr('B'), addr('C')], { height: 101 }),
      tx('t3', [addr('X'), addr('Y')], { height: 102 }),
    ];
    const [cluster, ...rest] = await buildCoSpendClusters([addr('A')], txs, deps(), runId);
    expect(rest).toEqual([]);
    expect(cluster?.members).toEqual([addr('A'), addr('B'), addr('C')]);
    expect(cluster?.size).toBe(3);
    expect(cluster?.mergeEvidence).toEqual([
      { address: addr('B'), txid: txid('t1') },
      { address: addr('C'), txid: txid('t2') },
    ]);
    expect(cluster?.heuristic).toBe('co_spend');
    expect(cluster?.algorithmVersion).toBe('cospend.v1');
    expect(cluster?.flags).toEqual({ serviceMerge: false, capped: false });
    expect(cluster?.id).toBe(clusterId(cluster?.members ?? []));
    expect(cluster?.id).toMatch(/^c_[0-9a-f]{16}$/);
    const again = await Promise.all(
      [1, 2, 3].map((seed) => buildCoSpendClusters([addr('A')], shuffled(txs, seed), deps(), runId)),
    );
    for (const result of again) expect(result).toEqual([cluster]);
  });

  it('keeps members sorted and the id stable when the same members arrive through other seeds', async () => {
    const txs = [tx('t1', [addr('B'), addr('A')]), tx('t2', [addr('C'), addr('B')], { height: 101 })];
    const viaA = await buildCoSpendClusters([addr('A')], txs, deps(), runId);
    const viaC = await buildCoSpendClusters([addr('C')], txs, deps(), runId);
    expect(viaA[0]?.id).toBe(viaC[0]?.id);
    expect(viaA[0]?.members).toEqual([addr('A'), addr('B'), addr('C')]);
    const both = await buildCoSpendClusters([addr('C'), addr('A')], txs, deps(), runId);
    expect(both).toHaveLength(1);
    expect(both[0]?.seeds).toEqual([addr('A'), addr('C')]);
  });

  it('gives a seed that merged with nothing a cluster of one', async () => {
    const [cluster] = await buildCoSpendClusters([addr('A')], [tx('t1', [addr('X'), addr('Y')])], deps(), runId);
    expect(cluster).toMatchObject({
      seeds: [addr('A')],
      members: [addr('A')],
      size: 1,
      mergeEvidence: [],
      skipped: [],
    });
  });

  it('ignores unconfirmed transactions, coinbase inputs and single-address spends', async () => {
    const unconfirmed = { ...tx('u', [addr('A'), addr('B')]) };
    delete unconfirmed.blockHeight;
    const coinbase = tx('cb', [addr('A')]);
    coinbase.inputs.push({ value: '0', prevTxid: '', vout: 0 });
    const [cluster] = await buildCoSpendClusters([addr('A')], [unconfirmed, coinbase], deps(), runId);
    expect(cluster?.members).toEqual([addr('A')]);
  });

  it('AC9: never merges a change output with the inputs (no change-address heuristic)', async () => {
    const spend = tx('t1', [addr('A')], {
      outputs: [
        { address: addr('payee'), sats: 30_000 },
        { address: addr('fresh-change'), sats: 69_000 },
      ],
    });
    const [cluster] = await buildCoSpendClusters([addr('A')], [spend], deps(), runId);
    expect(cluster?.members).toEqual([addr('A')]);
  });

  it('AC7: stops at the size cap and records cap_reached', async () => {
    // A chain of two-input transactions: each adds one address, 1 200 addresses in total.
    const txs = Array.from({ length: 1199 }, (_, i) =>
      tx(`n${i}`, [addr(`m${i}`), addr(`m${i + 1}`)], { height: 100 + i }),
    );
    const [cluster] = await buildCoSpendClusters([addr('m0')], txs, deps({ maxClusterSize: 1000 }), runId);
    expect(cluster?.size).toBe(1000);
    expect(cluster?.flags.capped).toBe(true);
    expect(cluster?.skipped.length).toBeGreaterThan(0);
    expect(cluster?.skipped.every((s) => s.reason === 'cap_reached')).toBe(true);
  });

  it('AC8: reports the growth factor against the previous size', async () => {
    const txs = [tx('t1', [addr('A'), addr('B')])];
    const [grown] = await buildCoSpendClusters(
      [addr('A')],
      txs,
      deps({ previousSizes: new Map([[addr('A'), 1]]) }),
      runId,
    );
    expect(grown?.previousSize).toBe(1);
    expect(grown?.flags.growthFactor).toBe(2);
    const many = Array.from({ length: 4999 }, (_, i) =>
      tx(`g${i}`, [addr(`g${i}`), addr(`g${i + 1}`)], { height: 100 + i }),
    );
    const [big] = await buildCoSpendClusters(
      [addr('g0')],
      many,
      deps({ previousSizes: new Map([[addr('g0'), 40]]), maxClusterSize: 10_000 }),
      runId,
    );
    expect(big?.size).toBe(5000);
    expect(big?.flags.growthFactor).toBe(125);
    expect(toClusterSummary(big!)).toMatchObject({ size: 5000, previousSize: 40, growthFactor: 125, capped: false });
  });
});

describe('service guard', () => {
  it('AC6: records a labelled service spent with a seed without absorbing its other partners', async () => {
    const label = serviceLabel(addr('HOT-BTC-1'));
    const txs = [
      tx('t1', [addr('A'), addr('HOT-BTC-1')], { height: 100 }),
      tx('t2', [addr('HOT-BTC-1'), addr('customer')], { height: 101 }),
    ];
    const [cluster] = await buildCoSpendClusters(
      [addr('A')],
      txs,
      deps({ labels: new MemoryLabelLookup([label]) }),
      runId,
    );
    expect(cluster?.members).toEqual([addr('A')]);
    expect(cluster?.serviceMembers).toEqual([{ address: addr('HOT-BTC-1'), labelId: label.id }]);
    expect(cluster?.flags.serviceMerge).toBe(true);
    expect(toClusterSummary(cluster!)).toMatchObject({ serviceMerge: true, serviceMembers: [addr('HOT-BTC-1')] });
  });

  it('does not use a service as a bridge between two unrelated clusters', async () => {
    const txs = [tx('t1', [addr('A'), addr('S')], { height: 100 }), tx('t2', [addr('B'), addr('S')], { height: 101 })];
    const clusters = await buildCoSpendClusters(
      [addr('A'), addr('B')],
      txs,
      deps({ labels: new MemoryLabelLookup([serviceLabel(addr('S'))]) }),
      runId,
    );
    expect(clusters.map((c) => c.members)).toEqual(expect.arrayContaining([[addr('A')], [addr('B')]]));
    expect(clusters).toHaveLength(2);
  });

  it('merges the non-service inputs of a transaction that also spends a service', async () => {
    const [cluster] = await buildCoSpendClusters(
      [addr('A')],
      [tx('t1', [addr('A'), addr('B'), addr('S')])],
      deps({ labels: new MemoryLabelLookup([serviceLabel(addr('S'))]) }),
      runId,
    );
    expect(cluster?.members).toEqual([addr('A'), addr('B')]);
    expect(cluster?.flags.serviceMerge).toBe(true);
  });

  it('ignores a label that is not a deciding service label', async () => {
    const weak = serviceLabel(addr('S'));
    weak.provenance.deciding = false;
    const [cluster] = await buildCoSpendClusters(
      [addr('A')],
      [tx('t1', [addr('A'), addr('S')])],
      deps({ labels: new MemoryLabelLookup([weak]) }),
      runId,
    );
    expect(cluster?.members).toEqual([addr('A'), addr('S')]);
    expect(cluster?.flags.serviceMerge).toBe(false);
  });
});
