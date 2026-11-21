/** Chapter 5 (on-chain activity, cash-out indicators in PLN) and chapter 6 (chronological funds-flow narrative). */
import type {
  ActivityIndicators,
  AddressRef,
  CashOutEvent,
  ChainId,
  DecimalString,
  NormalizedTransfer,
  Valuation,
} from '@olcys/core';
import { dCmp, dSum, isDecimalString, KNOWN_CHAINS } from '@olcys/core';
import { formatAmount, formatDecimal, formatLongDate, formatPln, formatUtc, plural } from '../format.ts';
import { join, markup, t, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import { cmp, normAddress, timeOf, type View } from '../view.ts';
import {
  addr,
  block,
  capped,
  chainName,
  hash,
  kv,
  list,
  muted,
  para,
  section,
  statement,
  table,
  technical,
} from './blocks.ts';

const MAX_TRANSFERS_PER_ADDRESS = 40;
const MAX_FLOW_STEPS = 200;

/** Short role of an address, from the analysis results (link, exclusion, label). */
export function addressRole(view: View, address: string): SafeHtml {
  const role = view.roleOf(address);
  const f = pl.flow;
  const labelled = (category: string, entity: string) =>
    t(f.addrLabelled, { category: pl.categories[category as keyof typeof pl.categories] ?? category, entity });
  if (role.kind === 'linked' && role.link)
    return t(f.addrLinked, { identity: view.identityLabel(role.link.identityId), score: role.link.score });
  if (role.kind === 'excluded' && role.exclusion) {
    if (role.label) return markup`${labelled(role.label.category, role.label.entity)}, ${role.exclusion.ruleId}`;
    const rule = pl.exclusionRules[role.exclusion.ruleId] ?? role.exclusion.ruleId;
    return t(f.addrExcluded, { rule: rule.charAt(0).toLowerCase() + rule.slice(1), id: role.exclusion.ruleId });
  }
  if (role.kind === 'third_party') return markup`${f.addrThirdParty}`;
  if (role.kind === 'labelled' && role.label) return labelled(role.label.category, role.label.entity);
  return markup`${f.addrUnknown}`;
}

/** Address in monospace followed by its role, e.g. `0x… (giełda „Giełda Testowa”, A1)`. */
export function describeAddress(view: View, address: string): SafeHtml {
  return markup`${addr(address)} <span class="role">(${addressRole(view, address)})</span>`;
}

export function counterpartyLabel(view: View, e: CashOutEvent): SafeHtml {
  const cp = e.counterparty ?? { address: '' };
  if (!cp.entity) return describeAddress(view, cp.address);
  const category = cp.category ? (pl.categories[cp.category] ?? cp.category) : pl.categories.unknown_service;
  return markup`${addr(cp.address)} <span class="role">(${t(pl.flow.addrLabelled, { category, entity: cp.entity })})</span>`;
}

export function valuationText(v: Valuation | undefined): SafeHtml {
  if (!v) return markup`${pl.activity.noValuation}`;
  const nbp = v.nbp
    ? t(pl.activity.nbp, {
        table: v.nbp.table,
        date: v.nbp.effectiveDate,
        currency: v.nbp.currency,
        rate: formatDecimal(v.nbp.rate),
      })
    : '';
  const price = v.price
    ? t(pl.activity.price, {
        pair: v.price.pair,
        close: formatDecimal(v.price.close),
        source: v.price.source,
        candle: formatUtc(v.price.candleTime),
      })
    : '';
  return markup`<strong>${formatPln(v.pln)}</strong> (${join([nbp, price].filter(Boolean), '; ')})`;
}

function roleRank(view: View, address: string): number {
  const role = view.roleOf(address);
  if (role.kind === 'linked') return 100 - (role.link?.score ?? 0);
  if (role.kind === 'excluded') return 200;
  return 300;
}

function cashOutsFor(view: View, address: string, activity?: ActivityIndicators): CashOutEvent[] {
  const key = normAddress(address);
  const byId = new Map<string, CashOutEvent>();
  for (const e of view.data.cashOuts) if (normAddress(e.address.address) === key) byId.set(e.id, e);
  for (const e of activity?.cashOut?.events ?? []) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].toSorted((a, b) => timeOf(a.occurredAt) - timeOf(b.occurredAt) || cmp(a.id, b.id));
}

function cashOutLine(view: View, e: CashOutEvent): SafeHtml {
  return markup`${t(pl.activity.cashOutEvent, {
    at: formatUtc(e.occurredAt),
    rule: e.ruleId,
    name: pl.cashOutRules[e.ruleId] ?? e.ruleId,
    strength: pl.strengths[e.strength] ?? e.strength,
    amount: formatAmount(e.amount, e.asset),
    value: e.valuation ? t(pl.activity.value, { pln: valuationText(e.valuation) }) : '',
    counterparty: counterpartyLabel(view, e),
    hops: e.hops > 0 ? plural(e.hops, pl.counts.hops) : pl.activity.direct,
  })}${(e.txHashes ?? []).length ? markup`<br>${join(e.txHashes.map(hash), ', ')}` : ''}${technical(
    t(pl.activity.explanation, { text: e.explanation, version: e.rulesVersion }),
  )}`;
}

function transferLine(view: View, address: string, tr: NormalizedTransfer): SafeHtml {
  const incoming = normAddress(tr.to) === normAddress(address);
  return t(incoming ? pl.activity.transferIn : pl.activity.transferOut, {
    at: formatUtc(tr.blockTime),
    amount: formatAmount(tr.amount, tr.asset?.symbol ?? ''),
    counterparty: describeAddress(view, incoming ? tr.from : tr.to),
    tx: hash(tr.txHash),
  });
}

function volume(totals: { native: DecimalString; pln?: DecimalString } | undefined, asset: string): SafeHtml {
  if (!totals) return markup`${pl.common.none}`;
  const amount = formatAmount(totals.native, asset);
  return totals.pln ? t(pl.activity.withPln, { amount, pln: formatPln(totals.pln) }) : markup`${amount}`;
}

function activityCard(view: View, ref: AddressRef, activity: ActivityIndicators | undefined): SafeHtml {
  const address = ref.address;
  const role = view.roleOf(address);
  const native = chainAsset(ref.chain);
  const key = normAddress(address);
  const transfers = view.data.transfers
    .filter((tr) => normAddress(tr.from) === key || normAddress(tr.to) === key)
    .toSorted(
      (a, b) => timeOf(a.blockTime) - timeOf(b.blockTime) || cmp(a.txHash, b.txHash) || (a.index ?? 0) - (b.index ?? 0),
    );
  const events = cashOutsFor(view, address, activity);
  const roleText =
    role.kind === 'linked' && role.link
      ? t(pl.activity.roleLinked, { score: role.link.score })
      : role.kind === 'excluded' && role.exclusion
        ? t(pl.activity.roleRejected, { rule: role.exclusion.ruleId })
        : markup`${pl.activity.roleOther}`;

  const facts = join([
    markup`<h4>${pl.activity.transfersTitle}</h4>`,
    transfers.length
      ? capped(transfers, MAX_TRANSFERS_PER_ADDRESS, (tr) => transferLine(view, address, tr))
      : para(pl.activity.noTransfers),
  ]);

  const a = pl.activity;
  const services = activity?.serviceInteractions ?? [];
  const swaps = activity?.swaps ?? [];
  const window = activity?.window;
  const computed = join([
    activity
      ? kv([
          [
            a.labels.window,
            window?.from || window?.to
              ? t(a.windowRange, {
                  from: window.from ? formatUtc(window.from) : '…',
                  to: window.to ? formatUtc(window.to) : '…',
                })
              : a.windowAll,
          ],
          [a.labels.txCount, String(activity.txCount)],
          [a.labels.volumeIn, volume(activity.volumeIn, native)],
          [a.labels.volumeOut, volume(activity.volumeOut, native)],
          [a.labels.counterparties, String(activity.counterpartyCount)],
          ...(activity.stablecoinConversionPln
            ? [[a.labels.stablecoin, formatPln(activity.stablecoinConversionPln)] as const]
            : []),
          [a.labels.cashOutScore, t(a.score, { score: activity.cashOut?.score ?? 0 })],
        ])
      : '',
    services.length
      ? markup`<h4>${a.servicesTitle}</h4>${table(
          [
            a.servicesColumns.category,
            a.servicesColumns.entity,
            a.servicesColumns.direction,
            a.servicesColumns.count,
            a.servicesColumns.pln,
          ],
          services
            .toSorted((x, y) => cmp(x.entity, y.entity) || cmp(x.direction, y.direction))
            .map((s) => [
              pl.categories[s.category] ?? s.category,
              s.entity,
              a.direction[s.direction] ?? s.direction,
              String(s.count),
              s.pln ? formatPln(s.pln) : '—',
            ]),
        )}`
      : '',
    swaps.length
      ? markup`<h4>${a.swapsTitle}</h4>${list(
          swaps
            .toSorted((x, y) => timeOf(x.at) - timeOf(y.at) || cmp(x.txHash, y.txHash))
            .map((s) =>
              t(a.swap, {
                at: formatUtc(s.at),
                sold: formatAmount(s.sold.amount, s.sold.asset),
                bought: formatAmount(s.bought.amount, s.bought.asset),
                venue: s.venue ? t(a.swapVenue, { venue: s.venue }) : '',
                stable: s.intoStablecoin ? a.swapStable : '',
              }),
            ),
        )}`
      : '',
    markup`<h4>${a.cashOutTitle}</h4>`,
    events.length ? list(events.map((e) => cashOutLine(view, e))) : para(a.cashOutNone),
  ]);

  const inferences = list(
    events.map((e) =>
      t(a.cashOutInference, {
        date: formatLongDate(e.occurredAt),
        amount: formatAmount(e.amount, e.asset),
        value: e.valuation ? `, ${formatPln(e.valuation.pln)}` : '',
        counterparty: counterpartyLabel(view, e),
      }),
    ),
  );

  return markup`<article class="card" id="aktywnosc-${key}"><h3>${addr(address)}</h3><p class="card-sub">${t(
    pl.links.chain,
    {
      chain: chainName(ref.chain),
    },
  )} · ${roleText}</p>${block('facts', facts)}${block('computed', computed)}${block('inferences', inferences)}</article>`;
}

function chainAsset(chain: ChainId): string {
  return KNOWN_CHAINS.find((c) => c.id === chain)?.nativeAsset ?? '';
}

export function activitySection(view: View): SafeHtml {
  const { data } = view;
  const refs = new Map<string, { ref: AddressRef; activity?: ActivityIndicators }>();
  for (const a of data.activity) refs.set(normAddress(a.address.address), { ref: a.address, activity: a });
  for (const e of data.cashOuts) {
    const key = normAddress(e.address.address);
    if (!refs.has(key)) refs.set(key, { ref: e.address });
  }
  const cards = [...refs.values()]
    .toSorted(
      (x, y) => roleRank(view, x.ref.address) - roleRank(view, y.ref.address) || cmp(x.ref.address, y.ref.address),
    )
    .map((entry) => activityCard(view, entry.ref, entry.activity));
  return section(
    'aktywnosc',
    pl.sections.activity,
    join([para(pl.activity.intro), cards.length ? cards : para(pl.activity.none, 'empty')]),
  );
}

interface FlowStep {
  key: string;
  at: string;
  chain: ChainId;
  txHash: string;
  index: number;
  from: string;
  to: string;
  amount: DecimalString;
  asset: string;
  valuation?: Valuation;
  cashOuts: CashOutEvent[];
}

const keyOf = (txHash: string, index: number | undefined, from: string, to: string) =>
  `${txHash}#${index ?? ''}#${normAddress(from)}#${normAddress(to)}`;
const sameTx = (s: FlowStep, txHash: string, from: string, to: string) =>
  s.txHash === txHash && normAddress(s.from) === normAddress(from) && normAddress(s.to) === normAddress(to);

/** Steps from transfers, enriched with flow-edge valuations and cash-out events (matched by transaction). */
export function flowSteps(view: View): FlowStep[] {
  const { data } = view;
  const steps = new Map<string, FlowStep>();
  for (const tr of data.transfers) {
    const key = keyOf(tr.txHash, tr.index, tr.from, tr.to);
    if (steps.has(key)) continue;
    steps.set(key, {
      key,
      at: tr.blockTime,
      chain: tr.chain,
      txHash: tr.txHash,
      index: tr.index ?? 0,
      from: tr.from,
      to: tr.to,
      amount: tr.amount,
      asset: tr.asset?.symbol ?? '',
      cashOuts: [],
    });
  }
  for (const edge of data.flows) {
    const match = [...steps.values()].find((s) => sameTx(s, edge.txHash, edge.from.address, edge.to.address));
    if (match) {
      if (!match.valuation && edge.valuation) match.valuation = edge.valuation;
      continue;
    }
    const key = keyOf(edge.txHash, undefined, edge.from.address, edge.to.address);
    if (!steps.has(key))
      steps.set(key, {
        key,
        at: edge.at,
        chain: edge.from.chain,
        txHash: edge.txHash,
        index: 0,
        from: edge.from.address,
        to: edge.to.address,
        amount: edge.amount,
        asset: edge.asset,
        ...(edge.valuation ? { valuation: edge.valuation } : {}),
        cashOuts: [],
      });
  }
  for (const event of data.cashOuts) {
    const own = normAddress(event.address.address);
    const matches = [...steps.values()].filter(
      (s) => (event.txHashes ?? []).includes(s.txHash) && (normAddress(s.from) === own || normAddress(s.to) === own),
    );
    if (matches.length) {
      for (const s of matches) s.cashOuts.push(event);
      continue;
    }
    const txHash = event.txHashes?.[0] ?? '';
    const key = keyOf(txHash, undefined, event.address.address, event.counterparty?.address ?? '');
    steps.set(key, {
      key,
      at: event.occurredAt,
      chain: event.address.chain,
      txHash,
      index: 0,
      from: event.address.address,
      to: event.counterparty?.address ?? '',
      amount: event.amount,
      asset: event.asset,
      ...(event.valuation ? { valuation: event.valuation } : {}),
      cashOuts: [event],
    });
  }
  return [...steps.values()].toSorted(
    (a, b) => timeOf(a.at) - timeOf(b.at) || cmp(a.txHash, b.txHash) || a.index - b.index || cmp(a.key, b.key),
  );
}

/** An event's valuation describes this step only when it values exactly the step's amount of the same asset. */
function sameAmount(s: FlowStep, v: Valuation): boolean {
  return (
    v.asset === s.asset && isDecimalString(v.amount) && isDecimalString(s.amount) && dCmp(v.amount, s.amount) === 0
  );
}

function flowItem(view: View, s: FlowStep): SafeHtml {
  const f = pl.flow;
  const value =
    s.valuation ?? s.cashOuts.map((e) => e.valuation).find((v): v is Valuation => v !== undefined && sameAmount(s, v));
  const fact = join([
    t(f.step, {
      amount: formatAmount(s.amount, s.asset),
      from: describeAddress(view, s.from),
      to: describeAddress(view, s.to),
    }),
    ' ',
    s.txHash ? t(f.tx, { tx: hash(s.txHash), chain: chainName(s.chain) }) : '',
  ]);
  const computed = join([
    value ? t(f.valuation, { value: valuationText(value) }) : f.noValuation,
    s.cashOuts.map((e) =>
      join([
        ' ',
        t(f.rule, {
          rule: e.ruleId,
          name: pl.cashOutRules[e.ruleId] ?? e.ruleId,
          strength: pl.strengths[e.strength] ?? e.strength,
        }),
      ]),
    ),
  ]);
  const inference = s.cashOuts.length
    ? t(f.inference, { counterparty: counterpartyLabel(view, s.cashOuts[0] as CashOutEvent) })
    : '';
  return markup`<li class="flow-step"><p class="flow-time"><time datetime="${s.at}">${formatLongDate(s.at)}</time></p>${statement('facts', fact)}${statement('computed', computed)}${statement('inferences', inference)}</li>`;
}

export function flowSection(view: View): SafeHtml {
  const steps = flowSteps(view);
  if (!steps.length)
    return section('przeplywy', pl.sections.flow, join([para(pl.flow.intro), para(pl.flow.none, 'empty')]));
  const addresses = new Set(steps.flatMap((s) => [normAddress(s.from), normAddress(s.to)]).filter(Boolean));
  const cashOutValues = view.data.cashOuts
    .map((e) => e.valuation?.pln)
    .filter((v): v is string => !!v && isDecimalString(v));
  const first = steps[0] as FlowStep;
  const last = steps[steps.length - 1] as FlowStep;
  const shown = steps.slice(0, MAX_FLOW_STEPS);
  return section(
    'przeplywy',
    pl.sections.flow,
    join([
      para(pl.flow.intro),
      block(
        'computed',
        join([
          para(
            t(pl.flow.overview, {
              from: formatLongDate(first.at),
              to: formatLongDate(last.at),
              flows: plural(steps.length, pl.counts.flows),
              addresses: plural(addresses.size, pl.counts.addressesGen),
            }),
          ),
          cashOutValues.length ? para(t(pl.flow.cashOutTotal, { pln: formatPln(dSum(cashOutValues)) })) : '',
        ]),
      ),
      markup`<ol class="flow">${shown.map((s) => flowItem(view, s))}</ol>`,
      steps.length > MAX_FLOW_STEPS
        ? para(muted(t(pl.common.truncated, { shown: MAX_FLOW_STEPS, total: steps.length })))
        : '',
    ]),
  );
}
