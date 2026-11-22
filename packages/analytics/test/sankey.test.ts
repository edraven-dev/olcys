/** Sankey aggregate: layers, acyclic links, PLN completeness, top-N cut with a remainder node per layer. */
import type { AddressLabel } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildSankey, edgeLayers } from '../src/index.ts';
import { edge } from './flow-helpers.ts';

const T = (n: number): string => new Date(Date.UTC(2026, 2, n)).toISOString();
const label = (address: string, entity: string): [string, AddressLabel] => [
  `tron:${address}`,
  { entity, category: 'exchange', address: { chain: 'tron', address } } as AddressLabel,
];

describe('buildSankey', () => {
  it('lays three senders, the subject and a labelled hot wallet out in layers −1, 0 and 1', () => {
    const edges = [
      edge('S1', 'SUBJ', -1, T(1), { amount: '10' }),
      edge('S2', 'SUBJ', -1, T(2), { amount: '20' }),
      edge('S3', 'SUBJ', -1, T(3), { amount: '30' }),
      edge('SUBJ', 'HOT', 1, T(4), { amount: '55' }),
    ];
    const sankey = buildSankey(edges, new Set(['tron:SUBJ']), new Map([label('HOT', 'Giełda Testowa (SYNTHETIC)')]));
    expect(sankey.nodes.map((n) => [n.id, n.layer, n.kind])).toEqual([
      ['tron:S1#-1', -1, 'unlabelled'],
      ['tron:S2#-1', -1, 'unlabelled'],
      ['tron:S3#-1', -1, 'unlabelled'],
      ['tron:SUBJ#0', 0, 'subject'],
      ['tron:HOT#1', 1, 'service'],
    ]);
    expect(sankey.nodes[4]).toMatchObject({ entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' });
    expect(sankey.links).toHaveLength(4);
    const hot = sankey.links.find((l) => l.target === 'tron:HOT#1');
    expect(hot).toMatchObject({
      pln: '220.00',
      plnComplete: true,
      byAsset: [{ asset: 'USDT', amount: '55' }],
      txCount: 1,
    });
  });

  it('puts every link from layer k to k + 1 even for cyclic input, dropping cycles and self-loops', () => {
    const edges = [
      edge('A', 'B', 1, T(1)),
      edge('B', 'C', 2, T(2)),
      edge('C', 'B', 3, T(3), { isCycle: true }),
      edge('B', 'A', 2, T(2)), // back to the subject: a new node at layer 2, not a cycle in the chart
      edge('A', 'A', 1, T(1)),
      edge('X', 'A', -1, T(0)),
      edge('Y', 'X', -2, T(0)),
    ];
    const sankey = buildSankey(edges, new Set(['tron:A']), new Map());
    const layer = new Map(sankey.nodes.map((n) => [n.id, n.layer]));
    for (const link of sankey.links) expect((layer.get(link.target) ?? NaN) - (layer.get(link.source) ?? NaN)).toBe(1);
    expect(sankey.links.map((l) => `${l.source}>${l.target}`).toSorted()).toEqual(
      [
        'tron:A#0>tron:B#1',
        'tron:B#1>tron:A#2',
        'tron:B#1>tron:C#2',
        'tron:X#-1>tron:A#0',
        'tron:Y#-2>tron:X#-1',
      ].toSorted(),
    );
    expect(edgeLayers(1)).toEqual({ from: 0, to: 1 });
    expect(edgeLayers(-1)).toEqual({ from: -1, to: 0 });
    expect(edgeLayers(-3)).toEqual({ from: -3, to: -2 });
  });

  it('aggregates per link and flags an unpriced leg with plnComplete: false', () => {
    const edges = [
      edge('A', 'B', 1, T(1), { amount: '10' }),
      edge('A', 'B', 1, T(2), { amount: '5', pln: null }),
      edge('A', 'B', 1, T(3), { amount: '1', asset: 'USDC' }),
      edge('A', 'C', 1, T(3), { amount: '7', pln: null }),
    ];
    const sankey = buildSankey(edges, new Set(['tron:A']), new Map());
    const ab = sankey.links.find((l) => l.target === 'tron:B#1');
    expect(ab).toMatchObject({
      pln: '44.00',
      plnComplete: false,
      txCount: 3,
      byAsset: [
        { asset: 'USDC', amount: '1' },
        { asset: 'USDT', amount: '15' },
      ],
    });
    const ac = sankey.links.find((l) => l.target === 'tron:C#1');
    expect(ac?.pln).toBeUndefined();
    expect(ac?.plnComplete).toBe(false);
  });

  it('keeps the top links by PLN and merges the rest into one remainder node per layer', () => {
    const edges = Array.from({ length: 8 }, (_, i) =>
      edge('A', `R${i}`, 1, T(1 + i), { amount: String(10 * (i + 1)) }),
    );
    const sankey = buildSankey(edges, new Set(['tron:A']), new Map(), { maxLinks: 3 });
    expect(sankey.links.map((l) => l.target)).toEqual(['tron:R7#1', 'tron:R6#1', 'tron:R5#1', 'other#1']);
    const rest = sankey.links.find((l) => l.target === 'other#1');
    // R0…R4: 10 + 20 + 30 + 40 + 50 = 150 USDT = 600.00 PLN in five transfers
    expect(rest).toMatchObject({
      source: 'tron:A#0',
      pln: '600.00',
      plnComplete: true,
      txCount: 5,
      byAsset: [{ asset: 'USDT', amount: '150' }],
    });
    const other = sankey.nodes.find((n) => n.id === 'other#1');
    expect(other).toMatchObject({ isOther: true, layer: 1, address: { chain: 'tron', address: '' } });
    expect(sankey.nodes).toHaveLength(5);
  });

  it('merges the dropped senders (not the recipient) on the incoming side and reduces the link count', () => {
    const edges = Array.from({ length: 60 }, (_, i) =>
      edge(`S${i}`, 'SUBJ', -1, T(1), { amount: String(i + 1), tx: `tx-in-${i}` }),
    );
    const sankey = buildSankey(edges, new Set(['tron:SUBJ']), new Map());
    // 50 kept links plus one merged link; every link still ends in the subject.
    expect(sankey.links).toHaveLength(51);
    expect(sankey.links.every((l) => l.target === 'tron:SUBJ#0')).toBe(true);
    const rest = sankey.links.find((l) => l.source === 'other#-1');
    // S0…S9 are the smallest: 1 + … + 10 = 55 USDT = 220.00 PLN in ten transfers
    expect(rest).toMatchObject({
      target: 'tron:SUBJ#0',
      pln: '220.00',
      plnComplete: true,
      txCount: 10,
      byAsset: [{ asset: 'USDT', amount: '55' }],
    });
    expect(sankey.nodes.find((n) => n.id === 'other#-1')).toMatchObject({ isOther: true, layer: -1 });
    expect(sankey.nodes).toHaveLength(52);
  });

  it('merges each side on its own: senders upstream, recipients downstream', () => {
    const edges = [
      edge('S1', 'A', -1, T(1), { amount: '9' }),
      edge('S2', 'A', -1, T(1), { amount: '1' }),
      edge('S3', 'A', -1, T(1), { amount: '2' }),
      edge('A', 'R1', 1, T(2), { amount: '8' }),
      edge('A', 'R2', 1, T(2), { amount: '1' }),
      edge('A', 'R3', 1, T(2), { amount: '2' }),
    ];
    const sankey = buildSankey(edges, new Set(['tron:A']), new Map(), { maxLinks: 2 });
    expect(sankey.links.map((l) => `${l.source}>${l.target}`).toSorted()).toEqual(
      ['tron:S1#-1>tron:A#0', 'tron:A#0>tron:R1#1', 'other#-1>tron:A#0', 'tron:A#0>other#1'].toSorted(),
    );
    const layer = new Map(sankey.nodes.map((n) => [n.id, n.layer]));
    for (const link of sankey.links) expect((layer.get(link.target) ?? NaN) - (layer.get(link.source) ?? NaN)).toBe(1);
  });
});
