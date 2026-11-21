/**
 * Fund flows of an analysed address for the report's chronological narrative: direct transfers (hop 1 out, hop −1
 * in) plus the sweep of an exchange deposit address the funds went through (hop 2), valued in PLN; and the
 * timeline merging transfers, swaps and cash-out indicators. Flows are computed results, not facts.
 */
import type {
  ActivityIndicators,
  AddressRef,
  CashOutEvent,
  FlowEdge,
  FlowTimelineEntry,
  LabelLookup,
  NormalizedTransfer,
  RunContext,
  SwapEvent,
} from '@olcys/core';
import { addressKey } from '@olcys/core';
import {
  ACTIVITY_RULES_VERSION,
  computeActivity,
  createCounterpartyResolver,
  legsOf,
  type AddressAnalysisInput,
  type AnalyticsDeps,
  type CounterpartyResolver,
} from './activity.ts';
import { cashOutScore, evaluateCashOut, type CashOutDeps, type CashOutScoreConfig } from './cashout.ts';
import { assetKey } from './valuation.ts';

const KIND_ORDER: Record<FlowTimelineEntry['kind'], number> = { transfer: 0, swap: 1, cash_out: 2 };

export async function buildFundFlow(
  input: AddressAnalysisInput & { swaps: readonly SwapEvent[]; events: readonly CashOutEvent[] },
  deps: AnalyticsDeps,
  ctx: RunContext,
  resolver: CounterpartyResolver = createCounterpartyResolver(deps, input),
): Promise<{ edges: FlowEdge[]; timeline: FlowTimelineEntry[] }> {
  const chain = input.address.chain;
  const edge = async (t: NormalizedTransfer, hop: number): Promise<FlowEdge> => {
    const value = await deps.valuator.value({ asset: t.asset, amount: t.amount, at: t.blockTime }, ctx);
    return {
      from: { chain, address: t.from },
      to: { chain, address: t.to },
      asset: assetKey(t.asset, deps.assets),
      amount: t.amount,
      txHash: t.txHash,
      at: t.blockTime,
      hop,
      ...(value.status === 'ok' ? { valuation: value.valuation } : {}),
    };
  };

  const edges: FlowEdge[] = [];
  for (const leg of legsOf(input, deps)) {
    // oxlint-disable-next-line no-await-in-loop
    edges.push(await edge(leg.transfer, leg.direction === 'out' ? 1 : -1));
  }
  // Hop 2: the sweep of an exchange deposit address the funds were sent to (B1 through a deposit address).
  const own = new Set(edges.map((e) => e.txHash));
  for (const event of input.events) {
    const sweepTx = event.ruleId === 'B1' ? event.txHashes[1] : undefined;
    if (!sweepTx || own.has(sweepTx)) continue;
    const via = input.counterpartyTransfers?.get(addressKey({ chain, address: event.counterparty.address }));
    const sweep = via?.find((t) => t.txHash === sweepTx);
    // oxlint-disable-next-line no-await-in-loop
    if (sweep) edges.push(await edge(sweep, 2));
  }

  const timeline: FlowTimelineEntry[] = [];
  for (const e of edges) {
    const other = e.hop > 0 ? e.to.address : e.from.address;
    // oxlint-disable-next-line no-await-in-loop
    const cp = await resolver.resolve(chain, other, e.at);
    timeline.push({
      at: e.at,
      kind: 'transfer',
      txHashes: [e.txHash],
      from: e.from,
      to: e.to,
      asset: e.asset,
      amount: e.amount,
      hop: e.hop,
      ...(e.valuation ? { valuation: e.valuation } : {}),
      ...(cp ? { counterparty: { address: other, entity: cp.entity, category: cp.category } } : {}),
    });
  }
  for (const s of input.swaps) {
    timeline.push({
      at: s.at,
      kind: 'swap',
      txHashes: [s.txHash],
      asset: s.bought.asset,
      amount: s.bought.amount,
      ...(s.valuation ? { valuation: s.valuation } : {}),
      ...(s.venue ? { counterparty: { entity: s.venue, category: 'defi_dex' as const } } : {}),
    });
  }
  for (const e of input.events) {
    timeline.push({
      at: e.occurredAt,
      kind: 'cash_out',
      txHashes: e.txHashes,
      asset: e.asset,
      amount: e.amount,
      ...(e.valuation ? { valuation: e.valuation } : {}),
      ruleId: e.ruleId,
      strength: e.strength,
      counterparty: {
        address: e.counterparty.address,
        ...(e.counterparty.entity ? { entity: e.counterparty.entity } : {}),
        ...(e.counterparty.category ? { category: e.counterparty.category } : {}),
      },
    });
  }
  timeline.sort(
    (a, b) =>
      (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.ruleId ?? '').localeCompare(b.ruleId ?? '') ||
      (a.txHashes[0] ?? '').localeCompare(b.txHashes[0] ?? ''),
  );
  return { edges: edges.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)), timeline };
}

/**
 * Counterparties worth one more fetch: recipients of the address's outgoing legs that carry no label (a deposit
 * address shows itself only through its own sweeps). Bounded, in time order; already fetched addresses skipped.
 */
export async function planCounterpartyExpansion(
  input: Pick<AddressAnalysisInput, 'address' | 'transfers'>,
  deps: { labels: LabelLookup; assets: AnalyticsDeps['assets'] },
  options: { fetched?: ReadonlySet<string>; limit?: number } = {},
): Promise<AddressRef[]> {
  const out: AddressRef[] = [];
  const seen = new Set(options.fetched ?? []);
  seen.add(addressKey(input.address));
  const legs = legsOf({ ...input, decisions: [] }, deps)
    .filter((l) => l.direction === 'out')
    .toSorted((a, b) => (a.transfer.blockTime < b.transfer.blockTime ? -1 : 1));
  for (const leg of legs) {
    if (out.length >= (options.limit ?? 25)) break;
    const ref = { chain: input.address.chain, address: leg.counterparty };
    if (seen.has(addressKey(ref)) || leg.counterparty === '') continue;
    seen.add(addressKey(ref));
    // oxlint-disable-next-line no-await-in-loop
    if ((await deps.labels.labelsFor(ref)).length > 0) continue;
    out.push(ref);
  }
  return out;
}

export interface AddressAnalysis {
  indicators: ActivityIndicators;
  events: CashOutEvent[];
  edges: FlowEdge[];
  timeline: FlowTimelineEntry[];
}

/** Activity, cash-out events and score, and fund flows of one analysed address in one call. */
export async function analyseAddress(
  input: AddressAnalysisInput,
  deps: CashOutDeps & { score: CashOutScoreConfig },
  ctx: RunContext,
): Promise<AddressAnalysis> {
  const resolver = createCounterpartyResolver(deps, input);
  const activity = await computeActivity(input, deps, ctx, resolver);
  const events = await evaluateCashOut({ ...input, swaps: activity.swaps }, deps, ctx, resolver);
  const { edges, timeline } = await buildFundFlow({ ...input, swaps: activity.swaps, events }, deps, ctx, resolver);
  return {
    indicators: {
      ...activity,
      cashOut: { events, score: cashOutScore(events, deps.score).score },
      rulesVersion: `${ACTIVITY_RULES_VERSION};${deps.rules.version};${deps.score.version}`,
    },
    events,
    edges,
    timeline,
  };
}
