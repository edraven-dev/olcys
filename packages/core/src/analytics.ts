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
  nbp: { table: string; effectiveDate: IsoDate; currency: string; rate: DecimalString };
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
}

export interface SwapEvent {
  chain: ChainId;
  txHash: string;
  at: IsoDateTime;
  venue?: string;
  sold: { asset: string; amount: DecimalString };
  bought: { asset: string; amount: DecimalString };
  intoStablecoin: boolean;
  valuation?: Valuation;
}

export interface VolumeTotals {
  native: DecimalString;
  pln?: DecimalString;
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
  at: IsoDateTime;
  hop: number;
  valuation?: Valuation;
}
