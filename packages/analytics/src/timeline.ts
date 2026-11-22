/**
 * Chronological fund-flow timeline of one analysed address: transfers (the first hop by default), swaps and cash-out
 * indicators. Facts (transfers) and computations (valuations, indicators) stay separate entries by `kind`.
 */
import type { AddressRef, CashOutEvent, EntityCategory, FlowEdge, FlowTimelineEntry, SwapEvent } from '@olcys/core';
import { addressKey } from '@olcys/core';
import { countOutputsOnce } from './flow-edges.ts';

const KIND_ORDER: Record<FlowTimelineEntry['kind'], number> = { transfer: 0, swap: 1, cash_out: 2 };
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const refKey = (r: AddressRef | undefined): string => (r ? addressKey(r) : '');

export interface TimelineOptions {
  /** Deepest |hop| shown (default 1: the movements directly into and out of the analysed address). */
  maxHop?: number;
  /** The service on the other side of a transfer, when labelled (or inferred as an exchange deposit address). */
  counterparty?: (address: AddressRef) => { entity?: string; category?: EntityCategory } | undefined;
}

/** Sorted by time, then kind (transfer, swap, cash-out), then transaction, index, sender, recipient and rule: deterministic. */
export function buildTimeline(
  edges: readonly FlowEdge[],
  swaps: readonly SwapEvent[],
  events: readonly CashOutEvent[],
  options: TimelineOptions = {},
): FlowTimelineEntry[] {
  const maxHop = options.maxHop ?? 1;
  const entries: (FlowTimelineEntry & { index: number })[] = [];
  for (const e of countOutputsOnce(edges)) {
    if (e.hop === 0 || Math.abs(e.hop) > maxHop) continue;
    const other = e.hop > 0 ? e.to : e.from;
    const service = options.counterparty?.(other);
    entries.push({
      at: e.at,
      kind: 'transfer',
      txHashes: [e.txHash],
      index: e.index ?? -1,
      from: e.from,
      to: e.to,
      asset: e.asset,
      amount: e.amount,
      hop: e.hop,
      ...(e.valuation ? { valuation: e.valuation } : {}),
      ...(service && (service.entity || service.category)
        ? { counterparty: { address: other.address, ...service } }
        : {}),
    });
  }
  for (const s of swaps) {
    entries.push({
      at: s.at,
      kind: 'swap',
      txHashes: [s.txHash],
      index: -1,
      asset: s.bought.asset,
      amount: s.bought.amount,
      ...(s.valuation ? { valuation: s.valuation } : {}),
      ...(s.venue ? { counterparty: { entity: s.venue, category: 'defi_dex' as const } } : {}),
    });
  }
  for (const e of events) {
    entries.push({
      at: e.occurredAt,
      kind: 'cash_out',
      txHashes: [...e.txHashes],
      index: -1,
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
  return entries
    .toSorted(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        text(a.ruleId ?? '', b.ruleId ?? '') ||
        text(a.txHashes[0] ?? '', b.txHashes[0] ?? '') ||
        a.index - b.index ||
        text(refKey(a.from), refKey(b.from)) ||
        text(refKey(a.to), refKey(b.to)) ||
        text(a.amount ?? '', b.amount ?? ''),
    )
    .map(({ index: _index, ...entry }) => entry);
}
