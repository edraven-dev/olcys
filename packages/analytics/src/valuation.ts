/**
 * PLN valuation following the PIT rule (art. 11a ustawy o PIT): the NBP Table A average rate of the last business
 * day BEFORE the transaction day, the day being the calendar date in Europe/Warsaw. NBP publishes no table on
 * holidays, so no holiday calendar is needed: the latest table dated before the day (within 10 days) is used.
 * Crypto prices never come from a per-transaction price API: they come from a local dataset (synthetic in the
 * demo); USD stablecoins use an explicit, visible 1:1 peg assumption.
 */
import { createHash } from 'node:crypto';
import type {
  AssetRef,
  ChainId,
  DecimalString,
  EgressClient,
  FxRateSource,
  IsoDate,
  IsoDateTime,
  PriceSource,
  RunContext,
  Sha256Hex,
  Valuation,
} from '@olcys/core';
import { dMul, dRound } from '@olcys/core';

// --- errors ---------------------------------------------------------------------------------------------------------

/** Expected valuation failure (no NBP table, no price point); turned into `unpriced` by the valuator. */
export class ValuationUnavailableError extends Error {
  readonly reason: 'no_fx_rate' | 'no_candle';
  constructor(reason: 'no_fx_rate' | 'no_candle', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValuationUnavailableError';
    this.reason = reason;
  }
}

// --- dates ----------------------------------------------------------------------------------------------------------

const WARSAW = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date in Europe/Warsaw: `2026-11-12T23:30:00Z` → `2026-11-13`. */
export function warsawDate(at: IsoDateTime): IsoDate {
  return WARSAW.format(new Date(at));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(from: IsoDate, to: IsoDate): string[] {
  const months: string[] = [];
  let cursor = `${from.slice(0, 7)}-01`;
  while (cursor <= to) {
    months.push(cursor.slice(0, 7));
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return months;
}

function lastDayOfMonth(month: string): IsoDate {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// --- NBP ------------------------------------------------------------------------------------------------------------

export interface NbpRate {
  table: string;
  effectiveDate: IsoDate;
  currency: string;
  /** Exact source text of the NBP `mid` value, e.g. `3.6500`. */
  mid: DecimalString;
}

export interface NbpOptions {
  /** Default `https://api.nbp.pl/api`. */
  baseUrl?: string;
  /** Default `nbp_api` (GREEN; queries reveal only dates and currencies). */
  sourceId?: string;
  /**
   * Egress client for NBP (default: the run's `ctx.http`). Lets a demo run fetch NBP live while chain data comes
   * from the fixture site.
   */
  http?: EgressClient;
  maxLookbackDays?: number;
}

/** JSON with exact decimals (`3.6500` stays `3.6500`). */
function parseExact(text: string): unknown {
  return JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined
      ? context.source
      : value) as (this: unknown, key: string, value: unknown) => unknown);
}

const failureName = (error: unknown): string => (error instanceof Error ? error.name : '');

/**
 * NBP Table A rates, fetched per calendar month and currency (stable URLs, so recorded cassettes are reusable
 * across runs): `GET {base}/exchangerates/rates/a/{code}/{YYYY-MM-01}/{YYYY-MM-last}/?format=json`. A 404
 * ("Brak danych") is an empty month. Ranges end at today's Warsaw date.
 */
export function createNbpFxRateSource(options: NbpOptions = {}): FxRateSource {
  const baseUrl = (options.baseUrl ?? 'https://api.nbp.pl/api').replace(/\/+$/, '');
  const sourceId = options.sourceId ?? 'nbp_api';
  const lookback = options.maxLookbackDays ?? 10;
  const months = new Map<string, Promise<NbpRate[]>>();

  async function fetchMonth(code: string, month: string, ctx: RunContext): Promise<NbpRate[]> {
    const today = warsawDate(ctx.clock.now().toISOString());
    const from = `${month}-01`;
    if (from > today) return [];
    const last = lastDayOfMonth(month);
    const to = last < today ? last : today;
    const http = options.http ?? ctx.http;
    let response;
    try {
      response = await http.fetch({
        url: `${baseUrl}/exchangerates/rates/a/${code.toLowerCase()}/${from}/${to}/?format=json`,
        headers: { accept: 'application/json' },
        sourceId,
        purpose: 'NBP Table A rates',
        containsIdentifier: false,
        runId: ctx.runId,
      });
    } catch (error) {
      const name = failureName(error);
      if (
        name === 'ReplayMissError' ||
        name === 'EgressDeniedError' ||
        name === 'TimeoutError' ||
        name === 'TypeError'
      ) {
        throw new ValuationUnavailableError('no_fx_rate', `NBP ${code} ${month}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (response.status === 404) return [];
    if (response.status !== 200) {
      throw new ValuationUnavailableError('no_fx_rate', `NBP ${code} ${month}: HTTP ${response.status}`);
    }
    const body = parseExact(response.text()) as {
      code?: string;
      rates?: { no: string; effectiveDate: string; mid: unknown }[];
    };
    return (body.rates ?? []).map((r) => ({
      table: r.no,
      effectiveDate: r.effectiveDate,
      currency: (body.code ?? code).toUpperCase(),
      mid: String(r.mid),
    }));
  }

  // The current month gains a table every business day: it is cached for one run only, a finished month for good.
  const current = new Map<string, Promise<NbpRate[]>>();
  let currentRun: string | undefined;

  function monthRates(code: string, m: string, ctx: RunContext): Promise<NbpRate[]> {
    const key = `${code.toUpperCase()}|${m}`;
    const finished = lastDayOfMonth(m) < warsawDate(ctx.clock.now().toISOString());
    if (!finished && currentRun !== ctx.runId) {
      current.clear();
      currentRun = ctx.runId;
    }
    const cache = finished ? months : current;
    let rates = cache.get(key);
    if (!rates) {
      rates = fetchMonth(code, m, ctx);
      // A failed month is retried by a later valuation (e.g. after a transient error).
      rates.catch(() => cache.delete(key));
      cache.set(key, rates);
    }
    return rates;
  }

  return {
    async plnRate(currency: string, transactionAt: IsoDateTime, ctx: RunContext): Promise<Valuation['nbp']> {
      const day = warsawDate(transactionAt);
      const earliest = addDays(day, -lookback);
      const wanted = monthsBetween(earliest, addDays(day, -1));
      // Sequential: at most two months, each fetched once per source instance.
      const candidates: NbpRate[] = [];
      for (const m of wanted.toReversed()) {
        // oxlint-disable-next-line no-await-in-loop
        candidates.push(...(await monthRates(currency, m, ctx)));
        if (candidates.some((r) => r.effectiveDate < day && r.effectiveDate >= earliest)) break;
      }
      const best = candidates
        .filter((r) => r.effectiveDate < day && r.effectiveDate >= earliest)
        .toSorted((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0];
      if (!best) throw new ValuationUnavailableError('no_fx_rate', `no NBP ${currency} table before ${day}`);
      return { table: best.table, effectiveDate: best.effectiveDate, currency: best.currency, rate: best.mid };
    },
  };
}

// --- prices ---------------------------------------------------------------------------------------------------------

export interface PriceDataset {
  id: string;
  version: string;
  /** `synthetic` for the demo dataset. */
  source: string;
  license: string;
  sha256: Sha256Hex;
  series: Record<string, { from: IsoDateTime; close: DecimalString }[]>;
}

/** Parses a local price file (`fixtures/prices/demo-prices.v1.json`); its SHA-256 goes into every price lineage. */
export function loadPriceDataset(text: string): PriceDataset {
  const doc = JSON.parse(text) as {
    dataset?: { id?: string; version?: string; source?: string; license?: string };
    series?: Record<string, { from: string; close: string }[]>;
  };
  if (!doc.dataset?.id || !doc.series) throw new Error('price dataset: missing dataset or series');
  const series: PriceDataset['series'] = {};
  for (const [pair, points] of Object.entries(doc.series)) {
    series[pair] = points
      .map((p) => ({ from: new Date(p.from).toISOString(), close: String(p.close) }))
      .toSorted((a, b) => (a.from < b.from ? -1 : 1));
  }
  return {
    id: doc.dataset.id,
    version: doc.dataset.version ?? 'v1',
    source: doc.dataset.source ?? 'unknown',
    license: doc.dataset.license ?? 'unknown',
    sha256: createHash('sha256').update(text).digest('hex'),
    series,
  };
}

/** Piecewise-constant series: the price at `at` is the latest point at or before it (at most `maxAgeDays` old). */
export function createSeriesPriceSource(dataset: PriceDataset, options: { maxAgeDays?: number } = {}): PriceSource {
  const maxAgeMs = (options.maxAgeDays ?? 62) * 86_400_000;
  return {
    price(asset: string, quote: string, at: IsoDateTime): Promise<NonNullable<Valuation['price']>> {
      const pair = `${asset}/${quote}`;
      const t = Date.parse(at);
      const point = (dataset.series[pair] ?? []).findLast((p) => Date.parse(p.from) <= t);
      if (!point || t - Date.parse(point.from) > maxAgeMs) {
        return Promise.reject(
          new ValuationUnavailableError('no_candle', `no ${pair} price for ${at} in ${dataset.id}`),
        );
      }
      return Promise.resolve({
        source: dataset.source,
        pair,
        candleTime: point.from,
        close: point.close,
        datasetSha256: dataset.sha256,
      });
    },
  };
}

// --- assets ---------------------------------------------------------------------------------------------------------

export interface AssetInfo {
  symbol: string;
  priceSymbol: string;
  quote: 'USD' | 'EUR';
  stablecoin?: { peg: 'USD' | 'EUR' };
  /** Where the identification comes from (issuer page) or `native`. */
  source: string;
}

export interface AssetEntry extends AssetInfo {
  chain: ChainId;
  /** Token contract (canonical: EVM lower-case); absent for the chain's native asset. */
  contract?: string;
}

const native = (chain: ChainId, symbol: string, extra: Partial<AssetInfo> = {}): AssetEntry => ({
  chain,
  symbol,
  priceSymbol: symbol,
  quote: 'USD',
  source: 'native',
  ...extra,
});
const usd = (chain: ChainId, symbol: string, contract: string, source: string): AssetEntry => ({
  chain,
  contract,
  symbol,
  priceSymbol: symbol,
  quote: 'USD',
  stablecoin: { peg: 'USD' },
  source,
});

/** Natives and the major USD stablecoins, identified by chain + contract (never by symbol: fake tokens exist). */
export const DEFAULT_ASSETS: readonly AssetEntry[] = [
  native('bitcoin', 'BTC'),
  ...(['evm:1', 'evm:10', 'evm:8453', 'evm:42161', 'evm:59144', 'evm:unknown'] as const).map((c) => native(c, 'ETH')),
  native('evm:137', 'POL'),
  native('evm:56', 'BNB'),
  native('evm:100', 'xDAI', { priceSymbol: 'DAI', stablecoin: { peg: 'USD' } }),
  native('tron', 'TRX'),
  native('solana', 'SOL'),
  usd('evm:1', 'USDT', '0xdac17f958d2ee523a2206206994597c13d831ec7', 'https://tether.to/en/supported-protocols/'),
  usd(
    'evm:1',
    'USDC',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  ),
  usd('tron', 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'https://tether.to/en/supported-protocols/'),
];

export interface AssetRegistry {
  resolve(asset: AssetRef): AssetInfo | undefined;
}

const canonical = (chain: string, contract: string): string =>
  chain.startsWith('evm:') ? contract.toLowerCase() : contract;

const registryKey = (chain: string, contract?: string): string =>
  `${chain}|${contract ? canonical(chain, contract) : ''}`;

export function createAssetRegistry(entries: readonly AssetEntry[] = DEFAULT_ASSETS): AssetRegistry {
  const map = new Map(entries.map((e) => [registryKey(e.chain, e.contract), e]));
  return {
    resolve(asset: AssetRef): AssetInfo | undefined {
      const entry = map.get(registryKey(asset.chain, asset.contract));
      if (!entry) return undefined;
      const { chain: _chain, contract: _contract, ...info } = entry;
      return info;
    },
  };
}

/** `ETH`, `USDT`, or `SYMBOL:contract` for a token missing from the registry (never valued). */
export function assetKey(asset: AssetRef, assets: AssetRegistry): string {
  const info = assets.resolve(asset);
  if (info) return info.symbol;
  return asset.contract ? `${asset.symbol || 'TOKEN'}:${asset.contract}` : asset.symbol;
}

// --- valuator -------------------------------------------------------------------------------------------------------

export type ValuationResult =
  | { status: 'ok'; valuation: Valuation }
  | { status: 'unpriced'; reason: 'unknown_asset' | 'no_candle' | 'no_fx_rate'; detail?: string };

export interface Valuator {
  value(input: { asset: AssetRef; amount: DecimalString; at: IsoDateTime }, ctx: RunContext): Promise<ValuationResult>;
}

/** `pln = round(amount × close × NBP rate, 2)` half-up, once at the end; results are memoised per run. */
export function createValuator(deps: { fx: FxRateSource; prices: PriceSource; assets: AssetRegistry }): Valuator {
  const memo = new Map<string, Promise<ValuationResult>>();

  async function compute(
    asset: AssetRef,
    amount: DecimalString,
    at: IsoDateTime,
    ctx: RunContext,
  ): Promise<ValuationResult> {
    const info = deps.assets.resolve(asset);
    if (!info) return { status: 'unpriced', reason: 'unknown_asset' };
    try {
      const price: NonNullable<Valuation['price']> = info.stablecoin
        ? { source: 'peg-assumption', pair: `${info.priceSymbol}/${info.stablecoin.peg}`, candleTime: at, close: '1' }
        : await deps.prices.price(info.priceSymbol, info.quote, at);
      const nbp = await deps.fx.plnRate(info.stablecoin?.peg ?? info.quote, at, ctx);
      const pln = dRound(dMul(dMul(amount, price.close), nbp.rate), 2);
      return {
        status: 'ok',
        valuation: { amount, asset: info.symbol, at, pln, method: 'nbp_table_a_previous_business_day', nbp, price },
      };
    } catch (error) {
      if (error instanceof ValuationUnavailableError)
        return { status: 'unpriced', reason: error.reason, detail: error.message };
      throw error;
    }
  }

  return {
    value({ asset, amount, at }, ctx) {
      const key = `${ctx.runId}|${asset.chain}|${asset.contract ?? asset.symbol}|${amount}|${at}`;
      let result = memo.get(key);
      if (!result) {
        result = compute(asset, amount, at, ctx);
        memo.set(key, result);
      }
      return result;
    },
  };
}
