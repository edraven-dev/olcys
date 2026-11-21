/** Chapter 5 (on-chain activity, cash-out indicators in PLN) and chapter 6 (chronological funds-flow narrative). */
import type {
  ActivityIndicators,
  AddressRef,
  CashOutEvent,
  ChainId,
  DecimalString,
  FlowEdge,
  NormalizedTransfer,
  Valuation,
} from '@olcys/core';
import { dCmp, dSum, isDecimalString, KNOWN_CHAINS } from '@olcys/core';
import { formatAmount, formatDecimal, formatLongDate, formatPln, formatUtc, plural } from '../format.ts';
import { join, markup, t, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import { cmp, normAddress, refKey, sameRef, timeOf, type View } from '../view.ts';
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

/** Optional fields of aggregated cash-out events (per-leg values), read when the analytics package provides them. */
type CashOutExtras = {
  components?: { txHash: string; at: string; amount: DecimalString; valuation?: Valuation }[];
  plnTotal?: DecimalString;
};
const extras = (e: CashOutEvent): CashOutExtras => e as CashOutEvent & CashOutExtras;

const sameAmount = (a: DecimalString, b: DecimalString): boolean =>
  isDecimalString(a) && isDecimalString(b) && dCmp(a, b) === 0;

/** Short role of an address, from the analysis results (link, exclusion, label). */
export function addressRole(view: View, ref: AddressRef): SafeHtml {
  const role = view.roleOf(ref);
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
export function describeAddress(view: View, ref: AddressRef): SafeHtml {
  return markup`${addr(ref.address)} <span class="role">(${addressRole(view, ref)})</span>`;
}

const counterpartyRef = (e: CashOutEvent): AddressRef => ({
  chain: e.address.chain,
  address: e.counterparty?.address ?? '',
});

export function counterpartyLabel(view: View, e: CashOutEvent): SafeHtml {
  const cp = e.counterparty ?? { address: '' };
  if (!cp.entity) return describeAddress(view, counterpartyRef(e));
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

/** PLN value of an event: its valuation, or the sum of its legs' values for aggregated events. */
function eventPln(e: CashOutEvent): DecimalString | undefined {
  return e.valuation?.pln ?? extras(e).plnTotal;
}

// --- distinct underlying movements --------------------------------------------------------------------------------

const legKey = (tr: NormalizedTransfer): string =>
  `${tr.chain}|${tr.txHash}|${tr.index ?? ''}|${normAddress(tr.from)}|${normAddress(tr.to)}|${tr.asset?.symbol ?? ''}`;

const edgeMatches = (edge: FlowEdge, tr: NormalizedTransfer): boolean =>
  edge.from.chain === tr.chain &&
  edge.txHash === tr.txHash &&
  sameRef(edge.from, { chain: tr.chain, address: tr.from }) &&
  sameRef(edge.to, { chain: tr.chain, address: tr.to }) &&
  edge.asset === (tr.asset?.symbol ?? '') &&
  sameAmount(edge.amount, tr.amount);

/** Valuation of a transfer from the flow edge describing exactly that movement (chain, tx, endpoints, asset, amount). */
function edgeValuation(view: View, tr: NormalizedTransfer): Valuation | undefined {
  return view.data.flows.find((edge) => edge.valuation && edgeMatches(edge, tr))?.valuation;
}

/** Outgoing transfers of the event's address in the event's transactions (to the counterparty when known). */
function eventLegs(view: View, e: CashOutEvent): NormalizedTransfer[] {
  const chain = e.address.chain;
  const to = e.counterparty?.address;
  return view.data.transfers.filter(
    (tr) =>
      tr.chain === chain &&
      (e.txHashes ?? []).includes(tr.txHash) &&
      sameRef({ chain, address: tr.from }, e.address) &&
      (!to || sameRef({ chain, address: tr.to }, { chain, address: to })),
  );
}

export interface MovementTotal {
  /** Distinct movements behind the indicators (one exit can back several rules). */
  count: number;
  priced: number;
  pln?: DecimalString;
}

/**
 * Value of the funds behind the cash-out indicators, each underlying movement counted once (chain + transaction +
 * leg), so an exit that meets several rules (e.g. B1 and B4) is not counted twice. Unpriced movements are counted.
 */
export function cashOutMovements(view: View): MovementTotal {
  const legs = new Map<string, DecimalString | undefined>();
  const put = (key: string, pln: DecimalString | undefined) => {
    if (!legs.has(key) || (legs.get(key) === undefined && pln !== undefined)) legs.set(key, pln);
  };
  for (const e of view.data.cashOuts.toSorted((a, b) => cmp(a.id, b.id))) {
    const chain = e.address.chain;
    const own = normAddress(e.address.address);
    const legsOfEvent = eventLegs(view, e);
    const components = extras(e).components ?? [];
    if (components.length) {
      for (const c of components) {
        const leg = legsOfEvent.find((tr) => tr.txHash === c.txHash && sameAmount(tr.amount, c.amount));
        put(leg ? legKey(leg) : `${chain}|${c.txHash}|${own}|${c.amount}`, c.valuation?.pln);
      }
      continue;
    }
    const value = eventPln(e);
    const valuedAmount = e.valuation?.amount;
    if (legsOfEvent.length === 1) {
      const leg = legsOfEvent[0] as NormalizedTransfer;
      const fits = valuedAmount !== undefined && sameAmount(valuedAmount, leg.amount);
      put(legKey(leg), fits ? value : edgeValuation(view, leg)?.pln);
      continue;
    }
    if (legsOfEvent.length > 1) {
      const perLeg = legsOfEvent.map((leg) => edgeValuation(view, leg)?.pln);
      const total = dSum(legsOfEvent.map((leg) => (isDecimalString(leg.amount) ? leg.amount : '0')));
      if (perLeg.every((v) => v === undefined) && valuedAmount !== undefined && sameAmount(valuedAmount, total)) {
        // The event values exactly these legs together: one movement group.
        put(legsOfEvent.map(legKey).toSorted().join('+'), value);
      } else {
        for (const [i, leg] of legsOfEvent.entries()) put(legKey(leg), perLeg[i]);
      }
      continue;
    }
    const txs = [...(e.txHashes ?? [])].toSorted().join(',');
    put(`${chain}|${txs}|${own}|${normAddress(e.counterparty?.address ?? '')}`, value);
  }
  const values = [...legs.values()].filter((v): v is DecimalString => v !== undefined && isDecimalString(v));
  return { count: legs.size, priced: values.length, ...(values.length ? { pln: dSum(values) } : {}) };
}

/** `1 520,37 zł`, a labelled partial sum, or „wartość niedostępna” — never a zero for unknown values. */
export function movementValue(total: MovementTotal): SafeHtml {
  if (total.pln === undefined) return markup`${pl.values.unavailable}`;
  if (total.priced < total.count)
    return t(pl.values.partial, {
      pln: formatPln(total.pln),
      count: plural(total.count - total.priced, pl.counts.movements),
    });
  return markup`${formatPln(total.pln)}`;
}

// --- chapter 5 ----------------------------------------------------------------------------------------------------

function roleRank(view: View, ref: AddressRef): number {
  const role = view.roleOf(ref);
  if (role.kind === 'linked') return 100 - (role.link?.score ?? 0);
  if (role.kind === 'excluded') return 200;
  return 300;
}

function cashOutsFor(view: View, ref: AddressRef, activity?: ActivityIndicators): CashOutEvent[] {
  const byId = new Map<string, CashOutEvent>();
  for (const e of view.data.cashOuts) if (sameRef(e.address, ref)) byId.set(e.id, e);
  for (const e of activity?.cashOut?.events ?? []) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].toSorted((a, b) => timeOf(a.occurredAt) - timeOf(b.occurredAt) || cmp(a.id, b.id));
}

function eventValue(e: CashOutEvent): SafeHtml | string {
  if (e.valuation) return t(pl.activity.value, { pln: valuationText(e.valuation) });
  const total = extras(e).plnTotal;
  return total ? t(pl.activity.value, { pln: formatPln(total) }) : '';
}

function cashOutLine(view: View, e: CashOutEvent): SafeHtml {
  return markup`${t(pl.activity.cashOutEvent, {
    at: formatUtc(e.occurredAt),
    rule: e.ruleId,
    name: pl.cashOutRules[e.ruleId] ?? e.ruleId,
    strength: pl.strengths[e.strength] ?? e.strength,
    amount: formatAmount(e.amount, e.asset),
    value: eventValue(e),
    counterparty: counterpartyLabel(view, e),
    hops: e.hops > 0 ? plural(e.hops, pl.counts.hops) : pl.activity.direct,
  })}${(e.txHashes ?? []).length ? markup`<br>${join(e.txHashes.map(hash), ', ')}` : ''}${technical(
    t(pl.activity.explanation, { text: e.explanation, version: e.rulesVersion }),
  )}`;
}

function transferLine(view: View, ref: AddressRef, tr: NormalizedTransfer): SafeHtml {
  const incoming = sameRef({ chain: tr.chain, address: tr.to }, ref);
  return t(incoming ? pl.activity.transferIn : pl.activity.transferOut, {
    at: formatUtc(tr.blockTime),
    amount: formatAmount(tr.amount, tr.asset?.symbol ?? ''),
    counterparty: describeAddress(view, { chain: tr.chain, address: incoming ? tr.from : tr.to }),
    tx: hash(tr.txHash),
  });
}

function volume(totals: { native: DecimalString; pln?: DecimalString } | undefined, asset: string): SafeHtml {
  if (!totals) return markup`${pl.common.none}`;
  const amount = formatAmount(totals.native, asset);
  return totals.pln ? t(pl.activity.withPln, { amount, pln: formatPln(totals.pln) }) : markup`${amount}`;
}

function chainAsset(chain: ChainId): string {
  return KNOWN_CHAINS.find((c) => c.id === chain)?.nativeAsset ?? '';
}

function activityCard(view: View, ref: AddressRef, activity: ActivityIndicators | undefined): SafeHtml {
  const role = view.roleOf(ref);
  const native = chainAsset(ref.chain);
  const transfers = view.data.transfers
    .filter(
      (tr) => sameRef({ chain: tr.chain, address: tr.from }, ref) || sameRef({ chain: tr.chain, address: tr.to }, ref),
    )
    .toSorted(
      (a, b) => timeOf(a.blockTime) - timeOf(b.blockTime) || cmp(a.txHash, b.txHash) || (a.index ?? 0) - (b.index ?? 0),
    );
  const events = cashOutsFor(view, ref, activity);
  const roleText =
    role.kind === 'linked' && role.link
      ? t(pl.activity.roleLinked, { score: role.link.score })
      : role.kind === 'excluded' && role.exclusion
        ? t(pl.activity.roleRejected, { rule: role.exclusion.ruleId })
        : markup`${pl.activity.roleOther}`;

  const facts = join([
    markup`<h4>${pl.activity.transfersTitle}</h4>`,
    transfers.length
      ? capped(transfers, MAX_TRANSFERS_PER_ADDRESS, (tr) => transferLine(view, ref, tr))
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
    events.map((e) => {
      const pln = eventPln(e);
      return t(a.cashOutInference, {
        date: formatLongDate(e.occurredAt),
        amount: formatAmount(e.amount, e.asset),
        value: pln ? `, ${formatPln(pln)}` : '',
        counterparty: counterpartyLabel(view, e),
      });
    }),
  );

  return markup`<article class="card" id="aktywnosc-${refKey(ref)}"><h3>${addr(ref.address)}</h3><p class="card-sub">${t(
    pl.links.chain,
    { chain: chainName(ref.chain) },
  )} · ${roleText}</p>${block('facts', facts)}${block('computed', computed)}${block('inferences', inferences)}</article>`;
}

export function activitySection(view: View): SafeHtml {
  const { data } = view;
  const refs = new Map<string, { ref: AddressRef; activity?: ActivityIndicators }>();
  for (const a of data.activity) refs.set(refKey(a.address), { ref: a.address, activity: a });
  for (const e of data.cashOuts) if (!refs.has(refKey(e.address))) refs.set(refKey(e.address), { ref: e.address });
  const cards = [...refs.entries()]
    .toSorted(([kx, x], [ky, y]) => roleRank(view, x.ref) - roleRank(view, y.ref) || cmp(kx, ky))
    .map(([, entry]) => activityCard(view, entry.ref, entry.activity));
  return section(
    'aktywnosc',
    pl.sections.activity,
    join([para(pl.activity.intro), cards.length ? cards : para(pl.activity.none, 'empty')]),
  );
}

// --- chapter 6 ----------------------------------------------------------------------------------------------------

interface FlowStep {
  /** `transfer`: a movement in the fetched chain data (fact); `indicator`: a rule result without such a movement. */
  kind: 'transfer' | 'indicator';
  key: string;
  at: string;
  chain: ChainId;
  txHashes: string[];
  index: number;
  from: string;
  to: string;
  amount: DecimalString;
  asset: string;
  valuation?: Valuation;
  cashOuts: CashOutEvent[];
}

const stepKey = (chain: string, txHash: string, index: number | undefined, from: string, to: string) =>
  `${chain}|${txHash}|${index ?? ''}|${normAddress(from)}|${normAddress(to)}`;

const sameEndpoints = (s: FlowStep, edge: FlowEdge): boolean =>
  s.kind === 'transfer' &&
  s.chain === edge.from.chain &&
  s.txHashes[0] === edge.txHash &&
  sameRef({ chain: s.chain, address: s.from }, edge.from) &&
  sameRef({ chain: s.chain, address: s.to }, edge.to);

/**
 * Steps from transfers, enriched with flow-edge valuations (only for exactly the same movement) and cash-out events
 * (matched by chain and transaction). An event without a matching transfer becomes an `indicator`, never a transfer.
 */
export function flowSteps(view: View): FlowStep[] {
  const { data } = view;
  const steps = new Map<string, FlowStep>();
  for (const tr of data.transfers) {
    const key = stepKey(tr.chain, tr.txHash, tr.index, tr.from, tr.to);
    if (steps.has(key)) continue;
    steps.set(key, {
      kind: 'transfer',
      key,
      at: tr.blockTime,
      chain: tr.chain,
      txHashes: [tr.txHash],
      index: tr.index ?? 0,
      from: tr.from,
      to: tr.to,
      amount: tr.amount,
      asset: tr.asset?.symbol ?? '',
      cashOuts: [],
    });
  }
  for (const edge of data.flows) {
    const sameMovement = [...steps.values()].filter((s) => sameEndpoints(s, edge));
    const exact = sameMovement.find((s) => s.asset === edge.asset && sameAmount(s.amount, edge.amount));
    if (exact) {
      if (!exact.valuation && edge.valuation) exact.valuation = edge.valuation;
      continue;
    }
    // Same transaction and endpoints but another asset or amount: ambiguous, neither valued nor duplicated.
    if (sameMovement.length) continue;
    const key = stepKey(edge.from.chain, edge.txHash, undefined, edge.from.address, edge.to.address);
    if (!steps.has(key))
      steps.set(key, {
        kind: 'transfer',
        key,
        at: edge.at,
        chain: edge.from.chain,
        txHashes: [edge.txHash],
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
    const matches = [...steps.values()].filter(
      (s) =>
        s.kind === 'transfer' &&
        s.chain === event.address.chain &&
        (event.txHashes ?? []).includes(s.txHashes[0] ?? '') &&
        (sameRef({ chain: s.chain, address: s.from }, event.address) ||
          sameRef({ chain: s.chain, address: s.to }, event.address)),
    );
    if (matches.length) {
      for (const s of matches) s.cashOuts.push(event);
      continue;
    }
    const key = `indicator|${event.id}`;
    steps.set(key, {
      kind: 'indicator',
      key,
      at: event.occurredAt,
      chain: event.address.chain,
      txHashes: [...(event.txHashes ?? [])],
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
    (a, b) =>
      timeOf(a.at) - timeOf(b.at) ||
      cmp(a.txHashes[0] ?? '', b.txHashes[0] ?? '') ||
      a.index - b.index ||
      cmp(a.key, b.key),
  );
}

/** An event's valuation describes a transfer only when it values exactly that amount of the same asset. */
function fitsStep(s: FlowStep, v: Valuation): boolean {
  return v.asset === s.asset && sameAmount(v.amount, s.amount);
}

function ruleLines(s: FlowStep): SafeHtml {
  return join(
    s.cashOuts.map((e) =>
      join([
        ' ',
        t(pl.flow.rule, {
          rule: e.ruleId,
          name: pl.cashOutRules[e.ruleId] ?? e.ruleId,
          strength: pl.strengths[e.strength] ?? e.strength,
        }),
      ]),
    ),
  );
}

function flowItem(view: View, s: FlowStep): SafeHtml {
  const f = pl.flow;
  const from = describeAddress(view, { chain: s.chain, address: s.from });
  const to = describeAddress(view, { chain: s.chain, address: s.to });
  const inference = s.cashOuts.length
    ? t(f.inference, { counterparty: counterpartyLabel(view, s.cashOuts[0] as CashOutEvent) })
    : '';
  const time = markup`<p class="flow-time"><time datetime="${s.at}">${formatLongDate(s.at)}</time></p>`;
  if (s.kind === 'indicator') {
    const e = s.cashOuts[0] as CashOutEvent;
    const pln = eventPln(e);
    const computed = join([
      t(f.indicator, {
        amount: formatAmount(s.amount, s.asset),
        from,
        to,
        txs: s.txHashes.length ? join(s.txHashes.map(hash), ', ') : pl.common.none,
        chain: chainName(s.chain),
      }),
      ' ',
      e.valuation
        ? t(f.valuation, { value: valuationText(e.valuation) })
        : pln
          ? t(f.valuation, { value: formatPln(pln) })
          : f.noValuation,
      ruleLines(s),
    ]);
    return markup`<li class="flow-step flow-indicator">${time}${statement('computed', computed)}${statement('inferences', inference)}</li>`;
  }
  const value =
    s.valuation ?? s.cashOuts.map((e) => e.valuation).find((v): v is Valuation => v !== undefined && fitsStep(s, v));
  const fact = join([
    t(f.step, { amount: formatAmount(s.amount, s.asset), from, to }),
    ' ',
    t(f.tx, { tx: hash(s.txHashes[0] ?? ''), chain: chainName(s.chain) }),
  ]);
  const computed = join([value ? t(f.valuation, { value: valuationText(value) }) : f.noValuation, ruleLines(s)]);
  return markup`<li class="flow-step">${time}${statement('facts', fact)}${statement('computed', computed)}${statement('inferences', inference)}</li>`;
}

export function flowSection(view: View): SafeHtml {
  const steps = flowSteps(view);
  if (!steps.length)
    return section('przeplywy', pl.sections.flow, join([para(pl.flow.intro), para(pl.flow.none, 'empty')]));
  const transfers = steps.filter((s) => s.kind === 'transfer');
  const addresses = new Set<string>();
  for (const s of transfers) {
    addresses.add(refKey({ chain: s.chain, address: s.from }));
    addresses.add(refKey({ chain: s.chain, address: s.to }));
  }
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
              flows: plural(transfers.length, pl.counts.flows),
              addresses: plural(addresses.size, pl.counts.addressesGen),
            }),
          ),
          view.data.cashOuts.length
            ? para(t(pl.flow.cashOutTotal, { value: movementValue(cashOutMovements(view)) }))
            : '',
        ]),
      ),
      markup`<ol class="flow">${shown.map((s) => flowItem(view, s))}</ol>`,
      steps.length > MAX_FLOW_STEPS
        ? para(muted(t(pl.common.truncated, { shown: MAX_FLOW_STEPS, total: steps.length })))
        : '',
    ]),
  );
}
