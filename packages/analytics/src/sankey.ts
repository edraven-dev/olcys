/**
 * Sankey-ready aggregate of fund-flow edges: layered and acyclic (every link goes from layer k to k + 1), so a chart
 * library that rejects cycles can draw it. Edges that close a cycle and self-transfers are dropped.
 */
import type {
  AddressLabel,
  AddressRef,
  DecimalString,
  FlowEdge,
  FundFlowSankey,
  FundFlowSankeyLink,
  FundFlowSankeyNode,
} from '@olcys/core';
import { addressKey, dAdd, dCmp, dRound, flowAddress } from '@olcys/core';

/** Links kept before the rest is merged into one remainder node per layer. */
export const SANKEY_MAX_LINKS = 50;

const keyOf = (ref: AddressRef): string =>
  addressKey({ chain: ref.chain, address: flowAddress(ref.chain, ref.address) });
const nodeId = (key: string, layer: number): string => `${key}#${layer}`;

/** Layers of an edge's endpoints: downstream hop h goes from layer h − 1 to h, upstream hop −h from −h to −h + 1. */
export function edgeLayers(hop: number): { from: number; to: number } {
  return hop > 0 ? { from: hop - 1, to: hop } : { from: hop, to: hop + 1 };
}

const layerOf = (id: string): number => Number(id.slice(id.lastIndexOf('#') + 1));

interface Acc {
  source: string;
  target: string;
  pln?: DecimalString;
  complete: boolean;
  byAsset: Map<string, DecimalString>;
  txCount: number;
}

const accumulate = (
  acc: Acc,
  asset: string,
  amount: DecimalString,
  pln: DecimalString | undefined,
  txs: number,
): void => {
  acc.byAsset.set(asset, dAdd(acc.byAsset.get(asset) ?? '0', amount));
  if (pln === undefined) acc.complete = false;
  else acc.pln = acc.pln === undefined ? pln : dAdd(acc.pln, pln);
  acc.txCount += txs;
};

/**
 * Nodes are addresses at a layer (`id`: `${addressKey}#${layer}`), links aggregate the edges between two nodes: priced
 * legs add up in PLN (`plnComplete: false` as soon as one leg is unpriced), amounts add up per asset. At most
 * `maxLinks` links (by PLN, descending) are kept; the others go to one remainder node per layer.
 * `seeds` and `labels` are keyed by `addressKey`.
 */
export function buildSankey(
  edges: readonly FlowEdge[],
  seeds: ReadonlySet<string>,
  labels: ReadonlyMap<string, AddressLabel>,
  options: { maxLinks?: number } = {},
): FundFlowSankey {
  const maxLinks = options.maxLinks ?? SANKEY_MAX_LINKS;
  const refs = new Map<string, AddressRef>();
  const merged = new Map<string, Acc>();
  for (const edge of edges) {
    const from = keyOf(edge.from);
    const to = keyOf(edge.to);
    if (edge.isCycle || from === to || edge.hop === 0) continue;
    const layers = edgeLayers(edge.hop);
    const source = nodeId(from, layers.from);
    const target = nodeId(to, layers.to);
    refs.set(source, edge.from);
    refs.set(target, edge.to);
    const key = `${source}>${target}`;
    const acc: Acc = merged.get(key) ?? { source, target, complete: true, byAsset: new Map(), txCount: 0 };
    merged.set(key, acc);
    accumulate(acc, edge.asset, edge.amount, edge.valuation?.pln, 1);
  }
  const ranked = [...merged.values()].toSorted((a, b) => {
    // Priced links first, by PLN descending; then a stable order by ids.
    if (a.pln !== undefined && b.pln !== undefined) {
      const byValue = dCmp(b.pln, a.pln);
      if (byValue !== 0) return byValue;
    } else if (a.pln !== undefined || b.pln !== undefined) {
      return a.pln === undefined ? 1 : -1;
    }
    const ka = `${a.source}>${a.target}`;
    const kb = `${b.source}>${b.target}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const kept = new Map<string, Acc>(ranked.slice(0, maxLinks).map((l) => [`${l.source}>${l.target}`, l]));
  const others = new Map<string, AddressRef>();
  for (const dropped of ranked.slice(maxLinks)) {
    // Incoming side (sources in layers below 0): the dropped senders merge into one node per layer and the real
    // recipient stays; outgoing side: the dropped recipients merge and the real sender stays.
    const incoming = layerOf(dropped.source) < 0;
    const mergedId = `other#${layerOf(incoming ? dropped.source : dropped.target)}`;
    const source = incoming ? mergedId : dropped.source;
    const target = incoming ? dropped.target : mergedId;
    const chain = refs.get(incoming ? dropped.target : dropped.source)?.chain ?? 'bitcoin';
    others.set(mergedId, { chain, address: '' });
    const key = `${source}>${target}`;
    const acc: Acc = kept.get(key) ?? { source, target, complete: true, byAsset: new Map(), txCount: 0 };
    kept.set(key, acc);
    for (const [asset, amount] of dropped.byAsset) acc.byAsset.set(asset, dAdd(acc.byAsset.get(asset) ?? '0', amount));
    if (dropped.pln !== undefined) acc.pln = acc.pln === undefined ? dropped.pln : dAdd(acc.pln, dropped.pln);
    if (!dropped.complete) acc.complete = false;
    acc.txCount += dropped.txCount;
  }

  const used = new Set([...kept.values()].flatMap((l) => [l.source, l.target]));
  const nodes: FundFlowSankeyNode[] = [];
  for (const id of used) {
    const layer = layerOf(id);
    const ref = refs.get(id);
    if (!ref) {
      nodes.push({
        id,
        address: others.get(id) ?? { chain: 'bitcoin', address: '' },
        layer,
        kind: 'unlabelled',
        isOther: true,
      });
      continue;
    }
    const key = keyOf(ref);
    const label = labels.get(key);
    const node: FundFlowSankeyNode = {
      id,
      address: ref,
      layer,
      kind: seeds.has(key) ? 'subject' : label ? 'service' : 'unlabelled',
    };
    if (label) Object.assign(node, { entity: label.entity, category: label.category });
    nodes.push(node);
  }
  const links: FundFlowSankeyLink[] = [];
  for (const l of kept.values()) {
    const link: FundFlowSankeyLink = {
      source: l.source,
      target: l.target,
      plnComplete: l.complete,
      byAsset: [...l.byAsset]
        .map(([asset, amount]) => ({ asset, amount }))
        .toSorted((x, y) => (x.asset < y.asset ? -1 : 1)),
      txCount: l.txCount,
    };
    if (l.pln !== undefined) link.pln = dRound(l.pln, 2);
    links.push(link);
  }
  return {
    nodes: nodes.toSorted((x, y) => x.layer - y.layer || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
    links,
  };
}
