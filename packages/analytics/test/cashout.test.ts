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
import { addressKey, newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  analyseAddress,
  cashOutScore,
  createAssetRegistry,
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
const slots = (JSON.parse(read('fixtures/persona/manifest.json')) as { addresses: Record<string, { address: string }> })
  .addresses;
const slot = (name: string): string => slots[name]?.address ?? '';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/** Demo labels as ranked lookup (EVM lower-case), without depending on the labels package. */
function demoLookup(): LabelLookup {
  const doc = JSON.parse(read('fixtures/labels/demo-curated.json')) as {
    labels: Omit<AddressLabel, 'id' | 'provenance'>[];
  };
  const labels: AddressLabel[] = doc.labels.map((l) => ({
    id: newId(),
    entity: l.entity,
    category: l.category,
    attributes: l.attributes,
    confidence: l.confidence,
    address: {
      chain: l.address.chain,
      address: l.address.chain.startsWith('evm:') ? l.address.address.toLowerCase() : l.address.address,
    },
    provenance: {
      datasetId: 'demo-curated',
      url: '',
      license: 'CC0-1.0',
      lastmod: '',
      retrievedAt: '',
      sourceType: 'por_file',
      deciding: true,
    },
  }));
  return {
    labelsFor: async (ref) => {
      const a = ref.chain.startsWith('evm:') ? ref.address.toLowerCase() : ref.address;
      return labels.filter((l) => l.address.address === a);
    },
  };
}

/** Synthetic flat USD/PLN rate (made up, not NBP data). */
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
const deps: CashOutDeps & { score: CashOutScoreConfig } = {
  labels: demoLookup(),
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
};

let n = 0;
const usdt = (from: string, to: string, amount: string, at: string): NormalizedTransfer => ({
  chain: 'tron',
  txHash: `tx${String((n += 1)).padStart(3, '0')}`,
  index: 0,
  blockHeight: 0,
  blockTime: at,
  from: slot(from),
  to: slot(to),
  asset: { chain: 'tron', symbol: 'USDT', decimals: 6, contract: USDT },
  amount,
  kind: 'token',
  fetchId: 'f',
});

// The TRON storyline of the synthetic persona (same amounts and times as the fixture site).
const tronStory = [
  usdt('TRON-DEX', 'TRON-1', '5000', '2026-08-20T12:00:00.000Z'),
  usdt('TRON-1', 'TRON-DEP', '3000', '2026-08-22T09:00:00.000Z'),
  usdt('TRON-CP-1', 'TRON-1', '4000', '2026-10-01T10:00:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-1', '500', '2026-10-14T18:20:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-2', '1000', '2026-10-18T09:45:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-3', '500', '2026-10-22T20:10:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-4', '1000', '2026-10-27T13:05:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-5', '500', '2026-11-01T16:40:00.000Z'),
  usdt('TRON-1', 'TRON-P2P-6', '500', '2026-11-05T11:15:00.000Z'),
];
const depositSweep = usdt('TRON-DEP', 'TRON-HOT', '3000', '2026-08-22T11:30:00.000Z');
const tron1 = { chain: 'tron' as const, address: slot('TRON-1') };

const eth = (
  from: string,
  to: string,
  amount: string,
  txHash: string,
  at: string,
  block: number,
): NormalizedTransfer => ({
  chain: 'evm:1',
  txHash,
  blockHeight: block,
  blockTime: at,
  from,
  to,
  asset: { chain: 'evm:1', symbol: 'ETH', decimals: 18 },
  amount,
  kind: 'native',
  fetchId: 'f',
});

const b5Events = async (transfers: NormalizedTransfer[]) =>
  (await analyseAddress({ address: tron1, transfers, decisions: [] }, deps, ctx)).events.filter(
    (e) => e.ruleId === 'B5',
  );

const scoredEvent = (strength: 'strong' | 'medium' | 'flag', entity: string) =>
  ({ id: newId(), strength, hops: 0, counterparty: { address: entity, entity } }) as Parameters<
    typeof cashOutScore
  >[0][number];

describe('cash-out rules on the persona storyline', () => {
  it('TRON-1: B1 through the deposit address, B4 swap then exit, B5 round-number P2P pattern; score 72', async () => {
    const result = await analyseAddress(
      {
        address: tron1,
        transfers: tronStory,
        decisions: [],
        counterpartyTransfers: new Map([
          [
            addressKey({ chain: 'tron', address: slot('TRON-DEP') }),
            [tronStory[1] as NormalizedTransfer, depositSweep],
          ],
        ]),
        analysed: new Set([addressKey(tron1)]),
      },
      deps,
      ctx,
    );
    const { indicators, events } = result;
    expect(events.map((e) => [e.ruleId, e.strength])).toEqual([
      ['B1', 'strong'],
      ['B4', 'strong'],
      ['B5', 'medium'],
    ]);
    const [b1, b4, b5] = events;
    expect(b1).toMatchObject({
      amount: '3000',
      asset: 'USDT',
      occurredAt: '2026-08-22T09:00:00.000Z',
      txHashes: [tronStory[1]?.txHash, depositSweep.txHash],
      counterparty: { address: slot('TRON-DEP'), entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange' },
      valuation: { pln: '10950.00' },
    });
    expect(b4).toMatchObject({ amount: '3000', counterparty: { entity: 'Giełda Testowa (SYNTHETIC)' } });
    expect(b4?.explanation).toContain('share 0.6000');
    expect(b5).toMatchObject({ amount: '4000', plnTotal: '14600.00', counterparty: { address: slot('TRON-P2P-2') } });
    expect(b5?.components).toHaveLength(6);
    expect(indicators.cashOut.score).toBe(72);

    expect(indicators).toMatchObject({
      txCount: 9,
      counterpartyCount: 9,
      volumeIn: {
        native: '0',
        pln: '32850.00',
        byAsset: [{ asset: 'USDT', contract: USDT, amount: '9000', pln: '32850.00' }],
      },
      volumeOut: { native: '0', pln: '25550.00' },
      stablecoinConversionPln: '18250.00',
    });
    expect(indicators.swaps).toEqual([
      expect.objectContaining({
        detection: 'dex_inflow',
        intoStablecoin: true,
        bought: { asset: 'USDT', amount: '5000' },
      }),
    ]);
    expect(indicators.serviceInteractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'defi_dex', direction: 'in', count: 1, pln: '18250.00' }),
        expect.objectContaining({
          category: 'exchange',
          entity: 'Giełda Testowa (SYNTHETIC)',
          direction: 'out',
          pln: '10950.00',
        }),
      ]),
    );
    // flows: 9 direct legs and the deposit address's sweep as hop 2, in a chronological narrative
    expect(result.edges.map((e) => e.hop).toSorted()).toEqual([-1, -1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(result.timeline.slice(0, 4).map((t) => [t.kind, t.ruleId ?? ''])).toEqual([
      ['transfer', ''],
      ['swap', ''],
      ['transfer', ''],
      ['cash_out', 'B1'],
    ]);
  });

  it('ETH-1: an A4 deposit address yields one B1 per deposit and never counts its own sweep; score 60', async () => {
    const eth1 = slot('ETH-1').toLowerCase();
    const hot = slot('HOT-1').toLowerCase();
    const deposit = eth(
      slot('ETH-CP-1').toLowerCase(),
      eth1,
      '1.5',
      '0xdeposit',
      '2026-11-03T10:15:23.000Z',
      26_417_477,
    );
    const sweep = eth(eth1, hot, '1.499559', '0xsweep', '2026-11-03T10:42:11.000Z', 26_417_611);
    const a4: ExclusionDecision = {
      id: newId(),
      runId: ctx.runId,
      address: { chain: 'evm:1', address: eth1 },
      ruleId: 'A4',
      outcome: 'reclassified',
      relation: 'CUSTODIAL_EXCHANGE',
      emitsCashOut: 'B1',
      reason: 'A4: test',
      evidence: {
        kappa: 0.957013,
        forwardsTo: { address: hot, entity: 'Giełda Testowa (SYNTHETIC)', category: 'exchange', labelId: 'l1' },
        pairs: [
          {
            receiveTx: '0xdeposit',
            forwardTx: '0xsweep',
            amountIn: '1.5',
            amountOut: '1.499559',
            delta: 134,
            kappa: 0.957013,
          },
        ],
      },
      rulesVersion: 'exclusion.v1',
    };
    const { indicators, events } = await analyseAddress(
      { address: { chain: 'evm:1', address: eth1 }, transfers: [deposit, sweep], decisions: [a4] },
      deps,
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: 'B1',
      strength: 'strong',
      hops: 0,
      amount: '1.5',
      occurredAt: '2026-11-03T10:15:23.000Z',
      txHashes: ['0xdeposit', '0xsweep'],
      exclusionDecisionId: a4.id,
      counterparty: { address: hot, entity: 'Giełda Testowa (SYNTHETIC)' },
      valuation: { pln: '21626.25' }, // 1.5 × 3950 (synthetic) × 3.65 (synthetic)
    });
    expect(indicators.cashOut.score).toBe(60);
    expect(indicators.rulesVersion).toBe('activity.v1;cashout.v1;cashout-score.v1');
    expect(indicators.serviceInteractions).toEqual([
      expect.objectContaining({ category: 'exchange', direction: 'out', count: 1 }),
    ]);
  });

  it('B5 needs five round amounts to five distinct unlabelled recipients within the window', async () => {
    const p2p = tronStory.slice(3);
    expect(await b5Events(p2p)).toHaveLength(1);
    expect(await b5Events(p2p.slice(0, 4))).toHaveLength(0);
    expect(await b5Events(p2p.map((t) => Object.assign(structuredClone(t), { amount: '1234.56' })))).toHaveLength(0);
  });

  it('scores per counterparty group: one strong venue 60, two venues 84, strong + medium 72, flags 0', () => {
    const cfg = deps.score;
    expect(cashOutScore([scoredEvent('strong', 'A'), scoredEvent('strong', 'A')], cfg).score).toBe(60);
    expect(cashOutScore([scoredEvent('strong', 'A'), scoredEvent('strong', 'B')], cfg).score).toBe(84);
    expect(cashOutScore([scoredEvent('strong', 'A'), scoredEvent('medium', 'B')], cfg).score).toBe(72);
    expect(cashOutScore([scoredEvent('flag', 'A')], cfg).score).toBe(0);
  });
});
