/**
 * Regression tests: B1 uses exactly the transfer A4 matched; Bitcoin legs take their direction from the transaction's
 * inputs; general-purpose batch methods are swaps only with a DEX-labelled counterparty. Synthetic placeholders only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AddressLabel,
  ExclusionDecision,
  FxRateSource,
  LabelLookup,
  NormalizedTransfer,
  RunContext,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  analyseAddress,
  createAssetRegistry,
  createSeriesPriceSource,
  createValuator,
  legsOf,
  loadCashOutRules,
  loadCashOutScoreConfig,
  loadPriceDataset,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const hex = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const ME = hex(0xa1);
const EXCHANGE = hex(0xe1);
const DEX = hex(0xd1);
const LENDER = hex(0xf1);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const usdc = { chain: 'evm:1' as const, symbol: 'USDC', decimals: 6, contract: USDC };
const eth = { chain: 'evm:1' as const, symbol: 'ETH', decimals: 18 };

const label = (address: string, entity: string, category: AddressLabel['category']): AddressLabel => ({
  id: `label-${entity}`,
  address: { chain: 'evm:1', address },
  entity,
  category,
  attributes: { fiatCapable: true },
  confidence: 100,
  provenance: {
    datasetId: 't',
    url: '',
    license: 'CC0-1.0',
    lastmod: '',
    retrievedAt: '',
    sourceType: 'por_file',
    deciding: true,
  },
});
const lookupOf = (labels: AddressLabel[]): LabelLookup => ({
  labelsFor: async (ref) =>
    labels.filter((l) => l.address.address === ref.address.toLowerCase() && l.address.chain === ref.chain),
});
const fx: FxRateSource = {
  plnRate: async (currency) => ({ table: '000/A/NBP/2026', effectiveDate: '2026-01-01', currency, rate: '3.6500' }),
};
const ctx: RunContext = {
  runId: newId(),
  caseId: newId(),
  mode: 'offline',
  http: { fetch: () => Promise.reject(new Error('no network in this test')) },
  blobs: {} as RunContext['blobs'],
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const assets = createAssetRegistry();
const depsWith = (labels: AddressLabel[]) => ({
  labels: lookupOf(labels),
  valuator: createValuator({
    fx,
    prices: createSeriesPriceSource(loadPriceDataset(read('fixtures/prices/demo-prices.v1.json'))),
    assets,
  }),
  assets,
  forwarding: { tauBlocks: 3200, alpha: '0.01' },
  rules: loadCashOutRules(read('config/rules/cashout.v1.yaml')),
  score: loadCashOutScoreConfig(read('config/rules/cashout-score.v1.yaml')),
  runId: ctx.runId,
});
const move = (
  over: Partial<NormalizedTransfer> & Pick<NormalizedTransfer, 'txHash' | 'from' | 'to' | 'amount'>,
): NormalizedTransfer => ({
  chain: 'evm:1',
  blockHeight: 100,
  blockTime: '2026-11-03T10:00:00.000Z',
  asset: eth,
  kind: 'native',
  fetchId: 'f',
  ...over,
});

describe('B1 from an A4 decision', () => {
  it('uses exactly the matched transfer of a multi-asset deposit', async () => {
    const transfers = [
      move({ txHash: '0xdep', from: hex(0xc1), to: ME, amount: '0.5' }),
      move({ txHash: '0xdep', index: 5, from: hex(0xc1), to: ME, amount: '1000', asset: usdc, kind: 'token' }),
      move({
        txHash: '0xsweep',
        index: 2,
        blockHeight: 110,
        from: ME,
        to: EXCHANGE,
        amount: '1000',
        asset: usdc,
        kind: 'token',
      }),
    ];
    const a4: ExclusionDecision = {
      id: newId(),
      runId: ctx.runId,
      address: { chain: 'evm:1', address: ME },
      ruleId: 'A4',
      outcome: 'reclassified',
      relation: 'CUSTODIAL_EXCHANGE',
      emitsCashOut: 'B1',
      reason: 'A4: test',
      evidence: {
        forwardsTo: { address: EXCHANGE, entity: 'Giełda (SYNTHETIC)', category: 'exchange', labelId: 'l' },
        pairs: [
          {
            receiveTx: '0xdep',
            forwardTx: '0xsweep',
            amountIn: '1000',
            amountOut: '1000',
            delta: 10,
            kappa: 0.998438,
            assetKey: USDC,
            receiveKind: 'token',
            receiveIndex: 5,
            forwardKind: 'token',
            forwardIndex: 2,
          },
        ],
      },
      rulesVersion: 'exclusion.v1',
    };
    const { events } = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers, decisions: [a4] },
      depsWith([label(EXCHANGE, 'Giełda (SYNTHETIC)', 'exchange')]),
      ctx,
    );
    expect(events.map((e) => [e.ruleId, e.amount, e.asset, e.valuation?.pln])).toEqual([
      ['B1', '1000', 'USDC', '3650.00'],
    ]);
  });
});

describe('Bitcoin legs', () => {
  it('take their direction from the inputs, not from the sender named in the transfer view', () => {
    const [a, b, c] = ['bc1qsynthetica', 'bc1qsyntheticb', 'bc1qsyntheticc'];
    const btc = { chain: 'bitcoin' as const, symbol: 'BTC', decimals: 8 };
    // one representation per output: the sender is the first input (b), although a also spent an input
    const payment = {
      ...move({ txHash: 'tx1', index: 0, from: b, to: c, amount: '0.5', asset: btc }),
      chain: 'bitcoin' as const,
    };
    const utxoTxs = [
      {
        chain: 'bitcoin' as const,
        txid: 'tx1',
        inputs: [
          { address: b, value: '0.3', prevTxid: 'p1', vout: 0 },
          { address: a, value: '0.3', prevTxid: 'p2', vout: 0 },
        ],
        outputs: [{ address: c, value: '0.5', n: 0 }],
        fetchId: 'f',
      },
    ];
    const legs = legsOf(
      { address: { chain: 'bitcoin', address: a }, transfers: [payment], utxoTxs, decisions: [] },
      { assets },
    );
    expect(legs.map((l) => [l.direction, l.counterparty])).toEqual([['out', c]]);
    const received = legsOf(
      { address: { chain: 'bitcoin', address: c }, transfers: [payment], utxoTxs, decisions: [] },
      { assets },
    );
    expect(received.map((l) => [l.direction, l.counterparty])).toEqual([['in', b]]);
  });
});

const batch = (method: string, counterparty: string) => [
  move({ txHash: '0xbatch', from: ME, to: counterparty, amount: '1', method }),
  move({ txHash: '0xbatch', index: 1, from: counterparty, to: ME, amount: '1000', asset: usdc, kind: 'token' }),
];

describe('general-purpose batch methods', () => {
  it('are not swaps without a DEX-labelled counterparty (e.g. collateral deposit plus borrow)', async () => {
    for (const method of ['multicall', 'execute']) {
      // oxlint-disable-next-line no-await-in-loop
      const { indicators, events } = await analyseAddress(
        { address: { chain: 'evm:1', address: ME }, transfers: batch(method, LENDER), decisions: [] },
        depsWith([]),
        ctx,
      );
      expect(indicators.swaps).toEqual([]);
      expect(events.filter((e) => e.ruleId === 'B4')).toEqual([]);
    }
  });

  it('are swaps through a DEX-labelled router, and swap-specific names still suffice', async () => {
    const viaDex = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers: batch('execute', DEX), decisions: [] },
      depsWith([label(DEX, 'DEX (SYNTHETIC)', 'defi_dex')]),
      ctx,
    );
    expect(viaDex.indicators.swaps.map((s) => [s.detection, s.bought.amount])).toEqual([['dex_label', '1000']]);
    const named = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers: batch('swapExactETHForTokens', LENDER), decisions: [] },
      depsWith([]),
      ctx,
    );
    expect(named.indicators.swaps.map((s) => s.detection)).toEqual(['method']);
  });
});
