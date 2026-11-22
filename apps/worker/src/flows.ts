/**
 * Fund flows of the chain stage: bounded hop expansion (extra chain fetches of counterparties, each a normal logged
 * fetch through the egress client) and the flow graph computed from the stored transfers (edges valued in PLN, per
 * analysed address a timeline and a Sankey aggregate). Flows are computed results, not facts.
 */
import type { ChainFetchOutcome, ChainFetchPlanItem, ChainFetchResult } from '@olcys/chain-adapters';
import {
  buildFlowEdges,
  buildSankey,
  buildTimeline,
  legsOf,
  planHopExpansion,
  DEFAULT_HOP_BUDGET,
  type AssetRegistry,
  type HopExpansionBudget,
  type HopFrontierItem,
  type Valuator,
} from '@olcys/analytics';
import type {
  AddressLabel,
  AddressRef,
  CashOutEvent,
  FlowEdge,
  FlowQuery,
  FlowQueryResult,
  FlowRow,
  FundFlowView,
  Id,
  NormalizedTransfer,
  RunContext,
  SwapEvent,
  UtxoTransaction,
} from '@olcys/core';
import { addressKey, DEFAULT_FLOW_EDGE_LIMIT, flowAddress, traceFlows } from '@olcys/core';
import { canonicalAddress } from '@olcys/labels';
import { transfersOf } from './chain-data.ts';

export interface FlowSettings {
  /** Hops of counterparties fetched beyond the analysed addresses (`OLCYS_FLOW_EXPANSION_HOPS`, 0 disables). */
  expansionHops: number;
  /** Deepest hop of the flow graph (`maxHops` of the cash-out rules). */
  maxHops: number;
  /** Most edges per flow query. */
  edgeLimit: number;
  budget: HopExpansionBudget;
}

/** Expansion depth from the environment, bounded by the graph depth; a bad value falls back to the default (1). */
export function flowSettings(env: Readonly<Record<string, string | undefined>>, maxHops: number): FlowSettings {
  const raw = env['OLCYS_FLOW_EXPANSION_HOPS']?.trim();
  const parsed = raw === undefined || raw === '' ? 1 : Number(raw);
  const hops = Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
  return {
    expansionHops: Math.min(hops, maxHops),
    maxHops,
    edgeLimit: DEFAULT_FLOW_EDGE_LIMIT,
    budget: DEFAULT_HOP_BUDGET,
  };
}

/** What the flow computation needs to know about an address: a labelled service or an excluded address. */
export interface EndpointClass {
  service: boolean;
  excluded: boolean;
}

/** Every transfer and Bitcoin transaction known to the run so far (analysed addresses and fetched counterparties). */
export interface TransferPool {
  transfers: NormalizedTransfer[];
  utxoTxs: UtxoTransaction[];
}

export interface HopExpansionArgs {
  seeds: readonly AddressRef[];
  settings: FlowSettings;
  pool: TransferPool;
  /** Address keys whose history is already fetched; grows with every pass. */
  fetched: Set<string>;
  /** Transaction counts of the fetched summaries by address key; grows with every pass. */
  txCounts: Map<string, number>;
  assets: AssetRegistry;
  valuator: Valuator;
  ctx: RunContext;
  classify(address: AddressRef): Promise<EndpointClass>;
  /** One logged chain fetch through the egress client. */
  fetch(plan: ChainFetchPlanItem[]): Promise<ChainFetchResult>;
  /** Called with the transfers of every counterparty whose history was fetched, with its hop (1…N). */
  onFetched(address: AddressRef, transfers: NormalizedTransfer[], hop: number): Promise<void>;
}

export interface HopExpansionResult {
  outcomes: ChainFetchOutcome[];
  /** Addresses fetched per hop (history), summary-only leaves included under `leaves`. */
  fetchedPerHop: AddressRef[][];
  leaves: AddressRef[];
}

const utxoOf = (pool: TransferPool, a: AddressRef): UtxoTransaction[] =>
  pool.utxoTxs.filter(
    (tx) => tx.chain === a.chain && [...tx.inputs, ...tx.outputs].some((io) => io.address === a.address),
  );

/** The counterparties of a source's movements, with the PLN value of what moved. */
async function frontierOf(args: HopExpansionArgs, sources: readonly AddressRef[]): Promise<HopFrontierItem[]> {
  const items: HopFrontierItem[] = [];
  for (const source of sources) {
    const legs = legsOf(
      {
        address: source,
        transfers: transfersOf(source, args.pool.transfers, args.pool.utxoTxs),
        utxoTxs: utxoOf(args.pool, source),
        decisions: [],
      },
      { assets: args.assets },
    );
    for (const leg of legs) {
      if (leg.counterparty === '') continue;
      // Sequential on purpose: the valuator memoises per asset and day and the NBP source is rate limited.
      // oxlint-disable-next-line no-await-in-loop
      const value = await args.valuator.value(
        { asset: leg.transfer.asset, amount: leg.transfer.amount, at: leg.transfer.blockTime },
        args.ctx,
      );
      items.push({
        address: canonicalAddress({ chain: source.chain, address: leg.counterparty }),
        direction: leg.direction,
        ...(value.status === 'ok' ? { pln: value.valuation.pln } : {}),
      });
    }
  }
  return items;
}

/**
 * Up to `settings.expansionHops` passes: the counterparties of the analysed addresses (then of the addresses fetched in
 * the previous pass) are planned by `planHopExpansion` (≤ 25 per pass, no services, excluded or fetched addresses),
 * their summaries fetched first so very active addresses stay leaves, then the histories of the others.
 */
export async function expandFlowHops(args: HopExpansionArgs): Promise<HopExpansionResult> {
  const result: HopExpansionResult = { outcomes: [], fetchedPerHop: [], leaves: [] };
  let sources: readonly AddressRef[] = args.seeds;
  for (let hop = 1; hop <= args.settings.expansionHops && sources.length > 0; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const frontier = await frontierOf(args, sources);
    const classes = new Map<string, EndpointClass>();
    for (const item of frontier) {
      const key = addressKey(item.address);
      // oxlint-disable-next-line no-await-in-loop
      if (!classes.has(key)) classes.set(key, await args.classify(item.address));
    }
    const plan = planHopExpansion(
      frontier,
      {
        isService: (a) => classes.get(addressKey(a))?.service ?? false,
        isExcluded: (a) => classes.get(addressKey(a))?.excluded ?? false,
        fetched: args.fetched,
        txCount: (a) => args.txCounts.get(addressKey(a)),
      },
      args.settings.budget,
    );
    if (plan.length === 0) break;
    for (const item of plan) args.fetched.add(addressKey(item.address));

    // Pass A: summaries of the addresses not summarised yet (they decide who is a leaf).
    const unknown = plan.filter((i) => i.want.summary && i.want.transfers !== false);
    if (unknown.length) {
      // oxlint-disable-next-line no-await-in-loop
      const summarised = await args.fetch(
        unknown.map((i) => ({
          address: i.address,
          want: { summary: true, transfers: false, utxo: false, code: false },
        })),
      );
      result.outcomes.push(...summarised.outcomes);
      for (const s of summarised.summaries) args.txCounts.set(addressKey(s.address), s.txCount);
    }
    const missing = new Set(
      result.outcomes.filter((o) => o.status !== 'ok' && o.status !== 'truncated').map((o) => addressKey(o.address)),
    );
    const heavy = (a: AddressRef): boolean =>
      (args.txCounts.get(addressKey(a)) ?? 0) >= args.settings.budget.maxTxCount;
    const histories = plan
      .filter((i) => i.want.transfers !== false && !heavy(i.address) && !missing.has(addressKey(i.address)))
      .map((i) => i.address);
    // Heavy addresses were summarised only: their history is not followed.
    result.leaves.push(...plan.filter((i) => i.want.transfers === false || heavy(i.address)).map((i) => i.address));

    // Pass B: the histories.
    const fetchedNow: AddressRef[] = [];
    if (histories.length) {
      // oxlint-disable-next-line no-await-in-loop
      const fetched = await args.fetch(
        histories.map((address) => ({ address, want: { summary: false, code: false } })),
      );
      result.outcomes.push(...fetched.outcomes);
      args.pool.transfers.push(...fetched.transfers);
      args.pool.utxoTxs.push(...fetched.utxoTxs);
      for (const address of histories) {
        // oxlint-disable-next-line no-await-in-loop
        await args.onFetched(address, transfersOf(address, fetched.transfers, fetched.utxoTxs), hop);
        fetchedNow.push(address);
      }
    }
    result.fetchedPerHop.push(fetchedNow);
    sources = fetchedNow;
  }
  return result;
}

export interface FlowGraphArgs {
  runId: Id;
  seeds: readonly AddressRef[];
  settings: FlowSettings;
  pool: TransferPool;
  assets: AssetRegistry;
  valuator: Valuator;
  ctx: RunContext;
  classify(address: AddressRef): Promise<EndpointClass>;
  /** The best label of an address (service name and category), if any. */
  labelOf(address: AddressRef): Promise<AddressLabel | undefined>;
  swapsOf(seed: AddressRef): readonly SwapEvent[];
  eventsOf(seed: AddressRef): readonly CashOutEvent[];
  query?: (runId: Id, query: FlowQuery) => Promise<FlowQueryResult>;
  computedAt: string;
}

export interface FlowGraph {
  edges: FlowEdge[];
  views: FundFlowView[];
  /** Number of flow queries cut at the edge limit. */
  truncatedQueries: number;
}

const edgeKey = (e: FlowEdge): string =>
  [e.from.chain, e.txHash, e.index ?? -1, e.from.address, e.to.address, e.asset, e.hop].join('|');

/**
 * Flow queries per analysed address and direction over the stored transfers, valued in PLN; paths stop at labelled
 * services and excluded addresses. Without a store query (`query` absent) the same trace runs over the pool.
 */
export async function computeFlowGraph(args: FlowGraphArgs): Promise<FlowGraph> {
  const run = args.query ?? ((_: Id, q: FlowQuery): Promise<FlowQueryResult> => traceFlows(args.pool.transfers, q));
  // Stop addresses: every labelled service and excluded address among the endpoints of the known transfers.
  const stopByChain = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const t of args.pool.transfers) {
    for (const address of [t.from, t.to]) {
      const ref = { chain: t.chain, address };
      const key = addressKey({ chain: t.chain, address: flowAddress(t.chain, address) });
      if (seen.has(key)) continue;
      seen.add(key);
      // oxlint-disable-next-line no-await-in-loop
      const cls = await args.classify(ref);
      if (cls.service || cls.excluded) {
        const stops = stopByChain.get(t.chain) ?? new Set<string>();
        stops.add(flowAddress(t.chain, address));
        stopByChain.set(t.chain, stops);
      }
    }
  }
  const labelByKey = new Map<string, AddressLabel>();
  const seedKeys = new Set(args.seeds.map(addressKey));
  const edges = new Map<string, FlowEdge>();
  const views: FundFlowView[] = [];
  let truncatedQueries = 0;
  for (const seed of args.seeds) {
    const rows: FlowRow[] = [];
    let truncated = false;
    for (const direction of ['out', 'in'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const found = await run(args.runId, {
        chain: seed.chain,
        seeds: [seed.address],
        direction,
        maxHops: args.settings.maxHops,
        stopAt: [...(stopByChain.get(seed.chain) ?? [])],
        limit: args.settings.edgeLimit,
      });
      rows.push(...found.rows);
      if (found.truncated) {
        truncated = true;
        truncatedQueries += 1;
      }
    }
    // oxlint-disable-next-line no-await-in-loop
    const seedEdges = await buildFlowEdges(rows, args, args.ctx);
    for (const e of seedEdges) if (!edges.has(edgeKey(e))) edges.set(edgeKey(e), e);
    for (const e of seedEdges) {
      for (const ref of [e.from, e.to]) {
        const key = addressKey(ref);
        if (labelByKey.has(key)) continue;
        // oxlint-disable-next-line no-await-in-loop
        const label = await args.labelOf(ref);
        if (label) labelByKey.set(key, label);
      }
    }
    const timeline = buildTimeline(seedEdges, args.swapsOf(seed), args.eventsOf(seed), {
      counterparty: (a) => {
        const label = labelByKey.get(addressKey(a));
        return label ? { entity: label.entity, category: label.category } : undefined;
      },
    });
    const sankey = buildSankey(seedEdges, seedKeys, labelByKey);
    // An address without any movement or indicator has nothing to show.
    if (timeline.length || sankey.links.length) {
      views.push({ runId: args.runId, address: seed, timeline, sankey, truncated, computedAt: args.computedAt });
    }
  }
  return { edges: [...edges.values()], views, truncatedQueries };
}
