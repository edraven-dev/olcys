/** Bounded planning of the next hop: no services, excluded or fetched addresses; recipients first; leaves for hubs. */
import { addressKey } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { planHopExpansion, type HopExpansionDeps } from '../src/index.ts';
import { eth } from './flow-helpers.ts';

const none: HopExpansionDeps = {
  isService: () => false,
  isExcluded: () => false,
  fetched: new Set(),
  txCount: () => undefined,
};
const budget = { perHop: 25, maxTxCount: 1000 };

describe('planHopExpansion', () => {
  it('skips services, excluded and fetched addresses and orders by PLN value', () => {
    const [gw, o, p, z, done] = ['0xgw', '0xo', '0xp', '0xz', '0xdone'].map(eth);
    const plan = planHopExpansion(
      [
        { address: gw!, pln: '9000.00' }, // labelled payment gateway
        { address: p!, pln: '1500.00' },
        { address: z!, pln: '8000.00' }, // deny-listed
        { address: o!, pln: '15000.00' },
        { address: done!, pln: '70000.00' },
      ],
      {
        ...none,
        isService: (a) => a.address === '0xgw',
        isExcluded: (a) => a.address === '0xz',
        fetched: new Set([addressKey(done!)]),
      },
      budget,
    );
    expect(plan.map((i) => i.address.address)).toEqual(['0xo', '0xp']);
  });

  it('plans recipients before senders, unpriced last, and merges repeated counterparties', () => {
    const plan = planHopExpansion(
      [
        { address: eth('0xsender-big'), pln: '99999.00', direction: 'in' },
        { address: eth('0xunpriced'), direction: 'out' },
        { address: eth('0xsmall'), pln: '10.00', direction: 'out' },
        { address: eth('0xsmall'), pln: '5.00', direction: 'out' },
        { address: eth('0xbig'), pln: '12.00', direction: 'out' },
      ],
      none,
      budget,
    );
    // 0xsmall sums to 15.00 and ranks above 0xbig (12.00); the sender comes last
    expect(plan.map((i) => i.address.address)).toEqual(['0xsmall', '0xbig', '0xunpriced', '0xsender-big']);
  });

  it('never plans more than the budget per hop', () => {
    const frontier = Array.from({ length: 60 }, (_, i) => ({ address: eth(`0x${i}`), pln: String(100 - i) }));
    expect(planHopExpansion(frontier, none, budget)).toHaveLength(25);
    expect(planHopExpansion(frontier, none, { perHop: 3, maxTxCount: 1000 }).map((i) => i.address.address)).toEqual([
      '0x0',
      '0x1',
      '0x2',
    ]);
  });

  it('summarises a very active address only (a leaf) and fetches the summary of an unknown one', () => {
    const plan = planHopExpansion(
      [
        { address: eth('0xhub'), pln: '3.00' },
        { address: eth('0xedge'), pln: '2.00' },
        { address: eth('0xquiet'), pln: '1.00' },
        { address: eth('0xnew'), pln: '0.50' },
      ],
      { ...none, txCount: (a) => ({ '0xhub': 5000, '0xedge': 1000, '0xquiet': 999 })[a.address] },
      budget,
    );
    expect(plan[0]).toMatchObject({ address: { address: '0xhub' }, want: { summary: true, transfers: false } });
    expect(plan[1]).toMatchObject({ address: { address: '0xedge' }, want: { transfers: false } });
    expect(plan[2]?.want.transfers).toBeUndefined();
    expect(plan[2]?.want.summary).toBe(false);
    expect(plan[3]?.want.summary).toBe(true);
  });
});
