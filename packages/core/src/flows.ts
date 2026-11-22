/**
 * Fund-flow tracing over stored transfers: the pure core of `queryFlowEdges` (PostgreSQL recursive CTE in
 * `@olcys/db`; the in-memory store uses `traceFlows`). Both have the same semantics:
 *
 * - downstream (`out`): paths start with the transfers leaving a seed (hop 1) and continue with transfers leaving the
 *   previous recipient that are not older than the previous transfer (time-monotonic); upstream (`in`) mirrors it with
 *   hops −1, −2, … and transfers that are not newer;
 * - a path stops at a stop address (labelled service, excluded address) and at a seed reached again (shown, not
 *   expanded); an address repeated on a path closes a cycle: the edge is returned with `isCycle` and not expanded;
 * - every transfer is returned once, at its smallest |hop|; the result is ordered by |hop|, time, transaction, index,
 *   sender, recipient and cut at `limit` (`truncated` tells that more existed).
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

interface Step {
  transfer: NormalizedTransfer;
  time: number;
  hop: number;
  isCycle: boolean;
}

export function traceFlows(transfers: readonly NormalizedTransfer[], q: FlowQuery): FlowQueryResult {
  const out = q.direction === 'out';
  const norm = (a: string): string => flowAddress(q.chain, a);
  // One edge per distinct transfer; self-transfers move nothing between addresses.
  const unique = new Map<string, NormalizedTransfer>();
  for (const t of transfers) {
    if (t.chain !== q.chain || norm(t.from) === norm(t.to)) continue;
    const key = rowKey(t);
    if (!unique.has(key)) unique.set(key, t);
  }
  /** The address a transfer is entered from (`out`: its sender) and left to (its recipient). */
  const entry = (t: NormalizedTransfer): string => norm(out ? t.from : t.to);
  const exit = (t: NormalizedTransfer): string => norm(out ? t.to : t.from);
  const byEntry = new Map<string, NormalizedTransfer[]>();
  for (const t of unique.values()) {
    const list = byEntry.get(entry(t)) ?? [];
    list.push(t);
    byEntry.set(entry(t), list);
  }
  const seeds = new Set(q.seeds.map(norm));
  const stop = new Set(q.stopAt.map(norm));

  /** Per distinct transfer: the smallest |hop| reached and whether every path at that hop closed a cycle. */
  const best = new Map<string, Step>();
  const visit = (step: Step, path: readonly string[]): void => {
    const key = rowKey(step.transfer);
    const known = best.get(key);
    if (!known || Math.abs(step.hop) < Math.abs(known.hop)) best.set(key, step);
    else if (Math.abs(step.hop) === Math.abs(known.hop)) known.isCycle &&= step.isCycle;
    const at = exit(step.transfer);
    if (step.isCycle || Math.abs(step.hop) >= q.maxHops || stop.has(at) || seeds.has(at)) return;
    for (const next of byEntry.get(at) ?? []) {
      const time = Date.parse(next.blockTime);
      if (out ? time < step.time : time > step.time) continue;
      const to = exit(next);
      visit({ transfer: next, time, hop: step.hop + (out ? 1 : -1), isCycle: path.includes(to) }, [...path, to]);
    }
  };
  for (const seed of seeds) {
    for (const t of byEntry.get(seed) ?? []) {
      visit({ transfer: t, time: Date.parse(t.blockTime), hop: out ? 1 : -1, isCycle: false }, [exit(t)]);
    }
  }
  const reached: FlowRow[] = [];
  for (const s of best.values()) reached.push(Object.assign({}, s.transfer, { hop: s.hop, isCycle: s.isCycle }));
  const rows = reached.toSorted(compareFlowRows);
  return { rows: rows.slice(0, q.limit), truncated: rows.length > q.limit };
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
