/**
 * Activity indicators of an analysed address: transaction count, inflow/outflow per asset and in PLN (each leg at
 * its own NBP rate), distinct counterparties, interactions with labelled services and DEX swaps. Indicators are
 * computed results about an address, never statements about a person.
 */
import type {
  ActivityIndicators,
  AddressRef,
  ChainId,
  ChainTip,
  DecimalString,
  EntityCategory,
  ExclusionDecision,
  ForwardingLeg,
  Id,
  IsoDateTime,
  LabelLookup,
  NormalizedTransfer,
  RunContext,
  SwapEvent,
  UtxoTransaction,
  Valuation,
  VolumeTotals,
} from '@olcys/core';
import {
  addressKey,
  chainFamily,
  dAdd,
  dCmp,
  dRound,
  dSub,
  findForwardingPairs,
  forwardingParamsFor,
} from '@olcys/core';
import { assetKey, type AssetRegistry, type Valuator } from './valuation.ts';

export const ACTIVITY_RULES_VERSION = 'activity.v1';

export interface AnalyticsDeps {
  /** Returns labels ranked best first (trust order, confidence). */
  labels: LabelLookup;
  valuator: Valuator;
  assets: AssetRegistry;
  /** A4 parameters of `exclusion.v1.yaml`, reused to recognise exchange deposit addresses among counterparties. */
  forwarding: { tauBlocks: number; alpha: DecimalString };
}

export interface AddressAnalysisInput {
  /** The analysed address on its concrete chain (an `evm:unknown` candidate resolved by the chain fetch). */
  address: AddressRef;
  /**
   * The candidate as extracted, when it differs from `address` (an `evm:unknown` candidate that the chain fetch
   * resolved): its own exclusion decisions then apply to `address`. Decisions never cross chains otherwise.
   */
  requested?: AddressRef;
  /** Fetched transfers; only legs of `address` are used. Bitcoin: the derived transfer view. */
  transfers: readonly NormalizedTransfer[];
  /** Bitcoin: the UTXO transactions (volumes are net per transaction). */
  utxoTxs?: readonly UtxoTransaction[];
  tip?: ChainTip;
  /** Every exclusion decision of the run: A4 marks exchange deposit addresses. */
  decisions: readonly ExclusionDecision[];
  /** Transfers of fetched counterparties (one-hop expansion), keyed by `addressKey`. */
  counterpartyTransfers?: ReadonlyMap<string, readonly NormalizedTransfer[]>;
  /** Address keys of every analysed address of the run. */
  analysed?: ReadonlySet<string>;
}

/** The service on the other side of a leg. */
export interface Counterparty {
  address: string;
  entity: string;
  category: EntityCategory;
  labelId?: Id;
  fiatCapable?: boolean;
  /** `label`: a label on the address; `deposit_*`: an exchange deposit address (A4 decision or forwarding seen). */
  via: 'label' | 'deposit_decision' | 'deposit_forwarding';
  decisionId?: Id;
  /** Deposit addresses: matched receive → sweep pairs, each with the exchange its sweep reached. */
  sweeps?: {
    receiveTx: string;
    forwardTx: string;
    forwardTo: string;
    kappa: number;
    entity?: string;
    category?: EntityCategory;
    labelId?: Id;
    /** Identity of the matched incoming transfer (asset key, kind, index). */
    assetKey?: string;
    receiveKind?: NormalizedTransfer['kind'];
    receiveIndex?: number;
  }[];
}

export const sameAddress = (chain: ChainId, a: string, b: string): boolean =>
  chainFamily(chain) === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Resolves counterparties: label first, then A4 decisions of the run, then forwarding seen in fetched data. */
export function createCounterpartyResolver(deps: AnalyticsDeps, input: AddressAnalysisInput) {
  const deposits = new Map<string, Promise<Counterparty | undefined>>();

  async function forwardingOf(chain: ChainId, address: string): Promise<Counterparty | undefined> {
    const transfers = (input.counterpartyTransfers?.get(addressKey({ chain, address })) ?? []).filter(
      (t) => t.chain === chain,
    );
    const key = (t: NormalizedTransfer) => assetKey(t.asset, deps.assets);
    const leg = (t: NormalizedTransfer): ForwardingLeg => ({ ...t, assetKey: key(t) });
    const receives: ForwardingLeg[] = [];
    const sources = new Map<ForwardingLeg, NormalizedTransfer>();
    const forwards: {
      leg: ForwardingLeg;
      transfer: NormalizedTransfer;
      label: { id: Id; entity: string; category: EntityCategory; fiatCapable?: boolean };
    }[] = [];
    for (const t of transfers) {
      if (sameAddress(chain, t.to, address) && !sameAddress(chain, t.from, address)) {
        const l = leg(t);
        receives.push(l);
        sources.set(l, t);
      }
      if (!sameAddress(chain, t.from, address) || sameAddress(chain, t.to, address)) continue;
      // oxlint-disable-next-line no-await-in-loop
      const top = (await deps.labels.labelsFor({ chain, address: t.to }, t.blockTime))[0];
      if (top?.category === 'exchange' && top.provenance.deciding === true) {
        forwards.push({
          leg: leg(t),
          transfer: t,
          label: {
            id: top.id,
            entity: top.entity,
            category: top.category,
            ...(top.attributes.fiatCapable !== undefined ? { fiatCapable: top.attributes.fiatCapable } : {}),
          },
        });
      }
    }
    if (forwards.length === 0) return undefined;
    const pairs = findForwardingPairs(
      receives,
      forwards.map((f) => f.leg),
      forwardingParamsFor(chain, deps.forwarding),
    );
    const first = pairs[0];
    const target = first && forwards.find((f) => f.leg === first.forward);
    if (!first || !target) return undefined;
    return {
      address,
      entity: target.label.entity,
      category: target.label.category,
      labelId: target.label.id,
      ...(target.label.fiatCapable !== undefined ? { fiatCapable: target.label.fiatCapable } : {}),
      via: 'deposit_forwarding',
      sweeps: pairs.map((p) => {
        const reached = forwards.find((f) => f.leg === p.forward);
        const received = sources.get(p.receive);
        const sweep: NonNullable<Counterparty['sweeps']>[number] = {
          receiveTx: p.receive.txHash,
          forwardTx: p.forward.txHash,
          forwardTo: reached?.transfer.to ?? '',
          kappa: p.kappa,
        };
        if (received) {
          sweep.assetKey = received.asset.contract ?? received.asset.symbol;
          sweep.receiveKind = received.kind;
          if (received.index !== undefined) sweep.receiveIndex = received.index;
        }
        if (reached) {
          sweep.entity = reached.label.entity;
          sweep.category = reached.label.category;
          sweep.labelId = reached.label.id;
        }
        return sweep;
      }),
    };
  }

  function depositOf(chain: ChainId, address: string): Promise<Counterparty | undefined> {
    const cacheKey = `${chain}|${address}`;
    let found = deposits.get(cacheKey);
    if (!found) {
      const decision = input.decisions.find(
        (d) =>
          d.ruleId === 'A4' &&
          d.evidence.forwardsTo !== undefined &&
          d.address.chain === chain &&
          sameAddress(chain, d.address.address, address),
      );
      const forwardsTo = decision?.evidence.forwardsTo;
      found =
        decision && forwardsTo
          ? Promise.resolve<Counterparty>({
              address,
              entity: forwardsTo.entity,
              category: forwardsTo.category,
              labelId: forwardsTo.labelId,
              via: 'deposit_decision',
              decisionId: decision.id,
              sweeps: (decision.evidence.pairs ?? []).map((p) => {
                const reached = p.forwardsTo ?? forwardsTo;
                const sweep: NonNullable<Counterparty['sweeps']>[number] = {
                  receiveTx: p.receiveTx,
                  forwardTx: p.forwardTx,
                  forwardTo: reached.address,
                  kappa: p.kappa,
                  entity: reached.entity,
                  category: reached.category,
                  labelId: reached.labelId,
                };
                if (p.assetKey !== undefined) sweep.assetKey = p.assetKey;
                if (p.receiveKind !== undefined) sweep.receiveKind = p.receiveKind;
                if (p.receiveIndex !== undefined) sweep.receiveIndex = p.receiveIndex;
                return sweep;
              }),
            })
          : forwardingOf(chain, address);
      deposits.set(cacheKey, found);
    }
    return found;
  }

  return {
    async resolve(chain: ChainId, address: string, at: IsoDateTime): Promise<Counterparty | undefined> {
      if (address === '' || address === 'coinbase') return undefined;
      const top = (await deps.labels.labelsFor({ chain, address }, at))[0];
      if (top) {
        return {
          address,
          entity: top.entity,
          category: top.category,
          labelId: top.id,
          ...(top.attributes.fiatCapable !== undefined ? { fiatCapable: top.attributes.fiatCapable } : {}),
          via: 'label',
        };
      }
      return depositOf(chain, address);
    },
  };
}
export type CounterpartyResolver = ReturnType<typeof createCounterpartyResolver>;

export interface Leg {
  transfer: NormalizedTransfer;
  direction: 'in' | 'out';
  counterparty: string;
  asset: string;
}

/** Legs of the address (self-transfers ignored). */
export function legsOf(input: AddressAnalysisInput, deps: Pick<AnalyticsDeps, 'assets'>): Leg[] {
  const { chain, address } = input.address;
  const legs: Leg[] = [];
  // UTXO chains: the transfer view names one sender per output (the first input), so direction comes from the
  // transaction itself: a payment is outgoing when the address spends an input of that transaction.
  const spends =
    chainFamily(chain) === 'bitcoin' && input.utxoTxs
      ? new Set(input.utxoTxs.filter((tx) => tx.inputs.some((i) => i.address === address)).map((tx) => tx.txid))
      : undefined;
  for (const t of input.transfers) {
    if (t.chain !== chain) continue; // transfers never cross chains
    if (spends) {
      const spent = spends.has(t.txHash);
      const into = t.to === address;
      if (spent !== into) {
        legs.push({
          transfer: t,
          direction: spent ? 'out' : 'in',
          counterparty: spent ? t.to : t.from,
          asset: assetKey(t.asset, deps.assets),
        });
      }
      continue;
    }
    const out = sameAddress(chain, t.from, address);
    const into = sameAddress(chain, t.to, address);
    if (out === into) continue;
    legs.push({
      transfer: t,
      direction: out ? 'out' : 'in',
      counterparty: out ? t.to : t.from,
      asset: assetKey(t.asset, deps.assets),
    });
  }
  return legs;
}

export async function valueLeg(
  leg: Leg,
  deps: Pick<AnalyticsDeps, 'valuator'>,
  ctx: RunContext,
): Promise<Valuation | undefined> {
  const result = await deps.valuator.value(
    { asset: leg.transfer.asset, amount: leg.transfer.amount, at: leg.transfer.blockTime },
    ctx,
  );
  return result.status === 'ok' ? result.valuation : undefined;
}

class VolumeBuilder {
  private native = '0';
  private pln: string | undefined;
  private unpriced = 0;
  private readonly byAsset = new Map<string, { asset: string; contract?: string; amount: string; pln?: string }>();

  add(
    asset: string,
    contract: string | undefined,
    amount: DecimalString,
    isNative: boolean,
    valuation?: Valuation,
  ): void {
    if (isNative) this.native = dAdd(this.native, amount);
    const entry = this.byAsset.get(asset) ?? { asset, ...(contract ? { contract } : {}), amount: '0' };
    entry.amount = dAdd(entry.amount, amount);
    if (valuation) {
      entry.pln = dAdd(entry.pln ?? '0', valuation.pln);
      this.pln = dAdd(this.pln ?? '0', valuation.pln);
    } else {
      this.unpriced += 1;
    }
    this.byAsset.set(asset, entry);
  }

  build(): VolumeTotals {
    return {
      native: this.native,
      ...(this.pln !== undefined ? { pln: dRound(this.pln, 2) } : {}),
      byAsset: [...this.byAsset.values()].map((e) => {
        if (e.pln !== undefined) e.pln = dRound(e.pln, 2);
        return e;
      }),
      unpriced: this.unpriced,
    };
  }
}

/** Swap-specific methods (function names as reported by explorers): enough on their own to confirm a swap. */
export const SWAP_METHODS: ReadonlySet<string> = new Set([
  'swapExactETHForTokens',
  'swapExactTokensForTokens',
  'swapExactTokensForETH',
  'swapETHForExactTokens',
  'swapTokensForExactTokens',
  'swapTokensForExactETH',
  'exactInputSingle',
  'exactInput',
  'exactOutputSingle',
  'exactOutput',
  'swap',
]);
/**
 * General-purpose batch methods (Universal Router `execute`, `multicall`): they also batch deposits and loans, so a
 * swap through them needs a DEX-labelled router or pool among the counterparties.
 */
export const GENERAL_PURPOSE_METHODS: ReadonlySet<string> = new Set(['execute', 'multicall']);

/**
 * DEX swaps: (1) the address sends asset A and receives asset B in one transaction, confirmed by a DEX-labelled
 * counterparty or a swap method; (2) proceeds received from a DEX-labelled pool or router (`dex_inflow`, the sold leg
 * is not visible, e.g. TRX paid into a TRC-20 pool).
 */
/** Net amount per asset of the address within one transaction (split payments are summed). */
function netsByAsset(txLegs: readonly Leg[]): { asset: string; leg: Leg; net: DecimalString }[] {
  const nets = new Map<string, { asset: string; leg: Leg; net: DecimalString }>();
  for (const l of txLegs) {
    const entry = nets.get(l.asset) ?? { asset: l.asset, leg: l, net: '0' };
    entry.net = l.direction === 'in' ? dAdd(entry.net, l.transfer.amount) : dSub(entry.net, l.transfer.amount);
    nets.set(l.asset, entry);
  }
  return [...nets.values()];
}

/** A leg of `amount` with the asset and time of `leg` (to value summed amounts). */
const withAmount = (leg: Leg, amount: DecimalString): Leg => ({
  transfer: Object.assign(structuredClone(leg.transfer), { amount }),
  direction: leg.direction,
  counterparty: leg.counterparty,
  asset: leg.asset,
});

interface Side {
  asset: string;
  leg: Leg;
  amount: DecimalString;
}

/** The asset side with the largest PLN value (unpriced sides last, then by amount). */
async function largest(
  sides: readonly Side[],
  deps: AnalyticsDeps,
  ctx: RunContext,
): Promise<(Side & { valuation?: Valuation }) | undefined> {
  const valued = await Promise.all(
    sides.map(async (side) => {
      const valuation = await valueLeg(withAmount(side.leg, side.amount), deps, ctx);
      return valuation ? { asset: side.asset, leg: side.leg, amount: side.amount, valuation } : side;
    }),
  );
  return valued.toSorted((a: Side & { valuation?: Valuation }, b: Side & { valuation?: Valuation }) => {
    if (a.valuation && b.valuation) return dCmp(b.valuation.pln, a.valuation.pln);
    if (a.valuation || b.valuation) return a.valuation ? -1 : 1;
    return dCmp(b.amount, a.amount);
  })[0];
}

/**
 * DEX swaps: (1) the address's net outflow of asset A and net inflow of asset B in one transaction (legs summed per
 * asset), confirmed by a DEX-labelled counterparty or a swap method; (2) proceeds received from a DEX-labelled pool or
 * router (`dex_inflow`, the sold leg is not visible, e.g. TRX paid into a TRC-20 pool), summed per transaction.
 */
export async function detectSwaps(
  input: AddressAnalysisInput,
  legs: readonly Leg[],
  resolver: CounterpartyResolver,
  deps: AnalyticsDeps,
  ctx: RunContext,
): Promise<SwapEvent[]> {
  const swaps: SwapEvent[] = [];
  const byTx = Map.groupBy(legs, (l) => l.transfer.txHash);
  const inSwapTx = new Set<string>();
  for (const [txHash, txLegs] of byTx) {
    const nets = netsByAsset(txLegs);
    const soldSides = nets
      .filter((n) => dCmp(n.net, '0') < 0)
      .map((n): Side => ({ asset: n.asset, leg: n.leg, amount: dSub('0', n.net) }));
    const boughtSides = nets
      .filter((n) => dCmp(n.net, '0') > 0)
      .map((n): Side => ({ asset: n.asset, leg: n.leg, amount: n.net }));
    if (soldSides.length === 0 || boughtSides.length === 0) continue;
    let venue: string | undefined;
    let detection: SwapEvent['detection'];
    for (const l of txLegs) {
      // oxlint-disable-next-line no-await-in-loop
      const cp = await resolver.resolve(input.address.chain, l.counterparty, l.transfer.blockTime);
      if (cp?.category === 'defi_dex') {
        venue = cp.entity;
        detection = 'dex_label';
        break;
      }
    }
    const method = txLegs.map((l) => l.transfer.method).find((m) => m !== undefined && SWAP_METHODS.has(m));
    if (!detection && method) {
      venue = method;
      detection = 'method';
    }
    if (!detection) continue;
    // oxlint-disable-next-line no-await-in-loop
    const [sold, bought] = await Promise.all([largest(soldSides, deps, ctx), largest(boughtSides, deps, ctx)]);
    if (!sold || !bought) continue;
    inSwapTx.add(txHash);
    swaps.push({
      chain: input.address.chain,
      txHash,
      at: bought.leg.transfer.blockTime,
      ...(venue ? { venue } : {}),
      sold: { asset: sold.asset, amount: sold.amount },
      bought: { asset: bought.asset, amount: bought.amount },
      intoStablecoin: deps.assets.resolve(bought.leg.transfer.asset)?.stablecoin !== undefined,
      ...(bought.valuation ? { valuation: bought.valuation } : {}),
      detection,
    });
  }
  const inflows = new Map<string, { leg: Leg; amount: DecimalString; venue: string }>();
  for (const l of legs) {
    if (l.direction !== 'in' || inSwapTx.has(l.transfer.txHash)) continue;
    // oxlint-disable-next-line no-await-in-loop
    const cp = await resolver.resolve(input.address.chain, l.counterparty, l.transfer.blockTime);
    if (cp?.category !== 'defi_dex') continue;
    const key = `${l.transfer.txHash}|${l.asset}`;
    const entry = inflows.get(key) ?? { leg: l, amount: '0', venue: cp.entity };
    entry.amount = dAdd(entry.amount, l.transfer.amount);
    inflows.set(key, entry);
  }
  for (const { leg, amount, venue } of inflows.values()) {
    // oxlint-disable-next-line no-await-in-loop
    const valuation = await valueLeg(withAmount(leg, amount), deps, ctx);
    swaps.push({
      chain: input.address.chain,
      txHash: leg.transfer.txHash,
      at: leg.transfer.blockTime,
      venue,
      sold: { asset: 'UNKNOWN', amount: '0' },
      bought: { asset: leg.asset, amount },
      intoStablecoin: deps.assets.resolve(leg.transfer.asset)?.stablecoin !== undefined,
      ...(valuation ? { valuation } : {}),
      detection: 'dex_inflow',
    });
  }
  return swaps.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Net BTC amount per transaction for an address (what `computeActivity` values on Bitcoin). */
export function utxoVolumes(
  input: AddressAnalysisInput,
): { tx: UtxoTransaction; net: DecimalString; counterparties: string[] }[] {
  const self = input.address.address;
  return (input.utxoTxs ?? []).map((tx) => {
    const received = tx.outputs.filter((o) => o.address === self).reduce((sum, o) => dAdd(sum, o.value), '0');
    const spent = tx.inputs.filter((i) => i.address === self).reduce((sum, i) => dAdd(sum, i.value), '0');
    const net = dSub(received, spent);
    const others = dCmp(net, '0') > 0 ? tx.inputs.map((i) => i.address) : tx.outputs.map((o) => o.address);
    return { tx, net, counterparties: others.filter((a): a is string => a !== undefined && a !== self) };
  });
}

export async function computeActivity(
  input: AddressAnalysisInput,
  deps: AnalyticsDeps,
  ctx: RunContext,
  resolver: CounterpartyResolver = createCounterpartyResolver(deps, input),
): Promise<ActivityIndicators> {
  const chain = input.address.chain;
  const legs = legsOf(input, deps);
  const volumeIn = new VolumeBuilder();
  const volumeOut = new VolumeBuilder();
  const counterparties = new Set<string>();
  const txIds = new Set<string>();
  const times: string[] = [];
  const valuations = new Map<Leg, Valuation | undefined>();
  for (const leg of legs) {
    // oxlint-disable-next-line no-await-in-loop
    valuations.set(leg, await valueLeg(leg, deps, ctx));
  }

  if (chainFamily(chain) === 'bitcoin') {
    for (const { tx, net, counterparties: others } of utxoVolumes(input)) {
      txIds.add(tx.txid);
      if (tx.blockTime) times.push(tx.blockTime);
      for (const other of others) counterparties.add(other);
      const positive = dCmp(net, '0') > 0;
      const amount = positive ? net : dSub('0', net);
      if (dCmp(amount, '0') === 0) continue;
      const asset = { chain, symbol: 'BTC', decimals: 8 };
      // oxlint-disable-next-line no-await-in-loop
      const value = await deps.valuator.value({ asset, amount, at: tx.blockTime ?? '' }, ctx);
      (positive ? volumeIn : volumeOut).add(
        'BTC',
        undefined,
        amount,
        true,
        value.status === 'ok' ? value.valuation : undefined,
      );
    }
  } else {
    for (const leg of legs) {
      txIds.add(leg.transfer.txHash);
      times.push(leg.transfer.blockTime);
      counterparties.add(leg.counterparty);
      if (dCmp(leg.transfer.amount, '0') === 0) continue; // zero-value calls count as transactions only
      const isNative = leg.transfer.kind !== 'token' && leg.transfer.asset.contract === undefined;
      (leg.direction === 'in' ? volumeIn : volumeOut).add(
        leg.asset,
        leg.transfer.asset.contract,
        leg.transfer.amount,
        isNative,
        valuations.get(leg),
      );
    }
  }

  const interactions = new Map<string, ActivityIndicators['serviceInteractions'][number]>();
  for (const leg of legs) {
    // oxlint-disable-next-line no-await-in-loop
    const cp = await resolver.resolve(chain, leg.counterparty, leg.transfer.blockTime);
    if (!cp) continue;
    const key = `${cp.category}|${cp.entity}|${leg.direction}`;
    const entry = interactions.get(key) ?? {
      category: cp.category,
      entity: cp.entity,
      direction: leg.direction,
      count: 0,
      priced: 0,
    };
    entry.count += 1;
    const valuation = valuations.get(leg);
    if (valuation) {
      entry.pln = dAdd(entry.pln ?? '0', valuation.pln);
      entry.priced = (entry.priced ?? 0) + 1;
    }
    interactions.set(key, entry);
  }

  const swaps = chainFamily(chain) === 'bitcoin' ? [] : await detectSwaps(input, legs, resolver, deps, ctx);
  const conversions = swaps.filter((s) => s.intoStablecoin && s.valuation).map((s) => s.valuation?.pln ?? '0');
  const sortedTimes = times.toSorted();
  const to = input.tip?.observedAt ?? sortedTimes.at(-1);
  return {
    address: input.address,
    window: { ...(sortedTimes[0] ? { from: sortedTimes[0] } : {}), ...(to ? { to } : {}) },
    txCount: txIds.size,
    volumeIn: volumeIn.build(),
    volumeOut: volumeOut.build(),
    counterpartyCount: counterparties.size,
    serviceInteractions: [...interactions.values()].map((i) => {
      if (i.pln !== undefined) i.pln = dRound(i.pln, 2);
      return i;
    }),
    swaps,
    ...(conversions.length > 0
      ? {
          stablecoinConversionPln: dRound(
            conversions.reduce((a, b) => dAdd(a, b), '0'),
            2,
          ),
        }
      : {}),
    cashOut: { events: [], score: 0 },
    computedAt: ctx.clock.now().toISOString(),
    rulesVersion: ACTIVITY_RULES_VERSION,
  };
}
