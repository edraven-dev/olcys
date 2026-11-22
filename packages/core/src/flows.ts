/**
 * Fund-flow tracing over stored transfers: the pure core of `queryFlowEdges` (PostgreSQL, one query per hop
 * in `@olcys/db`; the in-memory store uses `traceFlows`). Both have the same semantics:
 *
 * - downstream (`out`): hop 1 is the transfers leaving a seed; each next hop takes the transfers leaving the recipients
 *   reached in the previous hop, not older than the earliest transfer that reached that address (time-monotonic);
 *   upstream (`in`) mirrors it with hops −1, −2, … and the latest departure;
 * - an address is expanded once (breadth first), so every transfer is returned once, at its first hop; an exit address
 *   already visited (a seed or an earlier hop) marks the edge `isCycle` and is not expanded; stop addresses (labelled
 *   service, excluded address) end the path;
 * - the result is ordered by |hop|, time, transaction, index, sender, recipient and cut at `limit` (`truncated` tells
 *   that more existed).
 *
 * Browser-safe: pure functions and types.
 */
import type { NormalizedTransfer } from './chain-data.ts';
import { chainFamily, type AddressRef, type ChainId } from './chains.ts';
import type { DecimalString, Id, IsoDateTime } from './common.ts';
import type { EntityCategory } from './labels.ts';
import type { FlowTimelineEntry } from './analytics.ts';

/** One stored transfer reached by a flow query. */
export interface FlowRow extends NormalizedTransfer {
  /** Downstream `1…N`, upstream `−1…−N` (see `FlowEdge.hop`). */
  hop: number;
  /** The recipient (downstream) or sender (upstream) already appeared on the path: not expanded further. */
  isCycle: boolean;
}

export interface FlowQuery {
  chain: ChainId;
  /** Canonical addresses on `chain` the paths start at. */
  seeds: readonly string[];
  direction: 'out' | 'in';
  maxHops: number;
  /** Addresses a path ends at (labelled services, excluded addresses). */
  stopAt: readonly string[];
  /** Most edges returned. */
  limit: number;
}

export interface FlowQueryResult {
  rows: FlowRow[];
  truncated: boolean;
}

/** Default bound of the edges one flow query returns. */
export const DEFAULT_FLOW_EDGE_LIMIT = 2000;

/** The address as compared by flow queries: EVM addresses are case-insensitive. */
export function flowAddress(chain: ChainId, address: string): string {
  return chainFamily(chain) === 'evm' ? address.toLowerCase() : address;
}

const text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Order of the rows a flow query returns (`COLLATE "C"` on the text columns in SQL). */
export function compareFlowRows(a: FlowRow, b: FlowRow): number {
  return (
    Math.abs(a.hop) - Math.abs(b.hop) ||
    Date.parse(a.blockTime) - Date.parse(b.blockTime) ||
    text(a.txHash, b.txHash) ||
    (a.index ?? -1) - (b.index ?? -1) ||
    text(flowAddress(a.chain, a.from), flowAddress(b.chain, b.from)) ||
    text(flowAddress(a.chain, a.to), flowAddress(b.chain, b.to)) ||
    text(a.amount, b.amount)
  );
}

/** Identity of a stored transfer for the query: `transferKey` with case-folded endpoints. */
function rowKey(t: NormalizedTransfer): string {
  return [
    t.chain,
    t.txHash,
    t.index ?? '',
    t.kind,
    flowAddress(t.chain, t.from),
    flowAddress(t.chain, t.to),
    `${t.asset.symbol}:${t.asset.contract ?? ''}`,
    t.amount,
  ].join('|');
}

/** One address of the frontier of a hop and the time its funds arrived (`out`: earliest) or left (`in`: latest). */
export interface FlowFrontierItem {
  /** Case-folded address. */
  address: string;
  /** Absent for the seeds of the first hop: every transfer of a seed counts. */
  at?: IsoDateTime;
}

/**
 * Loads the distinct transfers of one hop: those leaving (`out`) or entering (`in`) a frontier address, not older (`out`)
 * or not newer (`in`) than its time. `limit` is the most rows the caller can still use; a store may stop reading at
 * `limit` rows in the order of `compareFlowRows`.
 */
export type FlowHopLoader = (frontier: readonly FlowFrontierItem[], limit: number) => Promise<NormalizedTransfer[]>;

/**
 * Bounded address-level breadth-first walk: per hop one entry per address (with its earliest arrival, or latest departure
 * upstream), the next hop takes the transfers leaving that address from that time on. An address is expanded once, so
 * every transfer is emitted once, at its first hop, and the work stays linear in the transfers however many parallel
 * transfers a leg has. An exit address already visited (a seed or an earlier hop) marks the edge `isCycle` and is not
 * expanded; stop addresses are not expanded either.
 */
export async function walkFlows(load: FlowHopLoader, q: FlowQuery): Promise<FlowQueryResult> {
  const out = q.direction === 'out';
  const norm = (a: string): string => flowAddress(q.chain, a);
  const exit = (t: NormalizedTransfer): string => norm(out ? t.to : t.from);
  const seeds = [...new Set(q.seeds.map(norm))];
  const stop = new Set(q.stopAt.map(norm));
  const visited = new Set(seeds);
  const rows: FlowRow[] = [];
  let frontier: FlowFrontierItem[] = seeds.map((address) => ({ address }));
  for (let hop = 1; hop <= q.maxHops && frontier.length > 0; hop += 1) {
    const signed = out ? hop : -hop;
    // Sequential on purpose: each hop starts from the previous one.
    // oxlint-disable-next-line no-await-in-loop
    const loaded = await load(frontier, q.limit + 1 - rows.length);
    const reached: FlowRow[] = [];
    for (const t of loaded) reached.push(Object.assign({}, t, { hop: signed, isCycle: visited.has(exit(t)) }));
    reached.sort(compareFlowRows);
    if (rows.length + reached.length > q.limit) {
      rows.push(...reached.slice(0, q.limit - rows.length));
      return { rows, truncated: true };
    }
    rows.push(...reached);
    const next = new Map<string, string>();
    for (const row of reached) {
      const at = exit(row);
      if (row.isCycle || stop.has(at)) continue;
      const known = next.get(at);
      // Downstream the earliest arrival counts, upstream the latest departure.
      const better =
        known === undefined ||
        (out ? Date.parse(row.blockTime) < Date.parse(known) : Date.parse(row.blockTime) > Date.parse(known));
      if (better) next.set(at, row.blockTime);
    }
    for (const row of reached) visited.add(exit(row));
    frontier = [...next].map(([address, at]) => ({ address, at }));
  }
  return { rows, truncated: false };
}

/** The in-memory flow query: `walkFlows` over an index of the distinct transfers of the chain. */
export function traceFlows(transfers: readonly NormalizedTransfer[], q: FlowQuery): Promise<FlowQueryResult> {
  const out = q.direction === 'out';
  const norm = (a: string): string => flowAddress(q.chain, a);
  const unique = new Map<string, NormalizedTransfer>();
  for (const t of transfers) {
    if (t.chain !== q.chain || norm(t.from) === norm(t.to)) continue;
    const key = rowKey(t);
    if (!unique.has(key)) unique.set(key, t);
  }
  const byEntry = new Map<string, NormalizedTransfer[]>();
  for (const t of unique.values()) {
    const entry = norm(out ? t.from : t.to);
    const list = byEntry.get(entry) ?? [];
    list.push(t);
    byEntry.set(entry, list);
  }
  return walkFlows(async (frontier) => {
    const found: NormalizedTransfer[] = [];
    for (const item of frontier) {
      const from = item.at === undefined ? undefined : Date.parse(item.at);
      for (const t of byEntry.get(item.address) ?? []) {
        const time = Date.parse(t.blockTime);
        if (from === undefined || (out ? time >= from : time <= from)) found.push(t);
      }
    }
    return found;
  }, q);
}

/** A node of the Sankey diagram: an address at a layer (`id`: `${chain}:${address}#${layer}`). */
export interface FundFlowSankeyNode {
  id: string;
  address: AddressRef;
  layer: number;
  kind: 'subject' | 'service' | 'unlabelled';
  entity?: string;
  category?: EntityCategory;
  /** The merged remainder of the links below the top-N cut (one per layer); its `address.address` is empty. */
  isOther?: true;
}

export interface FundFlowSankeyLink {
  source: string;
  target: string;
  /** Sum of the priced legs (absent when none is priced). */
  pln?: DecimalString;
  /** False when at least one leg of the link has no valuation. */
  plnComplete: boolean;
  byAsset: { asset: string; amount: DecimalString }[];
  txCount: number;
}

/** Layered, acyclic aggregate of fund-flow edges (every link goes from layer k to k + 1). */
export interface FundFlowSankey {
  nodes: FundFlowSankeyNode[];
  links: FundFlowSankeyLink[];
}

/** Fund-flow view of one analysed address: timeline and Sankey aggregate (computed results). */
export interface FundFlowView {
  runId: Id;
  address: AddressRef;
  timeline: FlowTimelineEntry[];
  sankey: FundFlowSankey;
  /** The edge limit cut the graph: the view shows only part of what was reachable. */
  truncated: boolean;
  computedAt: IsoDateTime;
}
