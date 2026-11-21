/**
 * Pure on-chain heuristics shared by the exclusion rules (A4 deposit addresses) and the cash-out rules (B1/B2
 * forwarding through intermediate addresses). Browser-safe: decimal arithmetic only, no I/O.
 */
import type { ChainId } from './chains.ts';
import type { DecimalString, IsoDateTime } from './common.ts';
import { dAbs, dAdd, dCmp, dDiv, dMul, dRound, dSub } from './decimal.ts';

/** One transfer leg seen from the intermediate address (a receive into it, or a forward out of it). */
export interface ForwardingLeg {
  txHash: string;
  /** Whole units of the asset. */
  amount: DecimalString;
  blockHeight: number;
  blockTime: IsoDateTime;
  /** Native symbol or token contract: only legs with the same key are paired. */
  assetKey: string;
}

export interface ForwardingPair {
  receive: ForwardingLeg;
  forward: ForwardingLeg;
  /** |a_f − a_r| in whole units. */
  amountDiff: DecimalString;
  /** t_f − t_r in blocks or seconds (see `ForwardingParams.clock`). */
  delta: number;
  /** 1 − ½·|a_f − a_r|/α − ½·(t_f − t_r)/τ, rounded half-up to 6 decimals; always > 0. */
  kappa: number;
}

export interface ForwardingParams {
  /** Maximum amount difference α, in whole units of the asset. */
  alpha: DecimalString;
  /** Maximum delay τ, in blocks or seconds. */
  tau: number;
  clock: 'blocks' | 'seconds';
}

/** Ethereum block time used to translate the block-based τ to seconds on other chains. */
export const ETHEREUM_SECONDS_PER_BLOCK = 12;

/**
 * Chain-specific matcher parameters: Ethereum mainnet counts τ in blocks; every other chain uses
 * τ × 12 seconds on block timestamps.
 */
export function forwardingParamsFor(
  chain: ChainId,
  rule: { tauBlocks: number; alpha: DecimalString },
): ForwardingParams {
  if (chain === 'evm:1') return { alpha: rule.alpha, tau: rule.tauBlocks, clock: 'blocks' };
  return { alpha: rule.alpha, tau: rule.tauBlocks * ETHEREUM_SECONDS_PER_BLOCK, clock: 'seconds' };
}

function clockOf(leg: ForwardingLeg, clock: ForwardingParams['clock']): number {
  return clock === 'blocks' ? leg.blockHeight : Math.floor(Date.parse(leg.blockTime) / 1000);
}

function byTime(clock: ForwardingParams['clock']) {
  return (a: ForwardingLeg, b: ForwardingLeg): number =>
    clockOf(a, clock) - clockOf(b, clock) || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0);
}

/**
 * Pairs each forward (in ascending time order) with the unused receive of the same asset that best explains it:
 * `0 ≤ t_f − t_r ≤ τ` and `|a_f − a_r| ≤ α`, maximum κ (tie → the earlier receive). Pairs with κ ≤ 0 are dropped.
 * Published deposit-address heuristic (Victor 2020; Tutela).
 */
export function findForwardingPairs(
  receives: readonly ForwardingLeg[],
  forwards: readonly ForwardingLeg[],
  params: ForwardingParams,
): ForwardingPair[] {
  if (!(params.tau > 0)) throw new RangeError('tau must be positive');
  if (dCmp(params.alpha, '0') <= 0) throw new RangeError('alpha must be positive');
  const order = byTime(params.clock);
  const pending = receives.toSorted(order);
  const used = new Set<ForwardingLeg>();
  const pairs: ForwardingPair[] = [];

  for (const forward of forwards.toSorted(order)) {
    const tForward = clockOf(forward, params.clock);
    let best: ForwardingPair | undefined;
    for (const receive of pending) {
      if (used.has(receive) || receive.assetKey !== forward.assetKey) continue;
      const delta = tForward - clockOf(receive, params.clock);
      if (delta < 0 || delta > params.tau) continue;
      const amountDiff = dAbs(dSub(forward.amount, receive.amount));
      if (dCmp(amountDiff, params.alpha) > 0) continue;
      const penalty = dAdd(
        dMul('0.5', dDiv(amountDiff, params.alpha, 18)),
        dMul('0.5', dDiv(String(delta), String(params.tau), 18)),
      );
      const kappa = dRound(dSub('1', penalty), 6);
      if (dCmp(kappa, '0') <= 0) continue;
      // Receives are in ascending time order, so a strictly greater κ is needed to replace an earlier receive.
      if (best === undefined || dCmp(kappa, String(best.kappa)) > 0) {
        best = { receive, forward, amountDiff, delta, kappa: Number(kappa) };
      }
    }
    if (best) {
      used.add(best.receive);
      pairs.push(best);
    }
  }
  return pairs;
}
