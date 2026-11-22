/**
 * Fund-flow edges of the N-hop graph: the rows of a flow query valued in PLN (each leg at its own NBP rate) and the
 * counterparties worth fetching for the next hop. Edges are computed results, never statements about a person.
 */
import type { FlowEdge, FlowRow, RunContext } from '@olcys/core';
import { assetKey, type AssetRegistry, type Valuator } from './valuation.ts';

/**
 * One edge per row, in the order of the rows. A leg that cannot be valued (unknown token, no price or NBP rate) has no
 * `valuation`: it is flagged as unpriced, never valued as zero.
 */
export async function buildFlowEdges(
  rows: readonly FlowRow[],
  deps: { valuator: Valuator; assets: AssetRegistry },
  ctx: RunContext,
): Promise<FlowEdge[]> {
  const edges: FlowEdge[] = [];
  for (const row of rows) {
    // Sequential on purpose: the valuator memoises per asset and day and the NBP source is rate limited.
    // oxlint-disable-next-line no-await-in-loop
    const value = await deps.valuator.value({ asset: row.asset, amount: row.amount, at: row.blockTime }, ctx);
    edges.push({
      from: { chain: row.chain, address: row.from },
      to: { chain: row.chain, address: row.to },
      asset: assetKey(row.asset, deps.assets),
      amount: row.amount,
      txHash: row.txHash,
      ...(row.index === undefined ? {} : { index: row.index }),
      at: row.blockTime,
      hop: row.hop,
      ...(value.status === 'ok' ? { valuation: value.valuation } : {}),
      ...(row.isCycle ? { isCycle: true } : {}),
      ...(row.derivedFrom ? { derivedFrom: row.derivedFrom } : {}),
    });
  }
  return edges;
}

const key = (e: FlowEdge): string =>
  [e.from.chain, e.txHash, e.index ?? '', e.to.address, e.asset, e.amount, e.hop > 0 ? 'out' : 'in'].join('|');

/**
 * The edges with every transaction output counted once: a co-spend edge (`derivedFrom`) repeats the output of an original
 * edge (or of another co-spend edge) of the same transaction, so only one of them is kept (the original first).
 */
export function countOutputsOnce(edges: readonly FlowEdge[]): FlowEdge[] {
  const original = new Set(edges.filter((e) => !e.derivedFrom).map(key));
  const seen = new Set<string>();
  const kept: FlowEdge[] = [];
  for (const e of edges) {
    if (e.derivedFrom) {
      const k = key(e);
      if (original.has(k) || seen.has(k)) continue;
      seen.add(k);
    }
    kept.push(e);
  }
  return kept;
}
