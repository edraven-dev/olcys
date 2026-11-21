import { describe, expect, it } from 'vitest';
import { findForwardingPairs, forwardingParamsFor, type ForwardingLeg } from '../src/index.ts';

const leg = (
  txHash: string,
  amount: string,
  blockHeight: number,
  blockTime = '2026-10-14T09:12:00Z',
): ForwardingLeg => ({
  txHash,
  amount,
  blockHeight,
  blockTime,
  assetKey: 'ETH',
});
const blocks = { alpha: '0.01', tau: 3200, clock: 'blocks' } as const;

describe('findForwardingPairs', () => {
  it('scores a deposit swept 40 blocks later minus gas with kappa 0.98875', () => {
    const pairs = findForwardingPairs([leg('r1', '0.01', 26_150_100)], [leg('f1', '0.0099', 26_150_140)], blocks);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ amountDiff: '0.0001', delta: 40, kappa: 0.98875 });
  });

  it('applies the bounds of tau and alpha', () => {
    expect(findForwardingPairs([leg('r', '1', 100)], [leg('f', '1', 3301)], blocks)).toEqual([]);
    expect(findForwardingPairs([leg('r', '1', 100)], [leg('f', '0.989', 101)], blocks)).toEqual([]);
    // |Δa| = α and Δt = τ give κ = 0: no pair
    expect(findForwardingPairs([leg('r', '1', 100)], [leg('f', '0.99', 3300)], blocks)).toEqual([]);
    // a forward before the receive is never a pair
    expect(findForwardingPairs([leg('r', '1', 200)], [leg('f', '1', 100)], blocks)).toEqual([]);
  });

  it('uses seconds outside Ethereum mainnet (tau = 3200 × 12 s)', () => {
    const params = forwardingParamsFor('tron', { tauBlocks: 3200, alpha: '0.01' });
    expect(params).toEqual({ alpha: '0.01', tau: 38_400, clock: 'seconds' });
    const pairs = findForwardingPairs(
      [{ ...leg('r', '3000', 0, '2026-08-22T00:00:00Z'), assetKey: 'USDT' }],
      [{ ...leg('f', '3000', 0, '2026-08-22T10:00:00Z'), assetKey: 'USDT' }],
      params,
    );
    expect(pairs[0]?.kappa).toBe(0.53125);
    expect(forwardingParamsFor('evm:1', { tauBlocks: 3200, alpha: '0.01' }).clock).toBe('blocks');
  });

  it('pairs each receive at most once, preferring the best kappa and then the earlier receive', () => {
    const receives = [leg('r1', '1', 100), leg('r2', '1', 150), leg('r3', '1.005', 190)];
    const pairs = findForwardingPairs(receives, [leg('f1', '1', 200), leg('f2', '1', 210)], blocks);
    expect(pairs.map((p) => [p.receive.txHash, p.forward.txHash])).toEqual([
      ['r2', 'f1'],
      ['r1', 'f2'],
    ]);
    // a different asset never pairs
    expect(findForwardingPairs([{ ...leg('r', '1', 1), assetKey: 'USDT' }], [leg('f', '1', 2)], blocks)).toEqual([]);
  });
});
