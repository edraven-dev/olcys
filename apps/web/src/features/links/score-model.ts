/** Pure helpers for the Confidence Score explanation: waterfall bars, trace synergy and evidence references. */
import type { FeatureContribution, HopResult, OnlineAccount } from '@olcys/core';
import type { LinkView, TraceSynergyView } from '../../lib/domain.ts';

export interface WaterfallBar {
  key: string;
  kind: 'prior' | 'anchor' | 'feature' | 'total';
  /** Feature key of `weights.v1.yaml` for `feature` bars. */
  feature?: string;
  start: number;
  end: number;
  bits: number;
  counted: boolean;
  contribution?: FeatureContribution;
}

/** The identity hop of an investigator-supplied anchor: P = 0.99, encoded as prior odds 99:1 without evidence. */
export const ANCHOR_PRIOR_BITS = Math.log2(99);

export function isAnchorHop(hop: HopResult): boolean {
  return hop.hop === 'identity' && hop.contributions.length === 0 && Math.abs(hop.priorBits - ANCHOR_PRIOR_BITS) < 0.01;
}

/**
 * Prior, then every contribution in order (superseded items are shown at zero length — transparency requires
 * showing them), then the total `W`.
 */
export function waterfallBars(hop: HopResult): WaterfallBar[] {
  if (isAnchorHop(hop)) {
    return [{ key: 'anchor', kind: 'anchor', start: 0, end: hop.priorBits, bits: hop.priorBits, counted: true }];
  }
  const bars: WaterfallBar[] = [
    { key: 'prior', kind: 'prior', start: 0, end: hop.priorBits, bits: hop.priorBits, counted: true },
  ];
  let running = hop.priorBits;
  hop.contributions.forEach((contribution, index) => {
    const bits = contribution.counted ? contribution.bits : 0;
    bars.push({
      key: `${contribution.feature}-${index}`,
      kind: 'feature',
      feature: contribution.feature,
      start: running,
      end: running + bits,
      bits: contribution.bits,
      counted: contribution.counted,
      contribution,
    });
    running += bits;
  });
  bars.push({ key: 'total', kind: 'total', start: 0, end: hop.totalBits, bits: hop.totalBits, counted: true });
  return bars;
}

/** Axis range covering every bar and zero, with a little headroom. */
export function waterfallDomain(bars: readonly WaterfallBar[]): [number, number] {
  const values = bars.flatMap((bar) => [bar.start, bar.end]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const pad = Math.max(0.5, (max - min) * 0.05);
  return [min - (min < 0 ? pad : 0), max + pad];
}

/**
 * Trace synergy from the engine when provided; otherwise derived from the paths: distinct services of the counted
 * paths, the best single-path score and the points the other independent sources add.
 */
export function synergyOf(link: LinkView, accounts: ReadonlyMap<string, OnlineAccount>): TraceSynergyView {
  if (link.synergy) return link.synergy;
  const counted = link.paths.filter((path) => path.counted !== false);
  const services = new Set(
    counted.map((path) => path.service ?? (path.accountId ? accounts.get(path.accountId)?.platform : undefined) ?? '?'),
  );
  const best = Math.max(0, ...link.paths.map((path) => Math.round(100 * path.probability)));
  const repeatedItems = link.paths
    .flatMap((path) => [...path.identityHop.contributions, ...path.addressHop.contributions])
    .filter((c) => !c.counted).length;
  return {
    independentSources: [...services].toSorted(),
    bestSingleScore: best,
    bonusPoints: Math.max(0, link.score - best),
    repeatedPaths: link.paths.length - counted.length,
    repeatedItems,
  };
}

/** Capture, observation and candidate ids that the link's evidence items point to, in first-seen order. */
export function evidenceRefs(link: LinkView): {
  captureIds: string[];
  observationIds: string[];
  candidateIds: string[];
} {
  const captureIds = new Set<string>();
  const observationIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const path of link.paths) {
    for (const c of [...path.identityHop.contributions, ...path.addressHop.contributions]) {
      if (c.evidence.captureId) captureIds.add(c.evidence.captureId);
      if (c.evidence.observationId) observationIds.add(c.evidence.observationId);
      if (c.evidence.candidateId) candidateIds.add(c.evidence.candidateId);
    }
  }
  return { captureIds: [...captureIds], observationIds: [...observationIds], candidateIds: [...candidateIds] };
}
