import type { AddressRef, ChainId } from './chains.ts';
import type { DecimalString, Id, IsoDate, IsoDateTime, Sha256Hex } from './common.ts';
import type { EntityCategory } from './labels.ts';

/**
 * PLN value of an amount at a moment, following the PIT rule: the NBP Table A average rate of the last
 * business day before the transaction (art. 11a). Price lineage is kept for reproducibility.
 */
export interface Valuation {
  amount: DecimalString;
  asset: string;
  at: IsoDateTime;
  pln: DecimalString;
  method: 'nbp_table_a_previous_business_day';
  /** `synthetic`: the rate came from a synthetic source (demo data), not from the NBP. */
  nbp: { table: string; effectiveDate: IsoDate; currency: string; rate: DecimalString; synthetic?: boolean };
  price?: { source: string; pair: string; candleTime: IsoDateTime; close: DecimalString; datasetSha256?: Sha256Hex };
}

/** Fiat cash-out indicators. */
export const CASH_OUT_RULE_IDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'] as const;
export type CashOutRuleId = (typeof CASH_OUT_RULE_IDS)[number];

export const INDICATOR_STRENGTHS = ['strong', 'medium', 'weak', 'flag'] as const;
export type IndicatorStrength = (typeof INDICATOR_STRENGTHS)[number];

export interface CashOutEvent {
  id: Id;
  runId: Id;
  address: AddressRef;
  ruleId: CashOutRuleId;
  strength: IndicatorStrength;
  occurredAt: IsoDateTime;
  txHashes: string[];
  amount: DecimalString;
  asset: string;
  valuation?: Valuation;
  counterparty: { address: string; labelId?: Id; entity?: string; category?: EntityCategory };
  /** 0 = direct transfer; > 0 = indirect exposure (decayed per hop). */
  hops: number;
  explanation: string;
  rulesVersion: string;
  /** B1 emitted by an exclusion decision (A4: the address is an exchange deposit address). */
  exclusionDecisionId?: Id;
  /** Aggregated events (B3 monthly, B5 windows): the legs, each valued on its own day. */
  components?: { txHash: string; at: IsoDateTime; amount: DecimalString; valuation?: Valuation }[];
  /** Sum of the components' PLN values (`valuation` is omitted then: NBP tables differ per day). */
  plnTotal?: DecimalString;
}

export interface SwapEvent {
  chain: ChainId;
  txHash: string;
  at: IsoDateTime;
  venue?: string;
  /** For `detection: 'dex_inflow'` the sold leg is not visible in the fetched data: asset `UNKNOWN`, amount `0`. */
  sold: { asset: string; amount: DecimalString };
  bought: { asset: string; amount: DecimalString };
  intoStablecoin: boolean;
  valuation?: Valuation;
  /**
   * How the swap was recognised: both legs in one transaction confirmed by a DEX label (`dex_label`) or a swap method
   * name (`method`), or only the proceeds received from a labelled DEX pool or router (`dex_inflow`).
   */
  detection?: 'dex_label' | 'method' | 'dex_inflow';
}

export interface VolumeTotals {
  /** Sum of the chain's native asset (incl. internal transfers), in whole units. */
  native: DecimalString;
  /** Sum of the priced legs, each valued at its own NBP rate. */
  pln?: DecimalString;
  /** Per asset (`assetKey`: `ETH`, `USDT`, or `SYMBOL:contract` for unknown tokens). */
  byAsset?: { asset: string; contract?: string; amount: DecimalString; pln?: DecimalString }[];
  /** Number of legs without a valuation (unknown token, no price or no NBP rate). */
  unpriced?: number;
}

export interface ActivityIndicators {
  address: AddressRef;
  window: { from?: IsoDateTime; to?: IsoDateTime };
  txCount: number;
  volumeIn: VolumeTotals;
  volumeOut: VolumeTotals;
  counterpartyCount: number;
  serviceInteractions: {
    category: EntityCategory;
    entity: string;
    direction: 'in' | 'out';
    count: number;
    pln?: DecimalString;
    /** How many of the `count` interactions are valued in `pln`; absent in older data (then `pln` is complete). */
    priced?: number;
  }[];
  swaps: SwapEvent[];
  stablecoinConversionPln?: DecimalString;
  cashOut: { events: CashOutEvent[]; score: number };
  computedAt: IsoDateTime;
  rulesVersion: string;
}

/** Edge of the fund-flow graph / Sankey. */
export interface FlowEdge {
  from: AddressRef;
  to: AddressRef;
  asset: string;
  amount: DecimalString;
  txHash: string;
  /** Log or trace index of the transfer within its transaction (distinguishes several transfers of one transaction). */
  index?: number;
  at: IsoDateTime;
  /**
   * Downstream (destination of funds) `1…N`, the edge leaving an analysed address is `1`; upstream (source of funds)
   * `−1…−N`, the edge entering an analysed address is `−1`.
   */
  hop: number;
  valuation?: Valuation;
  /** A co-spend row (Bitcoin): the same output as an original edge; aggregations count the output once. */
  derivedFrom?: 'co_spend';
  /** True when the edge closes a loop back to an address already on the path (never expanded further). */
  isCycle?: boolean;
}

/** One entry of the chronological fund-flow narrative (transfers, swaps and cash-out indicators). */
export interface FlowTimelineEntry {
  at: IsoDateTime;
  kind: 'transfer' | 'swap' | 'cash_out';
  txHashes: string[];
  from?: AddressRef;
  to?: AddressRef;
  asset?: string;
  amount?: DecimalString;
  valuation?: Valuation;
  hop?: number;
  ruleId?: CashOutRuleId;
  strength?: IndicatorStrength;
  /** The service on the other side, when labelled (or inferred as an exchange deposit address). */
  counterparty?: { address?: string; entity?: string; category?: EntityCategory };
}
