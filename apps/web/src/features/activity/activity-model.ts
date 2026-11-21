/** Pure view models for the on-chain activity tab. */
import type { ActivityIndicators, AddressRef, NormalizedTransfer, Valuation } from '@olcys/core';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { chainName } from '../../lib/chains.ts';
import { isRejectingDecision, keyOf, linkBand, type ExclusionView, type LinkView } from '../../lib/domain.ts';
import { formatDateTime, formatDecimal, middleTruncate } from '../../lib/format.ts';

/** „kurs średni NBP, tabela 226/A/NBP/2026 z dnia 2026-11-19: 1 USD = 3,6512 zł” — the NBP rate behind a PLN value. */
export function nbpLine(valuation: Pick<Valuation, 'nbp'>): string {
  const { nbp } = valuation;
  return t(pl.activity.event.nbp, {
    table: nbp.table,
    date: nbp.effectiveDate,
    currency: nbp.currency,
    rate: formatDecimal(nbp.rate),
  });
}

export function priceLine(valuation: Pick<Valuation, 'price'>): string | null {
  const { price } = valuation;
  if (!price) return null;
  return t(pl.activity.event.price, {
    pair: price.pair,
    close: formatDecimal(price.close),
    source: price.source,
    candle: formatDateTime(price.candleTime),
  });
}

export interface AddressOption {
  key: string;
  address: AddressRef;
  label: string;
}

/** Analysed addresses with their relation and score, or the rule that rejected them as holdings. */
export function addressOptions(
  indicators: readonly ActivityIndicators[],
  links: readonly LinkView[],
  exclusions: readonly ExclusionView[],
): AddressOption[] {
  const excludedKeys = new Set(exclusions.filter(isRejectingDecision).map((d) => keyOf(d.address)));
  return indicators.map((indicator) => {
    const key = keyOf(indicator.address);
    const chain = chainName(indicator.address.chain);
    const address = middleTruncate(indicator.address.address);
    const decision = exclusions.find((d) => keyOf(d.address) === key && isRejectingDecision(d));
    if (decision) {
      return {
        key,
        address: indicator.address,
        label: t(pl.activity.addressOptionRejected, { chain, address, rule: decision.ruleId }),
      };
    }
    const link = links
      .filter((l) => keyOf(l.address) === key)
      .toSorted((a, b) => b.score - a.score)
      .find((l) => linkBand(l, excludedKeys) !== 'WYKLUCZENIE');
    if (link) {
      return {
        key,
        address: indicator.address,
        label: t(pl.activity.addressOption, {
          chain,
          address,
          relation: lookup(pl.relations, link.relation) ?? link.relation,
          score: link.score,
        }),
      };
    }
    return { key, address: indicator.address, label: t(pl.activity.addressOptionPlain, { chain, address }) };
  });
}

export interface TransferRow {
  key: string;
  at: string;
  direction: 'in' | 'out' | 'self';
  counterparty: string;
  amount: string;
  asset: string;
  txHash: string;
}

const same = (chain: string, a: string, b: string) =>
  chain.startsWith('evm:') ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Transfers touching the address, oldest first (facts read from the chain data). */
export function transfersFor(address: AddressRef, transfers: readonly NormalizedTransfer[]): TransferRow[] {
  return transfers
    .filter(
      (tr) =>
        tr.chain === address.chain &&
        (same(tr.chain, tr.from, address.address) || same(tr.chain, tr.to, address.address)),
    )
    .map((tr, index) => {
      const incoming = same(tr.chain, tr.to, address.address);
      const outgoing = same(tr.chain, tr.from, address.address);
      const direction: TransferRow['direction'] = incoming && outgoing ? 'self' : incoming ? 'in' : 'out';
      return {
        key: `${tr.txHash}-${tr.index ?? index}-${tr.kind}`,
        at: tr.blockTime,
        direction,
        counterparty: direction === 'in' ? tr.from : tr.to,
        amount: tr.amount,
        asset: tr.asset.symbol,
        txHash: tr.txHash,
      };
    })
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}
