/**
 * Regression tests for review findings: chain-scoped decisions and transfers, per-asset B5 windows, split swap legs,
 * the exchange of each sweep, and NBP month caching across runs. All addresses are synthetic placeholders.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AddressLabel,
  ChainId,
  EgressClient,
  EgressRequest,
  EgressResponse,
  ExclusionDecision,
  FxRateSource,
  LabelLookup,
  NormalizedTransfer,
  RunContext,
} from '@olcys/core';
import { addressKey, newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  analyseAddress,
  createAssetRegistry,
  createNbpFxRateSource,
  createSeriesPriceSource,
  createValuator,
  loadCashOutRules,
  loadCashOutScoreConfig,
  loadPriceDataset,
  type CashOutDeps,
  type CashOutScoreConfig,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const hex = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const ME = hex(0xa1);
const EXCHANGE_A = hex(0xe1);
const EXCHANGE_B = hex(0xe2);
const DEX = hex(0xd1);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

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
const LABELS = [
  label(EXCHANGE_A, 'Giełda A (SYNTHETIC)', 'exchange'),
  label(EXCHANGE_B, 'Giełda B (SYNTHETIC)', 'exchange'),
  label(DEX, 'DEX (SYNTHETIC)', 'defi_dex'),
];
const lookup: LabelLookup = {
  labelsFor: async (ref) =>
    LABELS.filter((l) => l.address.address === ref.address.toLowerCase() && l.address.chain === ref.chain),
};
const fx: FxRateSource = {
  plnRate: async (currency) => ({ table: '000/A/NBP/2026', effectiveDate: '2026-01-01', currency, rate: '3.6500' }),
};
const ctx = (runId = newId(), now = '2026-11-21T12:00:00Z', http?: EgressClient): RunContext => ({
  runId,
  caseId: newId(),
  mode: 'offline',
  http: http ?? { fetch: () => Promise.reject(new Error('no network in this test')) },
  blobs: {} as RunContext['blobs'],
  clock: { now: () => new Date(now) },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
const assets = createAssetRegistry();
const deps: CashOutDeps & { score: CashOutScoreConfig } = {
  labels: lookup,
  valuator: createValuator({
    fx,
    prices: createSeriesPriceSource(loadPriceDataset(read('fixtures/prices/demo-prices.v1.json'))),
    assets,
  }),
  assets,
  forwarding: { tauBlocks: 3200, alpha: '0.01' },
  rules: loadCashOutRules(read('config/rules/cashout.v1.yaml')),
  score: loadCashOutScoreConfig(read('config/rules/cashout-score.v1.yaml')),
  runId: newId(),
};

let n = 0;
function transfer(
  over: Partial<NormalizedTransfer> & { from: string; to: string; amount: string },
): NormalizedTransfer {
  n += 1;
  return {
    chain: 'evm:1',
    txHash: `0x${String(n).padStart(64, '0')}`,
    blockHeight: 1000 + n,
    blockTime: '2026-10-01T00:00:00.000Z',
    asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
    kind: 'native',
    fetchId: 'f',
    ...over,
  };
}
const token = (contract: string, symbol: string) => ({ chain: 'evm:1' as ChainId, symbol, decimals: 6, contract });
const day = (d: number, h = 0): string => new Date(Date.UTC(2026, 9, d, h)).toISOString();

function a4Decision(
  address: { chain: ChainId; address: string },
  pairs: { receiveTx: string; forwardTx: string; to: string; entity: string }[],
): ExclusionDecision {
  return {
    id: newId(),
    runId: deps.runId,
    address,
    ruleId: 'A4',
    outcome: 'reclassified',
    relation: 'CUSTODIAL_EXCHANGE',
    emitsCashOut: 'B1',
    reason: 'A4: test',
    evidence: {
      kappa: 0.9,
      forwardsTo: { address: pairs[0]?.to ?? '', entity: pairs[0]?.entity ?? '', category: 'exchange', labelId: 'l' },
      pairs: pairs.map((p) => ({
        receiveTx: p.receiveTx,
        forwardTx: p.forwardTx,
        amountIn: '1',
        amountOut: '0.999',
        delta: 10,
        kappa: 0.9,
        forwardsTo: { address: p.to, entity: p.entity, category: 'exchange', labelId: `label-${p.entity}` },
      })),
    },
    rulesVersion: 'exclusion.v1',
  };
}

describe('decisions and transfers stay on their chain', () => {
  const DEPOSIT = hex(0xb1);
  const decisionOnEthereum = a4Decision({ chain: 'evm:1', address: DEPOSIT }, []);

  it('an Ethereum deposit address is not an exchange recipient on Polygon', async () => {
    const pay = transfer({
      chain: 'evm:137',
      from: ME,
      to: DEPOSIT,
      amount: '1',
      asset: { chain: 'evm:137', symbol: 'POL', decimals: 18 },
    });
    const polygon = await analyseAddress(
      { address: { chain: 'evm:137', address: ME }, transfers: [pay], decisions: [decisionOnEthereum] },
      deps,
      ctx(),
    );
    expect(polygon.events).toEqual([]);
    expect(polygon.indicators.serviceInteractions).toEqual([]);
    const ethereum = await analyseAddress(
      {
        address: { chain: 'evm:1', address: ME },
        transfers: [transfer({ from: ME, to: DEPOSIT, amount: '1' })],
        decisions: [decisionOnEthereum],
      },
      deps,
      ctx(),
    );
    expect(ethereum.events.map((e) => e.ruleId)).toEqual(['B1']);
  });

  it('ignores transfers of another chain and applies evm:unknown decisions only through the explicit resolution', async () => {
    const receive = transfer({ from: hex(0xc1), to: ME, amount: '1' });
    const sweep = transfer({ from: ME, to: EXCHANGE_A, amount: '0.999' });
    const own = a4Decision({ chain: 'evm:unknown', address: ME }, [
      { receiveTx: receive.txHash, forwardTx: sweep.txHash, to: EXCHANGE_A, entity: 'Giełda A (SYNTHETIC)' },
    ]);
    const input = { address: { chain: 'evm:1' as const, address: ME }, transfers: [receive, sweep], decisions: [own] };
    // without the resolution the evm:unknown decision does not apply: the sweep is an ordinary exchange payment
    const unresolved = await analyseAddress(input, deps, ctx());
    expect(unresolved.events.map((e) => [e.ruleId, e.amount, e.exclusionDecisionId])).toEqual([
      ['B1', '0.999', undefined],
    ]);
    const resolved = await analyseAddress({ ...input, requested: { chain: 'evm:unknown', address: ME } }, deps, ctx());
    expect(resolved.events.map((e) => [e.ruleId, e.amount, e.exclusionDecisionId])).toEqual([['B1', '1', own.id]]);
    const elsewhere = await analyseAddress({ ...input, address: { chain: 'evm:137', address: ME } }, deps, ctx());
    expect(elsewhere.indicators.txCount).toBe(0);
  });
});

describe('cash-out rules', () => {
  it('B5 finds a pattern in each stablecoin even when payments interleave', async () => {
    const legs: NormalizedTransfer[] = [];
    for (let i = 0; i < 5; i += 1) {
      legs.push(
        transfer({
          from: ME,
          to: hex(0x100 + i),
          amount: '500',
          kind: 'token',
          asset: token(USDT, 'USDT'),
          blockTime: day(1 + 2 * i),
        }),
      );
      legs.push(
        transfer({
          from: ME,
          to: hex(0x200 + i),
          amount: '700',
          kind: 'token',
          asset: token(USDC, 'USDC'),
          blockTime: day(2 + 2 * i),
        }),
      );
    }
    const { events } = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers: legs, decisions: [] },
      deps,
      ctx(),
    );
    expect(events.filter((e) => e.ruleId === 'B5').map((e) => [e.asset, e.amount])).toEqual([
      ['USDT', '2500'],
      ['USDC', '3500'],
    ]);
  });

  it('sums split swap legs per asset, so a small exit does not reach half of the proceeds', async () => {
    const swapTx = `0x${'5'.repeat(64)}`;
    const at = day(5);
    const sold = transfer({
      txHash: swapTx,
      from: ME,
      to: DEX,
      amount: '1',
      method: 'swapExactETHForTokens',
      blockTime: at,
    });
    const legA = transfer({
      txHash: swapTx,
      index: 1,
      from: DEX,
      to: ME,
      amount: '500',
      kind: 'token',
      asset: token(USDC, 'USDC'),
      blockTime: at,
    });
    const legB = transfer({
      txHash: swapTx,
      index: 2,
      from: DEX,
      to: ME,
      amount: '500',
      kind: 'token',
      asset: token(USDC, 'USDC'),
      blockTime: at,
    });
    const exit = transfer({
      from: ME,
      to: EXCHANGE_A,
      amount: '400',
      kind: 'token',
      asset: token(USDC, 'USDC'),
      blockTime: day(6),
    });
    const { indicators, events } = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers: [sold, legA, legB, exit], decisions: [] },
      deps,
      ctx(),
    );
    expect(indicators.swaps).toHaveLength(1);
    expect(indicators.swaps[0]).toMatchObject({
      sold: { asset: 'ETH', amount: '1' },
      bought: { asset: 'USDC', amount: '1000' },
    });
    expect(indicators.stablecoinConversionPln).toBe('3650.00');
    expect(events.find((e) => e.ruleId === 'B4')?.strength).toBe('weak');
  });

  it('names the exchange each sweep of a deposit address reached', async () => {
    const DEPOSIT = hex(0xb2);
    const toDeposit1 = transfer({ from: ME, to: DEPOSIT, amount: '1', blockTime: day(1) });
    const toDeposit2 = transfer({ from: ME, to: DEPOSIT, amount: '2', blockTime: day(3) });
    const sweep1 = transfer({
      from: DEPOSIT,
      to: EXCHANGE_A,
      amount: '0.999',
      blockHeight: toDeposit1.blockHeight + 10,
      blockTime: day(1, 1),
    });
    const sweep2 = transfer({
      from: DEPOSIT,
      to: EXCHANGE_B,
      amount: '1.999',
      blockHeight: toDeposit2.blockHeight + 10,
      blockTime: day(3, 1),
    });
    const forwarding = await analyseAddress(
      {
        address: { chain: 'evm:1', address: ME },
        transfers: [toDeposit1, toDeposit2],
        decisions: [],
        counterpartyTransfers: new Map([
          [addressKey({ chain: 'evm:1', address: DEPOSIT }), [toDeposit1, toDeposit2, sweep1, sweep2]],
        ]),
      },
      deps,
      ctx(),
    );
    expect(forwarding.events.map((e) => [e.amount, e.counterparty.entity])).toEqual([
      ['1', 'Giełda A (SYNTHETIC)'],
      ['2', 'Giełda B (SYNTHETIC)'],
    ]);
    // the same through an A4 decision whose pairs reach different exchanges
    const r1 = transfer({ from: hex(0xc2), to: ME, amount: '1' });
    const f1 = transfer({ from: ME, to: EXCHANGE_A, amount: '0.999' });
    const r2 = transfer({ from: hex(0xc3), to: ME, amount: '1' });
    const f2 = transfer({ from: ME, to: EXCHANGE_B, amount: '0.999' });
    const decision = a4Decision({ chain: 'evm:1', address: ME }, [
      { receiveTx: r1.txHash, forwardTx: f1.txHash, to: EXCHANGE_A, entity: 'Giełda A (SYNTHETIC)' },
      { receiveTx: r2.txHash, forwardTx: f2.txHash, to: EXCHANGE_B, entity: 'Giełda B (SYNTHETIC)' },
    ]);
    const own = await analyseAddress(
      { address: { chain: 'evm:1', address: ME }, transfers: [r1, f1, r2, f2], decisions: [decision] },
      deps,
      ctx(),
    );
    expect(own.events.map((e) => e.counterparty.entity)).toEqual(['Giełda A (SYNTHETIC)', 'Giełda B (SYNTHETIC)']);
  });
});

describe('NBP rates across runs', () => {
  const TABLES = [
    { no: '211/A/NBP/2026', effectiveDate: '2026-10-30', mid: '3.6600' },
    { no: '224/A/NBP/2026', effectiveDate: '2026-11-20', mid: '3.6100' },
    { no: '226/A/NBP/2026', effectiveDate: '2026-11-24', mid: '3.6200' },
  ];
  function stub(): EgressClient & { urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      async fetch(request: EgressRequest): Promise<EgressResponse> {
        urls.push(request.url);
        const [, from = '', to = ''] = /\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\//.exec(request.url) ?? [];
        const rates = TABLES.filter((t) => t.effectiveDate >= from && t.effectiveDate <= to);
        const text = `{"code":"USD","rates":[${rates.map((r) => `{"no":"${r.no}","effectiveDate":"${r.effectiveDate}","mid":${r.mid}}`).join(',')}]}`;
        return {
          status: 200,
          finalUrl: request.url,
          headers: {},
          body: new Uint8Array(),
          text: () => text,
          json: <T>() => JSON.parse(text) as T,
          provenance: { fetchId: newId() } as EgressResponse['provenance'],
        };
      },
    };
  }

  it('re-reads the unfinished month in a later run and reuses finished months', async () => {
    const http = stub();
    const source = createNbpFxRateSource({ http });
    const first = await source.plnRate('USD', '2026-11-21T10:00:00Z', ctx(newId(), '2026-11-21T12:00:00Z'));
    expect(first.effectiveDate).toBe('2026-11-20');
    const later = await source.plnRate('USD', '2026-11-25T10:00:00Z', ctx(newId(), '2026-11-25T12:00:00Z'));
    expect(later).toMatchObject({ effectiveDate: '2026-11-24', table: '226/A/NBP/2026', rate: '3.6200' });
    // within one run the current month is read once; October (finished) once for both runs
    const run = ctx(newId(), '2026-11-25T12:00:00Z');
    await source.plnRate('USD', '2026-11-03T10:00:00Z', run);
    await source.plnRate('USD', '2026-11-02T10:00:00Z', run);
    expect(http.urls.filter((u) => u.includes('/2026-10-01/'))).toHaveLength(1);
    expect(http.urls.filter((u) => u.includes('/2026-11-01/'))).toHaveLength(3);
  });
});
