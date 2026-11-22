/**
 * Bounded planning of the extra chain fetches the N-hop fund-flow graph needs: which counterparties of the fetched
 * addresses are worth one more fetch, and how much of each.
 */
import type { AddressRef, DecimalString } from '@olcys/core';
import { addressKey, dAdd, dCmp } from '@olcys/core';

/** A counterparty seen at the edge of the fetched graph. */
export interface HopFrontierItem {
  address: AddressRef;
  /** PLN value of the movement(s) that lead to it (absent: unpriced). */
  pln?: DecimalString;
  /** `out`: a recipient of funds, `in`: a sender of funds. Recipients are planned first. */
  direction?: 'out' | 'in';
}

/** What to fetch of one counterparty; structurally a `ChainFetchPlanItem` of `@olcys/chain-adapters`. */
export interface HopPlanItem {
  address: AddressRef;
  want: { summary?: boolean; transfers?: boolean; utxo?: boolean; code?: boolean };
}

export interface HopExpansionDeps {
  /** A labelled service: funds that reach it are not followed. */
  isService(address: AddressRef): boolean;
  /** An address on the deny list or excluded by a decision. */
  isExcluded(address: AddressRef): boolean;
  /** Address keys (`addressKey`) already fetched in this run. */
  fetched: ReadonlySet<string>;
  /** Transaction count of an already fetched summary. */
  txCount(address: AddressRef): number | undefined;
}

export interface HopExpansionBudget {
  /** Most addresses fetched per hop (25). */
  perHop: number;
  /** Addresses with at least this many transactions are leaves: summary only, no transfer history (1000). */
  maxTxCount: number;
}

export const DEFAULT_HOP_BUDGET: HopExpansionBudget = { perHop: 25, maxTxCount: 1000 };

/**
 * The counterparties to fetch for the next hop: recipients first, then senders, each by PLN value descending (unpriced
 * last, then in the order given). Services, excluded and already fetched addresses are skipped; at most `perHop` are
 * planned; a very active address is only summarised (`want.transfers: false`) because its history would not be
 * followed anyway. An address whose summary is unknown is fetched in full (the fetch bounds its pages).
 */
export function planHopExpansion(
  frontier: readonly HopFrontierItem[],
  deps: HopExpansionDeps,
  budget: HopExpansionBudget = DEFAULT_HOP_BUDGET,
): HopPlanItem[] {
  const merged = new Map<string, HopFrontierItem & { first: number }>();
  frontier.forEach((item, first) => {
    const key = addressKey(item.address);
    const known = merged.get(key);
    if (!known) {
      merged.set(key, { ...item, first });
      return;
    }
    // The same counterparty on several movements: values add up, a recipient role wins over a sender role.
    if (item.pln !== undefined) known.pln = known.pln === undefined ? item.pln : dAdd(known.pln, item.pln);
    if (item.direction !== 'in') known.direction = 'out';
  });
  const rank = (i: HopFrontierItem): number => (i.direction === 'in' ? 1 : 0);
  const ordered = [...merged.values()].toSorted((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((a.pln === undefined) !== (b.pln === undefined)) return a.pln === undefined ? 1 : -1;
    if (a.pln !== undefined && b.pln !== undefined) {
      const byValue = dCmp(b.pln, a.pln);
      if (byValue !== 0) return byValue;
    }
    return a.first - b.first;
  });
  const plan: HopPlanItem[] = [];
  for (const item of ordered) {
    if (plan.length >= budget.perHop) break;
    const key = addressKey(item.address);
    if (deps.fetched.has(key) || deps.isService(item.address) || deps.isExcluded(item.address)) continue;
    const count = deps.txCount(item.address);
    plan.push({
      address: item.address,
      want:
        count !== undefined && count >= budget.maxTxCount
          ? { summary: true, transfers: false, utxo: false, code: false }
          : { summary: count === undefined, code: false },
    });
  }
  return plan;
}
