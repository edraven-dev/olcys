/** Chronological fund-flow timeline: transfers, swaps and cash-out indicators in a deterministic order. */
import type { CashOutEvent, SwapEvent } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/index.ts';
import { edge, tron } from './flow-helpers.ts';

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-02T10:00:00.000Z';

const event = (over: Partial<CashOutEvent>): CashOutEvent =>
  ({
    id: 'e1',
    runId: 'run',
    address: tron('TSubject'),
    ruleId: 'B1',
    strength: 'strong',
    occurredAt: T1,
    txHashes: ['tx-in', 'tx-sweep'],
    asset: 'USDT',
    amount: '100',
    counterparty: { address: 'TDeposit', entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' },
    hops: 1,
    rulesVersion: 'cashout.v1',
    ...over,
  }) as CashOutEvent;

describe('buildTimeline', () => {
  it('orders equal times by kind (transfer, swap, cash-out) and then by transaction', () => {
    const swap: SwapEvent = {
      at: T1,
      txHash: 'tx-swap',
      sold: { asset: 'ETH', amount: '1' },
      bought: { asset: 'USDT', amount: '3000' },
      venue: 'DEX Testowy (SYNTHETIC)',
    } as SwapEvent;
    const timeline = buildTimeline(
      [edge('TSubject', 'TDeposit', 1, T1, { tx: 'tx-b' }), edge('TSource', 'TSubject', -1, T1, { tx: 'tx-a' })],
      [swap],
      [event({})],
    );
    expect(timeline.map((e) => [e.kind, e.txHashes[0]])).toEqual([
      ['transfer', 'tx-a'],
      ['transfer', 'tx-b'],
      ['swap', 'tx-swap'],
      ['cash_out', 'tx-in'],
    ]);
    expect(timeline[3]).toMatchObject({
      ruleId: 'B1',
      strength: 'strong',
      counterparty: { entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' },
    });
    expect(timeline[2]?.counterparty).toEqual({ entity: 'DEX Testowy (SYNTHETIC)', category: 'defi_dex' });
  });

  it('sorts chronologically whatever the input order and is the same for any permutation', () => {
    const edges = [
      edge('TSubject', 'TB', 1, T2, { tx: 'tx-2' }),
      edge('TSubject', 'TA', 1, T1, { tx: 'tx-1' }),
      edge('TSubject', 'TA', 1, T1, { tx: 'tx-1', amount: '5' }),
    ];
    const forward = buildTimeline(edges, [], []);
    expect(forward.map((e) => e.at)).toEqual([T1, T1, T2]);
    expect(buildTimeline(edges.toReversed(), [], [])).toEqual(forward);
  });

  it('shows the first hop by default, deeper hops on request, and the labelled counterparty', () => {
    const edges = [
      edge('TSubject', 'TDeposit', 1, T1, { tx: 'tx-1' }),
      edge('TDeposit', 'THot', 2, T2, { tx: 'tx-2' }),
      edge('TSource', 'TSubject', -1, T1, { tx: 'tx-0' }),
      edge('TOrigin', 'TSource', -2, T1, { tx: 'tx--1' }),
    ];
    expect(buildTimeline(edges, [], []).map((e) => e.hop)).toEqual([-1, 1]);
    const labelled = buildTimeline(edges, [], [], {
      maxHop: 2,
      counterparty: (a) =>
        a.address === 'THot' ? { entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' } : undefined,
    });
    expect(labelled.map((e) => e.hop)).toEqual([-2, -1, 1, 2]);
    expect(labelled[3]?.counterparty).toEqual({
      address: 'THot',
      entity: 'Giełda Testowa (SYNTHETIC)',
      category: 'exchange',
    });
    // upstream: the other side is the sender
    expect(labelled[1]?.counterparty).toBeUndefined();
  });

  it('keeps an unpriced leg without a valuation (a fact without a computation)', () => {
    const [entry] = buildTimeline([edge('TSubject', 'TB', 1, T1, { pln: null })], [], []);
    expect(entry).toMatchObject({ kind: 'transfer', amount: '100', asset: 'USDT' });
    expect(entry?.valuation).toBeUndefined();
  });
});
