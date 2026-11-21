import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressClient, EgressRequest, EgressResponse, RunContext } from '@olcys/core';
import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import {
  createAssetRegistry,
  createNbpFxRateSource,
  createSeriesPriceSource,
  createValuator,
  loadPriceDataset,
  warsawDate,
} from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Synthetic NBP-format responses (made-up rates, not real NBP data). */
const SYNTHETIC_NBP: Record<string, { no: string; effectiveDate: string; mid: string }[]> = {
  '2026-10': [
    { no: '198/A/NBP/2026', effectiveDate: '2026-10-13', mid: '3.7000' },
    { no: '211/A/NBP/2026', effectiveDate: '2026-10-30', mid: '3.6600' },
  ],
  '2026-11': [
    { no: '212/A/NBP/2026', effectiveDate: '2026-11-02', mid: '3.6550' },
    { no: '217/A/NBP/2026', effectiveDate: '2026-11-09', mid: '3.6450' },
    { no: '218/A/NBP/2026', effectiveDate: '2026-11-10', mid: '3.6500' },
    { no: '219/A/NBP/2026', effectiveDate: '2026-11-12', mid: '3.6480' },
  ],
};

function nbpStub(): EgressClient & { requests: EgressRequest[] } {
  const requests: EgressRequest[] = [];
  return {
    requests,
    async fetch(request: EgressRequest): Promise<EgressResponse> {
      requests.push(request);
      const month = /\/(\d{4}-\d{2})-01\//.exec(request.url)?.[1] ?? '';
      const rates = SYNTHETIC_NBP[month];
      // NBP answers 404 "Brak danych" for a range without tables; the mid values stay JSON numbers.
      const text = rates
        ? `{"table":"A","currency":"dolar amerykański","code":"USD","rates":[${rates
            .map((r) => `{"no":"${r.no}","effectiveDate":"${r.effectiveDate}","mid":${r.mid}}`)
            .join(',')}]}`
        : '404 NotFound - Not Found - Brak danych';
      return {
        status: rates ? 200 : 404,
        finalUrl: request.url,
        headers: {},
        body: new TextEncoder().encode(text),
        text: () => text,
        json: <T>() => JSON.parse(text) as T,
        provenance: { fetchId: newId() } as EgressResponse['provenance'],
      };
    },
  };
}

const ctxWith = (http: EgressClient): RunContext => ({
  runId: newId(),
  caseId: newId(),
  mode: 'offline',
  http,
  blobs: {} as RunContext['blobs'],
  clock: { now: () => new Date('2026-11-21T12:00:00Z') },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

describe('NBP Table A, previous business day in Warsaw', () => {
  it('uses the Warsaw calendar date', () => {
    expect(warsawDate('2026-11-12T23:30:00Z')).toBe('2026-11-13');
    expect(warsawDate('2026-11-12T22:59:00Z')).toBe('2026-11-12');
  });

  it('picks the latest table strictly before the day, skipping holidays without a calendar', async () => {
    const http = nbpStub();
    const fx = createNbpFxRateSource();
    const ctx = ctxWith(http);
    // 11-11 is a holiday (no table): a transaction on 11-12 uses the 11-10 table
    expect(await fx.plnRate('USD', '2026-11-12T08:00:00Z', ctx)).toEqual({
      table: '218/A/NBP/2026',
      effectiveDate: '2026-11-10',
      currency: 'USD',
      rate: '3.6500',
    });
    // 23:30 UTC is already 11-13 in Warsaw → the 11-12 table
    expect((await fx.plnRate('USD', '2026-11-12T23:30:00Z', ctx)).effectiveDate).toBe('2026-11-12');
    // Monday 11-02 → Friday 10-30 (previous month)
    expect((await fx.plnRate('USD', '2026-11-02T10:00:00Z', ctx)).table).toBe('211/A/NBP/2026');
    // one request per month, never identifying, month-aligned URLs that stop at today
    expect(http.requests.map((r) => r.url)).toEqual([
      'https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-11-01/2026-11-21/?format=json',
      'https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-10-01/2026-10-31/?format=json',
    ]);
    expect(http.requests.every((r) => !r.containsIdentifier && r.sourceId === 'nbp_api')).toBe(true);
  });

  it('treats a month without tables as empty and reports a missing rate as unpriced', async () => {
    const valuator = createValuator({
      fx: createNbpFxRateSource(),
      prices: createSeriesPriceSource(
        loadPriceDataset(readFileSync(join(ROOT, 'fixtures/prices/demo-prices.v1.json'), 'utf8')),
      ),
      assets: createAssetRegistry(),
    });
    const result = await valuator.value(
      { asset: { chain: 'bitcoin', symbol: 'BTC', decimals: 8 }, amount: '0.1', at: '2026-03-05T10:00:00Z' },
      ctxWith(nbpStub()),
    );
    expect(result).toMatchObject({ status: 'unpriced', reason: 'no_fx_rate' });
  });
});

describe('valuator', () => {
  const dataset = loadPriceDataset(readFileSync(join(ROOT, 'fixtures/prices/demo-prices.v1.json'), 'utf8'));
  const valuator = createValuator({
    fx: createNbpFxRateSource(),
    prices: createSeriesPriceSource(dataset),
    assets: createAssetRegistry(),
  });
  const ctx = ctxWith(nbpStub());
  const eth = { chain: 'evm:1' as const, symbol: 'ETH', decimals: 18 };

  it('values ETH with synthetic price lineage and the NBP table of the previous business day', async () => {
    const result = await valuator.value({ asset: eth, amount: '0.01', at: '2026-10-14T09:12:00Z' }, ctx);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.valuation).toMatchObject({
      pln: '148.00',
      asset: 'ETH',
      method: 'nbp_table_a_previous_business_day',
      nbp: { table: '198/A/NBP/2026', effectiveDate: '2026-10-13', rate: '3.7000' },
      price: { source: 'synthetic', pair: 'ETH/USD', close: '4000', candleTime: '2026-10-01T00:00:00.000Z' },
    });
    expect(result.valuation.price?.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('values USDT-TRC20 at the visible peg assumption and never values unknown tokens', async () => {
    const usdt = {
      chain: 'tron' as const,
      symbol: 'USDT',
      decimals: 6,
      contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    };
    const ok = await valuator.value({ asset: usdt, amount: '4800', at: '2026-11-12T08:45:00Z' }, ctx);
    expect(ok.status === 'ok' && ok.valuation).toMatchObject({
      pln: '17520.00',
      price: { source: 'peg-assumption', pair: 'USDT/USD', close: '1' },
    });
    const fake = { ...usdt, contract: 'TSyntheticFakeUsdtContract0000000' };
    expect(await valuator.value({ asset: fake, amount: '4800', at: '2026-11-12T08:45:00Z' }, ctx)).toEqual({
      status: 'unpriced',
      reason: 'unknown_asset',
    });
  });

  it('rounds half-up once at the end', async () => {
    const tiny = await valuator.value({ asset: eth, amount: '0.000000000000000001', at: '2026-10-14T09:12:00Z' }, ctx);
    expect(tiny.status === 'ok' && tiny.valuation.pln).toBe('0.00');
  });
});
