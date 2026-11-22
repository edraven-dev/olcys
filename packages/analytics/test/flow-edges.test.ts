/** Flow edges valued in PLN: unpriced legs stay without a valuation (never zero), order and fields are kept. */
import type { FlowRow } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildFlowEdges } from '../src/index.ts';
import { assets, ctx, TRON_USDT, valuator } from './flow-helpers.ts';

const row = (over: Partial<FlowRow>): FlowRow => ({
  chain: 'tron',
  txHash: 'tx-1',
  blockHeight: 1,
  blockTime: '2026-03-01T10:00:00.000Z',
  from: 'TSynthSender',
  to: 'TSynthRecipient',
  asset: { chain: 'tron', symbol: 'USDT', decimals: 6, contract: TRON_USDT },
  amount: '100',
  kind: 'token',
  fetchId: 'f',
  hop: 1,
  isCycle: false,
  ...over,
});

describe('buildFlowEdges', () => {
  it('values every leg at its own NBP rate and keeps the path fields', async () => {
    const edges = await buildFlowEdges(
      [row({ index: 4 }), row({ hop: -2, txHash: 'tx-2', isCycle: true })],
      { valuator, assets },
      ctx,
    );
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      from: { chain: 'tron', address: 'TSynthSender' },
      to: { chain: 'tron', address: 'TSynthRecipient' },
      asset: 'USDT',
      amount: '100',
      index: 4,
      hop: 1,
      valuation: { pln: '400.00', nbp: { table: 'SYN001/A/NBP/2026', rate: '4.0000' } },
    });
    expect(edges[0]?.isCycle).toBeUndefined();
    expect(edges[1]).toMatchObject({ hop: -2, isCycle: true, txHash: 'tx-2' });
  });

  it('flags a leg it cannot value by leaving the valuation out (unknown token, no price)', async () => {
    const edges = await buildFlowEdges(
      [
        row({ asset: { chain: 'tron', symbol: 'WEIRD', decimals: 6, contract: 'TUnknownTokenSynthetic' } }),
        row({
          txHash: 'tx-eth',
          chain: 'evm:1',
          asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
          amount: '0.5',
        }),
        row({ txHash: 'tx-btc', chain: 'bitcoin', asset: { chain: 'bitcoin', symbol: 'BTC', decimals: 8 } }),
      ],
      { valuator, assets },
      ctx,
    );
    expect(edges[0]?.valuation).toBeUndefined();
    expect(edges[0]?.asset).toBe('WEIRD:TUnknownTokenSynthetic');
    expect(edges[1]?.valuation?.pln).toBe('2000.00');
    // the synthetic price source knows ETH only: BTC stays unpriced
    expect(edges[2]?.valuation).toBeUndefined();
  });
});
