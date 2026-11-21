/**
 * Regression test: a Bitcoin co-spender plans the recipient of its payment for the one-hop fetch, although the
 * transfer view names the first input as sender. Synthetic placeholders only.
 */
import type { NormalizedTransfer, UtxoTransaction } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { createAssetRegistry, planCounterpartyExpansion } from '../src/index.ts';

const [A, B, C] = ['bc1qsynthetica', 'bc1qsyntheticb', 'bc1qsyntheticc'];
const payment: NormalizedTransfer = {
  chain: 'bitcoin',
  txHash: 'tx1',
  index: 0,
  blockHeight: 900_000,
  blockTime: '2026-11-01T00:00:00.000Z',
  from: A, // first input
  to: C,
  asset: { chain: 'bitcoin', symbol: 'BTC', decimals: 8 },
  amount: '0.5',
  kind: 'native',
  fetchId: 'f',
};
const tx: UtxoTransaction = {
  chain: 'bitcoin',
  txid: 'tx1',
  inputs: [
    { address: A, value: '0.3', prevTxid: 'p1', vout: 0 },
    { address: B, value: '0.3', prevTxid: 'p2', vout: 0 },
  ],
  outputs: [{ address: C, value: '0.5', n: 0 }],
  fetchId: 'f',
};
const deps = { labels: { labelsFor: async () => [] }, assets: createAssetRegistry() };

describe('counterparty expansion on Bitcoin', () => {
  it('finds the outgoing payment of a co-spender from the transaction inputs', async () => {
    const planned = await planCounterpartyExpansion(
      { address: { chain: 'bitcoin', address: B }, transfers: [payment], utxoTxs: [tx] },
      deps,
    );
    expect(planned).toEqual([{ chain: 'bitcoin', address: C }]);
    // the first input keeps planning it too, and a recipient never plans its sender
    expect(
      await planCounterpartyExpansion(
        { address: { chain: 'bitcoin', address: A }, transfers: [payment], utxoTxs: [tx] },
        deps,
      ),
    ).toEqual([{ chain: 'bitcoin', address: C }]);
    expect(
      await planCounterpartyExpansion(
        { address: { chain: 'bitcoin', address: C }, transfers: [payment], utxoTxs: [tx] },
        deps,
      ),
    ).toEqual([]);
  });
});
