/**
 * In-memory `LabelLookup` (the demo and tests; the PostgreSQL lookup follows the same semantics):
 * exact canonical match (an `evm:unknown` query matches labels on any EVM chain), validity at a point in time
 * (`activeFrom ≤ date ≤ activeTo`, inclusive) and ranking by dataset trust order, confidence, lastmod and id.
 */
import type { AddressLabel, AddressRef, IsoDateTime, LabelLookup, LabelSourceType } from '@olcys/core';
import { chainFamily, LABEL_SOURCE_TYPES } from '@olcys/core';

/** EVM addresses are compared lower-case; every other encoding exactly as decoded. */
export function canonicalAddress(ref: AddressRef): AddressRef {
  return chainFamily(ref.chain) === 'evm' ? { chain: ref.chain, address: ref.address.toLowerCase() } : ref;
}

/** True when a label on `labelChain` answers a query on `queryChain` (`evm:unknown` matches any EVM chain). */
export function chainMatches(queryChain: string, labelChain: string): boolean {
  if (queryChain === labelChain) return true;
  return (
    (queryChain === 'evm:unknown' && labelChain.startsWith('evm:')) ||
    (labelChain === 'evm:unknown' && queryChain.startsWith('evm:'))
  );
}

const rank = (type: LabelSourceType | undefined): number => {
  const i = type ? LABEL_SOURCE_TYPES.indexOf(type) : -1;
  return i < 0 ? LABEL_SOURCE_TYPES.length : i;
};

/** Trust order of the dataset kind, then confidence desc, lastmod desc, id. */
export function rankLabels(labels: readonly AddressLabel[]): AddressLabel[] {
  return labels.toSorted(
    (a, b) =>
      rank(a.provenance.sourceType) - rank(b.provenance.sourceType) ||
      b.confidence - a.confidence ||
      (a.provenance.lastmod < b.provenance.lastmod ? 1 : a.provenance.lastmod > b.provenance.lastmod ? -1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function activeAt(label: AddressLabel, at: IsoDateTime): boolean {
  const date = at.slice(0, 10);
  const { activeFrom, activeTo } = label.attributes;
  return (activeFrom === undefined || activeFrom <= date) && (activeTo === undefined || date <= activeTo);
}

export class MemoryLabelLookup implements LabelLookup {
  private readonly byAddress = new Map<string, AddressLabel[]>();

  constructor(labels: readonly AddressLabel[]) {
    for (const label of labels) {
      const key = canonicalAddress(label.address).address;
      const list = this.byAddress.get(key) ?? [];
      list.push(label);
      this.byAddress.set(key, list);
    }
  }

  labelsFor(address: AddressRef, at?: IsoDateTime): Promise<AddressLabel[]> {
    const query = canonicalAddress(address);
    const found = (this.byAddress.get(query.address) ?? []).filter(
      (label) => chainMatches(query.chain, label.address.chain) && (at === undefined || activeAt(label, at)),
    );
    return Promise.resolve(rankLabels(found));
  }

  all(): AddressLabel[] {
    return [...this.byAddress.values()].flat();
  }
}
