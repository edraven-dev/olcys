/**
 * Hop expansion and the flow graph of the chain stage on fakes: which counterparties are fetched (and how much of
 * them), that services and excluded addresses are never followed, and the edges, timeline and Sankey per analysed
 * address. No network: the fetch is a recording fake. Synthetic addresses.
 */
import type { ChainFetchResult } from '@olcys/chain-adapters';
import { createAssetRegistry, type Valuator } from '@olcys/analytics';
import type { AddressRef, NormalizedTransfer, RunContext } from '@olcys/core';
import { addressKey } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  computeFlowGraph,
  expandFlowHops,
  flowSettings,
  type EndpointClass,
  type FlowSettings,
  type TransferPool,
} from '../src/flows.ts';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const assets = createAssetRegistry();
const ctx = { runId: 'run', caseId: 'case', mode: 'offline' } as unknown as RunContext;
const at = (n: number): string => new Date(Date.UTC(2026, 5, n)).toISOString();
const ref = (address: string): AddressRef => ({ chain: 'tron', address });
const valuator: Valuator = {
  async value({ amount, at: when }) {
    return {
      status: 'ok',
      valuation: {
        amount,
        asset: 'USDT',
        at: when,
        pln: (Number(amount) * 4).toFixed(2),
        method: 'nbp_table_a_previous_business_day',
        nbp: { table: 'SYN001/A/NBP/2026', effectiveDate: '2026-01-01', currency: 'USD', rate: '4.0000' },
      },
    };
  },
};
let n = 0;
const transfer = (from: string, to: string, day: number, amount: string): NormalizedTransfer => {
  n += 1;
  return {
    chain: 'tron',
    txHash: `tx-${n}`,
    blockHeight: n,
    blockTime: at(day),
    from,
    to,
    asset: { chain: 'tron', symbol: 'USDT', decimals: 6, contract: USDT },
    amount,
    kind: 'token',
    fetchId: 'f',
  };
};
const result = (over: Partial<ChainFetchResult>): ChainFetchResult => ({
  tips: [],
  summaries: [],
  transfers: [],
  utxoTxs: [],
  codes: [],
  outcomes: [],
  resolved: [],
  ...over,
});
const settings = (over: Partial<FlowSettings> = {}): FlowSettings => ({
  expansionHops: 1,
  maxHops: 3,
  edgeLimit: 2000,
  budget: { perHop: 25, maxTxCount: 1000 },
  ...over,
});

describe('flowSettings', () => {
  it('reads the expansion depth from the environment, bounded by the graph depth', () => {
    expect(flowSettings({}, 3)).toMatchObject({ expansionHops: 1, maxHops: 3, edgeLimit: 2000 });
    expect(flowSettings({ OLCYS_FLOW_EXPANSION_HOPS: '2' }, 3).expansionHops).toBe(2);
    expect(flowSettings({ OLCYS_FLOW_EXPANSION_HOPS: '9' }, 3).expansionHops).toBe(3);
    expect(flowSettings({ OLCYS_FLOW_EXPANSION_HOPS: '0' }, 3).expansionHops).toBe(0);
    expect(flowSettings({ OLCYS_FLOW_EXPANSION_HOPS: 'many' }, 3).expansionHops).toBe(1);
    expect(flowSettings({ OLCYS_FLOW_EXPANSION_HOPS: '-1' }, 3).expansionHops).toBe(1);
  });
});

// SUBJ pays a gateway (service), O, P, a deny-listed address and the busy HUB; SRC paid SUBJ.
const persona = (): TransferPool => ({
  transfers: [
    transfer('SUBJ', 'GW', 1, '500'),
    transfer('SUBJ', 'O', 2, '100'),
    transfer('SUBJ', 'P', 3, '10'),
    transfer('SUBJ', 'Z', 4, '900'),
    transfer('SUBJ', 'HUB', 5, '50'),
    transfer('SRC', 'SUBJ', 1, '1000'),
  ],
  utxoTxs: [],
});
const classify = async (a: AddressRef): Promise<EndpointClass> => ({
  service: a.address === 'GW',
  excluded: a.address === 'Z',
});

async function run(over: { expansionHops?: number; perHop?: number } = {}) {
  const calls: { address: string; want: unknown }[][] = [];
  const stored: { address: string; hop: number }[] = [];
  const p = persona();
  // Histories on offer: O paid Q later (hop 2 candidate); P and the others have nothing more.
  const histories: Record<string, NormalizedTransfer[]> = { O: [transfer('O', 'Q', 6, '99')] };
  const fetched = new Set([addressKey(ref('SUBJ'))]);
  const outcome = await expandFlowHops({
    seeds: [ref('SUBJ')],
    settings: settings({
      ...(over.expansionHops === undefined ? {} : { expansionHops: over.expansionHops }),
      budget: { perHop: over.perHop ?? 25, maxTxCount: 1000 },
    }),
    pool: p,
    fetched,
    txCounts: new Map(),
    assets,
    valuator,
    ctx,
    classify,
    async fetch(plan) {
      calls.push(plan.map((i) => ({ address: i.address.address, want: i.want })));
      const wantsHistory = plan.some((i) => i.want?.transfers !== false);
      return result({
        summaries: plan
          .filter((i) => i.want?.summary)
          .map((i) => ({
            address: i.address,
            txCount: i.address.address === 'HUB' ? 5000 : 3,
            fetchId: 'f',
          })),
        outcomes: plan.map((i) => ({
          address: i.address,
          chain: i.address.chain,
          status: 'ok' as const,
          pages: 1,
          items: 0,
        })),
        transfers: wantsHistory ? plan.flatMap((i) => histories[i.address.address] ?? []) : [],
      });
    },
    async onFetched(address, transfers, hop) {
      void transfers;
      stored.push({ address: address.address, hop });
    },
  });
  return { calls, stored, outcome, pool: p, fetched };
}

describe('expandFlowHops', () => {
  it('fetches recipients before senders, skips services and excluded addresses, and keeps hubs as leaves', async () => {
    const { calls, stored, outcome, fetched } = await run();
    // Pass A: summaries of the planned counterparties (recipients by PLN, then the sender); never GW (service) or Z.
    expect(calls[0]?.map((c) => c.address)).toEqual(['O', 'HUB', 'P', 'SRC']);
    expect(
      calls[0]?.every((c) => JSON.stringify(c.want) === '{"summary":true,"transfers":false,"utxo":false,"code":false}'),
    ).toBe(true);
    // Pass B: histories of all but the hub (5 000 transactions: summary only).
    expect(calls[1]?.map((c) => c.address)).toEqual(['O', 'P', 'SRC']);
    expect(stored).toEqual([
      { address: 'O', hop: 1 },
      { address: 'P', hop: 1 },
      { address: 'SRC', hop: 1 },
    ]);
    expect(outcome.leaves.map((a) => a.address)).toEqual(['HUB']);
    expect(fetched.has(addressKey(ref('GW')))).toBe(false);
    expect(fetched.has(addressKey(ref('Z')))).toBe(false);
  });

  it('goes on to the counterparties of the fetched addresses up to the configured hops, never past the budget', async () => {
    const hop1 = await run();
    expect(hop1.calls).toHaveLength(2);
    const hop2 = await run({ expansionHops: 2 });
    // Hop 2 plans O's recipient Q (the only new counterparty of the fetched histories).
    expect(hop2.calls[2]?.map((c) => c.address)).toEqual(['Q']);
    expect(hop2.stored.at(-1)).toEqual({ address: 'Q', hop: 2 });
    const small = await run({ perHop: 2 });
    expect(small.calls[0]?.map((c) => c.address)).toEqual(['O', 'HUB']);
    const off = await run({ expansionHops: 0 });
    expect(off.calls).toEqual([]);
  });

  it('does not fetch the history of an address whose summary failed, and reports the outcome', async () => {
    const calls: string[][] = [];
    const out = await expandFlowHops({
      seeds: [ref('SUBJ')],
      settings: settings(),
      pool: { transfers: [transfer('SUBJ', 'O', 1, '10')], utxoTxs: [] },
      fetched: new Set(),
      txCounts: new Map(),
      assets,
      valuator,
      ctx,
      classify: async () => ({ service: false, excluded: false }),
      async fetch(plan) {
        calls.push(plan.map((i) => `${i.address.address}:${String(i.want?.transfers)}`));
        return result({
          outcomes: plan.map((i) => ({
            address: i.address,
            chain: 'tron' as const,
            status: 'blocked' as const,
            pages: 0,
            items: 0,
          })),
        });
      },
      async onFetched() {
        throw new Error('nothing to store');
      },
    });
    expect(calls).toEqual([['O:false']]);
    expect(out.outcomes.map((o) => o.status)).toEqual(['blocked']);
  });
});

describe('expandFlowHops with counterparties fetched earlier', () => {
  it('continues through an already fetched recipient: A→B→C→D with B fetched, two hops reach C', async () => {
    const pool: TransferPool = {
      transfers: [transfer('A', 'B', 1, '10'), transfer('B', 'C', 2, '10')],
      utxoTxs: [],
    };
    const fetched = new Set([addressKey(ref('A')), addressKey(ref('B'))]);
    const calls: string[][] = [];
    const stored: { address: string; hop: number }[] = [];
    const out = await expandFlowHops({
      seeds: [ref('A')],
      settings: settings({ expansionHops: 2 }),
      pool,
      fetched,
      txCounts: new Map(),
      assets,
      valuator,
      ctx,
      classify: async () => ({ service: false, excluded: false }),
      async fetch(plan) {
        calls.push(plan.map((i) => `${i.address.address}:${String(i.want?.transfers)}`));
        return result({
          summaries: plan.filter((i) => i.want?.summary).map((i) => ({ address: i.address, txCount: 2, fetchId: 'f' })),
          outcomes: plan.map((i) => ({
            address: i.address,
            chain: 'tron' as const,
            status: 'ok' as const,
            pages: 1,
            items: 0,
          })),
          transfers: plan.some((i) => i.want?.transfers !== false) ? [transfer('C', 'D', 3, '10')] : [],
        });
      },
      async onFetched(address, _transfers, hop) {
        stored.push({ address: address.address, hop });
      },
    });
    // B is not fetched again; C (B's recipient) is, at hop 2.
    expect(calls).toEqual([['C:false'], ['C:undefined']]);
    expect(stored).toEqual([{ address: 'C', hop: 2 }]);
    expect(out.fetchedPerHop).toEqual([[], [ref('C')]]);
  });
});

describe('computeFlowGraph', () => {
  it('computes edges, timeline and Sankey per analysed address and stops at labelled services', async () => {
    const pool: TransferPool = {
      transfers: [
        transfer('SRC', 'SUBJ', 1, '100'),
        transfer('SUBJ', 'DEP', 2, '60'),
        transfer('DEP', 'HOT', 3, '60'),
        transfer('HOT', 'ELSEWHERE', 4, '60'), // beyond a labelled service: never followed
        transfer('SUBJ', 'BACK', 5, '5'),
      ],
      utxoTxs: [],
    };
    const graph = await computeFlowGraph({
      runId: 'run',
      seeds: [ref('SUBJ'), ref('IDLE')],
      settings: settings(),
      pool,
      assets,
      valuator,
      ctx,
      classify: async (a) => ({ service: a.address === 'HOT', excluded: false }),
      labelOf: async (a) =>
        a.address === 'HOT'
          ? ({ entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange', address: a } as never)
          : undefined,
      swapsOf: () => [],
      eventsOf: () => [],
      computedAt: '2026-11-21T12:00:00.000Z',
    });
    expect(graph.edges.map((e) => `${e.from.address}>${e.to.address}@${e.hop}`)).toEqual([
      'SUBJ>DEP@1',
      'SUBJ>BACK@1',
      'DEP>HOT@2',
      'SRC>SUBJ@-1',
    ]);
    expect(graph.edges.every((e) => e.valuation !== undefined)).toBe(true);
    expect(graph.truncatedQueries).toBe(0);
    // Only the address with movements has a view.
    expect(graph.views.map((v) => v.address.address)).toEqual(['SUBJ']);
    const view = graph.views[0]!;
    expect(view.timeline.map((e) => [e.hop, e.from?.address, e.to?.address])).toEqual([
      [-1, 'SRC', 'SUBJ'],
      [1, 'SUBJ', 'DEP'],
      [1, 'SUBJ', 'BACK'],
    ]);
    expect(view.sankey.nodes.map((nd) => nd.id)).toEqual([
      'tron:SRC#-1',
      'tron:SUBJ#0',
      'tron:BACK#1',
      'tron:DEP#1',
      'tron:HOT#2',
    ]);
    expect(view.sankey.nodes.find((nd) => nd.id === 'tron:HOT#2')).toMatchObject({
      kind: 'service',
      entity: 'Giełda Testowa (SYNTHETIC)',
    });
    expect(view.truncated).toBe(false);
  });

  it('reports a graph cut at the edge limit', async () => {
    const pool: TransferPool = {
      transfers: Array.from({ length: 5 }, (_, i) => transfer('SUBJ', `N${i}`, 1 + i, '1')),
      utxoTxs: [],
    };
    const graph = await computeFlowGraph({
      runId: 'run',
      seeds: [ref('SUBJ')],
      settings: settings({ edgeLimit: 3 }),
      pool,
      assets,
      valuator,
      ctx,
      classify: async () => ({ service: false, excluded: false }),
      labelOf: async () => undefined,
      swapsOf: () => [],
      eventsOf: () => [],
      computedAt: '2026-11-21T12:00:00.000Z',
    });
    expect(graph.edges).toHaveLength(3);
    expect(graph.truncatedQueries).toBe(1);
    expect(graph.views[0]?.truncated).toBe(true);
  });
});
