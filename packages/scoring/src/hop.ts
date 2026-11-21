import type { EvidenceFeature, FeatureContribution, Hop, HopResult } from '@olcys/core';
import { compareText } from './compare.ts';
import { enfsiTerm } from './scales.ts';
import type { ScoringWeights } from './weights.ts';

/** Reliability-discounted Bayes factor BF′ = ρ·BF + (1 − ρ): unreliable evidence decays towards neutral (1). */
export function discount(bf: number, rho: number): number {
  return rho * bf + (1 - rho);
}

/** P = 2^W / (1 + 2^W), in the numerically stable form 1 / (1 + 2^(−W)). */
export function probabilityFromBits(bits: number): number {
  return 1 / (1 + 2 ** -bits);
}

function contributionOf(hop: Hop, item: EvidenceFeature, w: ScoringWeights): FeatureContribution {
  const weight = w.features.get(item.feature);
  if (!weight) throw new Error(`unknown scoring feature "${item.feature}"`);
  if (weight.hop !== hop) throw new Error(`feature "${item.feature}" belongs to the ${weight.hop} hop, not ${hop}`);
  const rho = w.reliability[item.reliability];
  if (rho === undefined) throw new Error(`unknown reliability grade "${item.reliability}"`);
  if (rho === null) {
    return {
      ...item,
      bayesFactor: weight.bayesFactor,
      rho: 0,
      discountedBayesFactor: 1,
      bits: 0,
      counted: false,
      uncountedReason: 'ungraded',
    };
  }
  const discounted = discount(weight.bayesFactor, rho);
  return {
    ...item,
    bayesFactor: weight.bayesFactor,
    rho,
    discountedBayesFactor: discounted,
    bits: Math.log2(discounted),
    counted: true,
  };
}

/** Deterministic tie-break between items of equal weight: feature, then capture, observation and candidate ids. */
function compareKeys(a: FeatureContribution, b: FeatureContribution): number {
  return (
    compareText(a.feature, b.feature) ||
    compareText(a.originGroup, b.originGroup) ||
    compareText(a.evidence.captureId, b.evidence.captureId) ||
    compareText(a.evidence.observationId, b.evidence.observationId) ||
    compareText(a.evidence.candidateId, b.evidence.candidateId)
  );
}

/** Keeps only the strongest item (largest |bits|) per (origin group, feature family); the rest are repeats. */
function dedup(contributions: FeatureContribution[], w: ScoringWeights): void {
  const best = new Map<string, FeatureContribution>();
  for (const c of contributions) {
    if (!c.counted) continue;
    const key = `${c.originGroup}\u0000${w.features.get(c.feature)?.family ?? c.feature}`;
    const current = best.get(key);
    if (!current || Math.abs(c.bits) > Math.abs(current.bits)) best.set(key, c);
    else if (Math.abs(c.bits) === Math.abs(current.bits) && compareKeys(c, current) < 0) best.set(key, c);
  }
  const winners = new Set(best.values());
  for (const c of contributions) {
    if (c.counted && !winners.has(c)) {
      c.counted = false;
      c.uncountedReason = 'same_origin_repeat';
    }
  }
}

function compareContributions(a: FeatureContribution, b: FeatureContribution): number {
  if (a.counted !== b.counted) return a.counted ? -1 : 1;
  return Math.abs(b.bits) - Math.abs(a.bits) || compareKeys(a, b);
}

/**
 * Scores one hop: W = log2(prior odds) + Σ counted log2(BF′). An anchored identity hop is a recorded assumption:
 * P = `anchorProbability`, prior bits log2(P / (1 − P)), no contributions (supplied identity items are ignored).
 * Throws on an unknown feature key or a feature of the other hop (a bug in the caller).
 */
export function scoreHop(
  hop: Hop,
  items: readonly EvidenceFeature[],
  w: ScoringWeights,
  opts: { anchor?: boolean } = {},
): HopResult {
  if (hop === 'identity' && opts.anchor) {
    const p = w.identity.anchorProbability;
    const priorBits = Math.log2(p / (1 - p));
    return {
      hop,
      priorBits,
      contributions: [],
      totalBits: priorBits,
      probability: p,
      likelihoodRatio: 1,
      enfsiVerbal: enfsiTerm(1, w),
    };
  }
  const priorBits = Math.log2(hop === 'identity' ? w.identity.priorOdds : w.address.priorOdds);
  const contributions = items.map((item) => contributionOf(hop, item, w));
  dedup(contributions, w);
  contributions.sort(compareContributions);
  const evidenceBits = contributions.reduce((sum, c) => (c.counted ? sum + c.bits : sum), 0);
  const totalBits = priorBits + evidenceBits;
  const likelihoodRatio = 2 ** evidenceBits;
  return {
    hop,
    priorBits,
    contributions,
    totalBits,
    probability: probabilityFromBits(totalBits),
    likelihoodRatio,
    enfsiVerbal: enfsiTerm(likelihoodRatio, w),
  };
}
