/** Shared builders of the fund-flow tests: synthetic addresses, a valuator on a flat synthetic rate, edges. */
import { dMul, dRound } from '@olcys/core';
import type { AddressRef, FlowEdge, FxRateSource, PriceSource, RunContext, Valuation } from '@olcys/core';
import { createAssetRegistry, createValuator, ValuationUnavailableError } from '../src/index.ts';

export const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const assets = createAssetRegistry();
export const ctx = {
  runId: 'run',
  caseId: 'case',
  mode: 'offline',
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
} as unknown as RunContext;

const fx: FxRateSource = {
  plnRate: async (currency) => ({ table: 'SYN001/A/NBP/2026', effectiveDate: '2026-01-01', currency, rate: '4.0000' }),
};
const prices: PriceSource = {
  price: async (asset, quote, at) => {
    if (asset !== 'ETH') throw new ValuationUnavailableError('no_candle', `no price for ${asset}`);
    return { source: 'synthetic', pair: `${asset}/${quote}`, candleTime: at, close: '1000' };
  },
};
export const valuator = createValuator({ fx, prices, assets });

export const tron = (address: string): AddressRef => ({ chain: 'tron', address });
export const eth = (address: string): AddressRef => ({ chain: 'evm:1', address });

export function edge(
  from: string,
  to: string,
  hop: number,
  at: string,
  options: {
    amount?: string;
    asset?: string;
    pln?: string | null;
    tx?: string;
    chain?: 'tron' | 'evm:1';
    isCycle?: boolean;
  } = {},
): FlowEdge {
  const amount = options.amount ?? '100';
  const asset = options.asset ?? 'USDT';
  const ref = options.chain === 'evm:1' ? eth : tron;
  const pln = options.pln === undefined ? dRound(dMul(amount, '4'), 2) : options.pln;
  const valuation: Valuation | undefined =
    pln === null
      ? undefined
      : {
          amount,
          asset,
          at,
          pln,
          method: 'nbp_table_a_previous_business_day',
          nbp: { table: 'SYN001/A/NBP/2026', effectiveDate: '2026-01-01', currency: 'USD', rate: '4.0000' },
        };
  return {
    from: ref(from),
    to: ref(to),
    asset,
    amount,
    txHash: options.tx ?? `tx-${from}-${to}-${at}`,
    at,
    hop,
    ...(valuation ? { valuation } : {}),
    ...(options.isCycle ? { isCycle: true } : {}),
  };
}
