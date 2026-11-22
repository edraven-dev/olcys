/**
 * @olcys/analytics — PLN valuation (NBP Table A, PIT rule), activity indicators, swaps and stablecoin conversion,
 * cash-out rules (B1, B4, B5) with a separate cash-out score, and fund flows for the report narrative.
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export {
  ACTIVITY_RULES_VERSION,
  computeActivity,
  createCounterpartyResolver,
  detectSwaps,
  legsOf,
  utxoVolumes,
  GENERAL_PURPOSE_METHODS,
  SWAP_METHODS,
  type AddressAnalysisInput,
  type AnalyticsDeps,
  type Counterparty,
  type CounterpartyResolver,
  type Leg,
} from './activity.ts';
export {
  cashOutScore,
  evaluateCashOut,
  loadCashOutRules,
  loadCashOutScoreConfig,
  type CashOutDeps,
  type CashOutRulesConfig,
  type CashOutScoreConfig,
} from './cashout.ts';
export { buildFlowEdges } from './flow-edges.ts';
export {
  DEFAULT_HOP_BUDGET,
  planHopExpansion,
  type HopExpansionBudget,
  type HopExpansionDeps,
  type HopFrontierItem,
  type HopPlanItem,
} from './hop-expansion.ts';
export { buildSankey, edgeLayers, SANKEY_MAX_LINKS } from './sankey.ts';
export { buildTimeline, type TimelineOptions } from './timeline.ts';
export { analyseAddress, buildFundFlow, planCounterpartyExpansion, type AddressAnalysis } from './flows.ts';
export {
  addDays,
  assetKey,
  createAssetRegistry,
  createNbpFxRateSource,
  createSeriesPriceSource,
  createValuator,
  DEFAULT_ASSETS,
  loadPriceDataset,
  ValuationUnavailableError,
  warsawDate,
  type AssetEntry,
  type AssetInfo,
  type AssetRegistry,
  type NbpOptions,
  type NbpRate,
  type PriceDataset,
  type ValuationResult,
  type Valuator,
} from './valuation.ts';
