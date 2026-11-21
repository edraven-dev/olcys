/**
 * Fiat cash-out indicators of `config/rules/cashout.v1.yaml` (implemented: B1 exchange deposit, B4 stablecoin swap
 * then exit, B5 P2P round-number pattern) and the separate cash-out score of `cashout-score.v1.yaml`. Destination of
 * funds only: outgoing legs of the analysed address, except B1 from A4 (the address is itself a deposit address).
 * Indicators are inferences about addresses, never statements about a person; the fiat leg is off-chain.
 */
import type { CashOutEvent, DecimalString, Id, IndicatorStrength, RunContext, SwapEvent, Valuation } from '@olcys/core';
import { addressKey, dAdd, dCmp, dDiv, dRound, newId } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import {
  createCounterpartyResolver,
  legsOf,
  sameAddress,
  valueLeg,
  type AddressAnalysisInput,
  type AnalyticsDeps,
  type CounterpartyResolver,
  type Leg,
} from './activity.ts';

export interface CashOutRulesConfig {
  version: string;
  hopDecay: number;
  maxHops: number;
  b4: { withinDays: number; minShareOfProceeds: number };
  b5: { minRoundTransfers: number; roundUnit: number; windowDays: number };
}

function num(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`cash-out rules: ${name} must be a positive number`);
  return n;
}

const withValuation = (valuation: Valuation | undefined): { valuation?: Valuation } => (valuation ? { valuation } : {});

export function loadCashOutRules(yamlText: string): CashOutRulesConfig {
  const doc = parseYaml(yamlText) as {
    version?: string;
    hopDecay?: number;
    maxHops?: number;
    rules?: Record<string, Record<string, unknown>>;
  };
  const b4 = doc.rules?.['B4_stablecoin_swap_then_exit'];
  const b5 = doc.rules?.['B5_p2p'];
  if (typeof doc.version !== 'string' || !b4 || !b5) throw new Error('cash-out rules: missing version, B4 or B5');
  return {
    version: doc.version,
    hopDecay: num(doc.hopDecay, 'hopDecay'),
    maxHops: num(doc.maxHops, 'maxHops'),
    b4: {
      withinDays: num(b4['withinDays'], 'B4.withinDays'),
      minShareOfProceeds: num(b4['minShareOfProceeds'], 'B4.minShareOfProceeds'),
    },
    b5: {
      minRoundTransfers: num(b5['minRoundTransfers'], 'B5.minRoundTransfers'),
      roundUnit: num(b5['roundUnit'], 'B5.roundUnit'),
      windowDays: num(b5['windowDays'], 'B5.windowDays'),
    },
  };
}

export interface CashOutDeps extends AnalyticsDeps {
  rules: CashOutRulesConfig;
  runId: Id;
}

const DAY_MS = 86_400_000;

function isRound(amount: DecimalString, unit: number): boolean {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match || (match[2] !== undefined && /[^0]/.test(match[2]))) return false;
  const whole = BigInt(match[1] ?? '0');
  return whole >= BigInt(unit) && whole % BigInt(unit) === 0n;
}

export async function evaluateCashOut(
  input: AddressAnalysisInput & { swaps: readonly SwapEvent[] },
  deps: CashOutDeps,
  ctx: RunContext,
  resolver: CounterpartyResolver = createCounterpartyResolver(deps, input),
): Promise<CashOutEvent[]> {
  const { chain, address } = input.address;
  const legs = legsOf(input, deps);
  const events: CashOutEvent[] = [];
  const event = (fields: Omit<CashOutEvent, 'id' | 'runId' | 'address' | 'rulesVersion'>): CashOutEvent => ({
    id: newId(),
    runId: deps.runId,
    address: input.address,
    rulesVersion: deps.rules.version,
    ...fields,
  });

  // B1 (a): the address is an exchange deposit address (A4) — one event per matched pair, at the receive time.
  const isOwn = (ref: { chain: string; address: string }): boolean =>
    (ref.chain === chain && sameAddress(chain, ref.address, address)) ||
    (input.requested !== undefined &&
      ref.chain === input.requested.chain &&
      sameAddress(chain, ref.address, input.requested.address));
  const own = input.decisions.filter((d) => d.ruleId === 'A4' && d.emitsCashOut === 'B1' && isOwn(d.address));
  const sweeps = new Set<string>();
  for (const decision of own) {
    for (const pair of decision.evidence.pairs ?? []) {
      sweeps.add(pair.forwardTx);
      const forwardsTo = pair.forwardsTo ?? decision.evidence.forwardsTo;
      const receive = legs.find((l) => l.direction === 'in' && l.transfer.txHash === pair.receiveTx);
      if (!receive || !forwardsTo) continue;
      // oxlint-disable-next-line no-await-in-loop
      const valuation = await valueLeg(receive, deps, ctx);
      events.push(
        event({
          ruleId: 'B1',
          strength: 'strong',
          occurredAt: receive.transfer.blockTime,
          txHashes: [pair.receiveTx, pair.forwardTx],
          amount: pair.amountIn,
          asset: receive.asset,
          ...withValuation(valuation),
          counterparty: {
            address: forwardsTo.address,
            labelId: forwardsTo.labelId,
            entity: forwardsTo.entity,
            category: forwardsTo.category,
          },
          hops: 0,
          explanation: `B1: the address is an exchange deposit address (A4, kappa ${pair.kappa}): it received ${pair.amountIn} ${receive.asset} and forwarded ${pair.amountOut} to the hot wallet of ${forwardsTo.entity} (delay ${pair.delta})`,
          exclusionDecisionId: decision.id,
        }),
      );
    }
  }

  // B1 (b, c): outgoing legs to another deposit address of an exchange, or to a fiat-capable exchange.
  const outgoing = legs.filter(
    (l) => l.direction === 'out' && !sweeps.has(l.transfer.txHash) && dCmp(l.transfer.amount, '0') > 0,
  );
  const exits: { leg: Leg; event: CashOutEvent }[] = [];
  for (const leg of outgoing) {
    // oxlint-disable-next-line no-await-in-loop
    const cp = await resolver.resolve(chain, leg.counterparty, leg.transfer.blockTime);
    if (!cp || cp.category !== 'exchange') continue;
    const deposit = cp.via !== 'label';
    if (!deposit && cp.fiatCapable !== true) continue; // unknown fiat capability → no B1
    const sweep = cp.sweeps?.find((s) => s.receiveTx === leg.transfer.txHash);
    // oxlint-disable-next-line no-await-in-loop
    const valuation = await valueLeg(leg, deps, ctx);
    const e = event({
      ruleId: 'B1',
      strength: 'strong',
      occurredAt: leg.transfer.blockTime,
      txHashes: sweep ? [leg.transfer.txHash, sweep.forwardTx] : [leg.transfer.txHash],
      amount: leg.transfer.amount,
      asset: leg.asset,
      ...withValuation(valuation),
      counterparty: {
        address: cp.address,
        ...((sweep?.labelId ?? cp.labelId) ? { labelId: sweep?.labelId ?? cp.labelId } : {}),
        entity: sweep?.entity ?? cp.entity,
        category: sweep?.category ?? cp.category,
      },
      hops: 0,
      explanation: deposit
        ? `B1: transfer to ${cp.address}, an exchange deposit address forwarding to the hot wallet of ${sweep?.entity ?? cp.entity}${
            sweep ? ` (sweep ${sweep.forwardTx}, kappa ${sweep.kappa})` : ''
          }`
        : `B1: transfer to a fiat-capable exchange wallet of ${cp.entity}`,
      ...(cp.decisionId ? { exclusionDecisionId: cp.decisionId } : {}),
    });
    events.push(e);
    exits.push({ leg, event: e });
  }

  // B4: swap into a stablecoin followed within N days by exits paying ≥ X of the proceeds.
  for (const swap of input.swaps.filter((s) => s.intoStablecoin)) {
    const start = Date.parse(swap.at);
    const end = start + deps.rules.b4.withinDays * DAY_MS;
    const window = exits
      .filter((x) => x.leg.asset === swap.bought.asset)
      .filter((x) => Date.parse(x.event.occurredAt) >= start && Date.parse(x.event.occurredAt) <= end)
      .toSorted((a, b) => (a.event.occurredAt < b.event.occurredAt ? -1 : 1));
    let paid = '0';
    let reached: (typeof window)[number] | undefined;
    for (const x of window) {
      paid = dAdd(paid, x.event.amount);
      if (dCmp(dDiv(paid, swap.bought.amount, 18), String(deps.rules.b4.minShareOfProceeds)) >= 0) {
        reached = x;
        break;
      }
    }
    if (reached) {
      const used = window.slice(0, window.indexOf(reached) + 1);
      const largest = used.reduce((a, b) => (dCmp(b.event.amount, a.event.amount) > 0 ? b : a));
      const share = dRound(dDiv(paid, swap.bought.amount, 18), 4);
      events.push(
        event({
          ruleId: 'B4',
          strength: 'strong',
          occurredAt: reached.event.occurredAt,
          txHashes: [swap.txHash, ...used.map((x) => x.leg.transfer.txHash)],
          amount: paid,
          asset: swap.bought.asset,
          ...(used.length === 1 ? withValuation(used[0]?.event.valuation) : {}),
          components: used.map((x) => ({
            txHash: x.leg.transfer.txHash,
            at: x.event.occurredAt,
            amount: x.event.amount,
            ...withValuation(x.event.valuation),
          })),
          ...plnTotalOf(used.map((x) => x.event.valuation)),
          counterparty: largest.event.counterparty,
          hops: 0,
          explanation: `B4: swap into ${swap.bought.amount} ${swap.bought.asset} (${swap.venue ?? 'DEX'}) followed within ${deps.rules.b4.withinDays} days by exits of ${paid} ${swap.bought.asset} (share ${share} ≥ ${deps.rules.b4.minShareOfProceeds})`,
        }),
      );
    } else {
      events.push(
        event({
          ruleId: 'B4',
          strength: 'weak',
          occurredAt: swap.at,
          txHashes: [swap.txHash],
          amount: swap.bought.amount,
          asset: swap.bought.asset,
          ...withValuation(swap.valuation),
          counterparty: { address: '', ...(swap.venue ? { entity: swap.venue, category: 'defi_dex' as const } : {}) },
          hops: 0,
          explanation: `B4: swap into ${swap.bought.amount} ${swap.bought.asset} without a qualifying exit within ${deps.rules.b4.withinDays} days`,
        }),
      );
    }
  }

  // B5: repeated round-number stablecoin transfers to many distinct unlabelled, non-analysed recipients.
  const candidates: Leg[] = [];
  for (const leg of outgoing) {
    const info = deps.assets.resolve(leg.transfer.asset);
    if (!info?.stablecoin || !isRound(leg.transfer.amount, deps.rules.b5.roundUnit)) continue;
    if (input.analysed?.has(addressKey({ chain, address: leg.counterparty }))) continue;
    // oxlint-disable-next-line no-await-in-loop
    if (await resolver.resolve(chain, leg.counterparty, leg.transfer.blockTime)) continue;
    candidates.push(leg);
  }
  // Each asset is scanned on its own, so interleaved payments in another stablecoin cannot hide a pattern.
  for (const legsOfAsset of Map.groupBy(candidates, (l) => l.asset).values()) {
    const sorted = legsOfAsset.toSorted((a, b) => (a.transfer.blockTime < b.transfer.blockTime ? -1 : 1));
    for (let i = 0; i < sorted.length;) {
      const first = sorted[i];
      if (!first) break;
      const limit = Date.parse(first.transfer.blockTime) + deps.rules.b5.windowDays * DAY_MS;
      let end = i;
      while (end < sorted.length && Date.parse(sorted[end]?.transfer.blockTime ?? '') <= limit) end += 1;
      const group = sorted.slice(i, end);
      const recipients = new Set(group.map((l) => l.counterparty));
      if (group.length < deps.rules.b5.minRoundTransfers || recipients.size < deps.rules.b5.minRoundTransfers) {
        i += 1;
        continue;
      }
      // Windows are found one after another; the next one starts after the legs used here.
      // oxlint-disable-next-line no-await-in-loop
      const valuations = await Promise.all(group.map((l) => valueLeg(l, deps, ctx)));
      const largest = group.reduce((a, b) => (dCmp(b.transfer.amount, a.transfer.amount) > 0 ? b : a));
      const last = group.at(-1);
      events.push(
        event({
          ruleId: 'B5',
          strength: 'medium',
          occurredAt: first.transfer.blockTime,
          txHashes: group.map((l) => l.transfer.txHash),
          amount: group.reduce((sum, l) => dAdd(sum, l.transfer.amount), '0'),
          asset: first.asset,
          components: group.map((l, k) => ({
            txHash: l.transfer.txHash,
            at: l.transfer.blockTime,
            amount: l.transfer.amount,
            ...withValuation(valuations[k]),
          })),
          ...plnTotalOf(valuations),
          counterparty: { address: largest.counterparty },
          hops: 0,
          explanation: `B5: ${group.length} round-number ${first.asset} transfers (multiples of ${deps.rules.b5.roundUnit}) to ${recipients.size} distinct unlabelled addresses between ${first.transfer.blockTime} and ${last?.transfer.blockTime}: P2P sale pattern; the fiat leg is off-chain, corroboration needed`,
        }),
      );
      i = end;
    }
  }
  return events.toSorted((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
}

function plnTotalOf(valuations: readonly (Valuation | undefined)[]): { plnTotal?: DecimalString } {
  const priced = valuations.filter((v): v is Valuation => v !== undefined);
  if (priced.length === 0) return {};
  return {
    plnTotal: dRound(
      priced.reduce((sum, v) => dAdd(sum, v.pln), '0'),
      2,
    ),
  };
}

// --- score ----------------------------------------------------------------------------------------------------------

export interface CashOutScoreConfig {
  version: string;
  weights: Record<IndicatorStrength, number>;
  hopDecay: number;
}

export function loadCashOutScoreConfig(yamlText: string): CashOutScoreConfig {
  const doc = parseYaml(yamlText) as { version?: string; weights?: Record<string, number>; hopDecay?: number };
  const w = doc.weights ?? {};
  const weight = (k: IndicatorStrength): number => {
    const v = Number(w[k]);
    if (!Number.isFinite(v) || v < 0 || v >= 1) throw new Error(`cash-out score: weight ${k} must be in [0, 1)`);
    return v;
  };
  if (typeof doc.version !== 'string') throw new Error('cash-out score: missing version');
  return {
    version: doc.version,
    weights: { strong: weight('strong'), medium: weight('medium'), weak: weight('weak'), flag: weight('flag') },
    hopDecay: Number(doc.hopDecay ?? 0.5),
  };
}

/**
 * Events grouped by counterparty (entity, else address); group weight = max(w(strength) × hopDecay^hops);
 * score = round(100 × (1 − Π(1 − w_g))). Many deposits to one venue count once; different venues add up.
 */
export function cashOutScore(
  events: readonly CashOutEvent[],
  cfg: CashOutScoreConfig,
): { score: number; groups: { key: string; weight: number; eventIds: Id[] }[] } {
  const groups = new Map<string, { key: string; weight: number; eventIds: Id[] }>();
  for (const e of events) {
    const key = e.counterparty.entity ?? e.counterparty.address;
    const group = groups.get(key) ?? { key, weight: 0, eventIds: [] };
    group.weight = Math.max(group.weight, cfg.weights[e.strength] * cfg.hopDecay ** e.hops);
    group.eventIds.push(e.id);
    groups.set(key, group);
  }
  const rest = [...groups.values()].reduce((product, g) => product * (1 - g.weight), 1);
  return { score: Math.round(100 * (1 - rest)), groups: [...groups.values()] };
}
