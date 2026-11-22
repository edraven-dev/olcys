import type { Sha256Hex } from '@olcys/core';
import { discount } from '../hop.ts';
import { scoreLink } from '../link.ts';
import { ALGORITHM_VERSION, RELATION_RULES_VERSION } from '../version.ts';
import type { ScoringWeights } from '../weights.ts';
import { canonicalJson, sha256OfText } from './canonical.ts';
import {
  brier,
  DEFAULT_BINS,
  DEFAULT_BOOTSTRAP,
  estimateMetrics,
  reliabilityBins,
  type Estimate,
  type ReliabilityBin,
} from './metrics.ts';
import { relationAccuracy, type RelationAccuracy, type RelationPair } from './relations.ts';
import type { PersonaResult } from './persona.ts';
import type { LabelledClaim } from './scenarios.ts';

/** Honesty rule: printed in every output. */
export const CALIBRATION_NOTICE =
  'Kalibracja na danych syntetycznych sprawdza mechanikę silnika i założenia generatora, a nie rzeczywiste ilorazy wiarygodności. Wagi pozostają nieskalibrowane, dopóki nie istnieją rzeczywiste, oznaczone dane.';

export const OVERCONFIDENT_GAP = 0.1;
export const OVERCONFIDENT_MIN_N = 200;
export const SPARSE_BELOW = 30;

/** Where the corpus results come from, so a saved report can be reproduced. */
export interface CorpusProvenance {
  extractorVersion: string;
  manifestSha256: Sha256Hex;
  /** SHA-256 over `<file> <sha256>` lines of the ground truth and every document used. */
  usedFilesSha256: Sha256Hex;
  denyListSha256: Sha256Hex;
  documents: number;
  /** Document cap, when one was set. */
  limit?: number;
}

export interface FeatureStats {
  /** Distinct grades the generated items of this feature carry (a proposal needs them equal to the default grade). */
  grades: string[];
  /** Claims with the feature among the true class (hop truth when known, else the claim label). */
  present1: number;
  present0: number;
  /** Claims in each class that could carry the feature (identity features: not anchored). */
  total1: number;
  total0: number;
  empiricalLr: number;
  weightBf: number;
  weightBfPrime: number;
}

export interface CalibrationReport {
  algorithmVersion: string;
  weightsVersion: string;
  weightsSha256: Sha256Hex;
  rulesVersion: string;
  datasetSha256: Sha256Hex;
  seed: number;
  n: number;
  weightsStatus: string;
  /** `oracle` (emission follows the weights) or `scenarios` (hand-set generator assumptions). */
  mode: string;
  notice: string;
  /** Mean predicted probability and observed rate over all claims. */
  meanPredicted: number;
  observedRate: number;
  brier: Estimate;
  logLoss: Estimate;
  ece: Estimate;
  bins: ReliabilityBin[];
  byScenario: Record<string, { n: number; meanPredicted: number; observedRate: number; brier: number }>;
  byRelation: Record<string, { n: number; brier: number }>;
  byTier: Record<string, { n: number; brier: number }>;
  features: Record<string, FeatureStats>;
  /** `n` pairs compared; `unmatched` truth addresses without a claim (not extracted or filtered), left out. */
  relationAccuracy?: RelationAccuracy & { n: number; unmatched: number };
  corpus?: CorpusProvenance;
  persona?: PersonaResult[];
  warnings: string[];
}

export interface CalibrateOptions {
  bins?: number;
  bootstrap?: number;
  seed: number;
  mode?: string;
  /** Relation predictions on the extraction corpus; absent → `corpus_missing`. */
  relationPairs?: readonly RelationPair[];
  relationUnmatched?: number;
  corpus?: CorpusProvenance;
  persona?: readonly PersonaResult[];
}

/** Empirical likelihood ratio with +0.5 / +1 smoothing: ((n1 + 0.5) / (N1 + 1)) / ((n0 + 0.5) / (N0 + 1)). */
export function empiricalLr(n1: number, total1: number, n0: number, total0: number): number {
  return (n1 + 0.5) / (total1 + 1) / ((n0 + 0.5) / (total0 + 1));
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

function group<T extends string>(
  rows: readonly { key: T; p: number; y: number }[],
): Record<string, { n: number; p: number; y: number; brier: number }> {
  const out: Record<string, { n: number; p: number; y: number; brier: number }> = {};
  const keys = [...new Set(rows.map((r) => r.key))].toSorted();
  for (const key of keys) {
    const subset = rows.filter((r) => r.key === key);
    out[key] = {
      n: subset.length,
      p: mean(subset.map((r) => r.p)),
      y: mean(subset.map((r) => r.y)),
      brier: brier(
        subset.map((r) => r.p),
        subset.map((r) => r.y),
      ),
    };
  }
  return out;
}

function featureTable(claims: readonly LabelledClaim[], w: ScoringWeights): Record<string, FeatureStats> {
  const table: Record<string, FeatureStats> = {};
  const keys = [...w.features.keys()].toSorted();
  for (const key of keys) {
    const weight = w.features.get(key);
    if (!weight) continue;
    const grade = weight.defaultGrade ?? 'A';
    const rho = w.reliability[grade] ?? 1;
    let present1 = 0;
    let present0 = 0;
    let total1 = 0;
    let total0 = 0;
    const grades = new Set<string>();
    for (const { claim, label, hop } of claims) {
      const path = claim.paths[0];
      if (!path || (weight.hop === 'identity' && path.anchor)) continue;
      const truth = hop ? hop[weight.hop] : label;
      const items = weight.hop === 'identity' ? path.identity : path.address;
      const own = items.filter((item) => item.feature === key);
      for (const item of own) grades.add(item.reliability);
      const present = own.length > 0;
      if (truth === 1) {
        total1 += 1;
        if (present) present1 += 1;
      } else {
        total0 += 1;
        if (present) present0 += 1;
      }
    }
    table[key] = {
      grades: [...grades].toSorted(),
      present1,
      present0,
      total1,
      total0,
      empiricalLr: empiricalLr(present1, total1, present0, total0),
      weightBf: weight.bayesFactor,
      weightBfPrime: discount(weight.bayesFactor, rho),
    };
  }
  return table;
}

/**
 * Scores every claim with the engine and measures how well the probabilities match the labels. Pure: the same claims,
 * weights and options give the same report (and the same bytes once serialised with `serialiseReport`).
 */
export function calibrate(claims: readonly LabelledClaim[], w: ScoringWeights, o: CalibrateOptions): CalibrationReport {
  let counter = 0;
  const deps = {
    clock: { now: () => new Date('2026-11-21T12:00:00.000Z') },
    newId: () => `01900000-0000-7000-8000-${String((counter += 1)).padStart(12, '0')}`,
  };
  const p: number[] = [];
  const y: number[] = [];
  for (const { claim, label } of claims) {
    const result = scoreLink(claim, w, deps);
    if (!result.ok) throw new Error(`calibration claim could not be scored: ${result.reason}`);
    p.push(result.assessment.probability);
    y.push(label);
  }
  const bins = o.bins ?? DEFAULT_BINS;
  const metrics = estimateMetrics(p, y, { bins, bootstrap: o.bootstrap ?? DEFAULT_BOOTSTRAP, seed: o.seed });
  const rows = claims.map((c, i) => ({ c, p: p[i] ?? 0, y: y[i] ?? 0 }));

  const scenarios = group(rows.map((r) => ({ key: r.c.scenario, p: r.p, y: r.y })));
  const byScenario: CalibrationReport['byScenario'] = {};
  const warnings: string[] = [];
  for (const [id, s] of Object.entries(scenarios)) {
    byScenario[id] = { n: s.n, meanPredicted: s.p, observedRate: s.y, brier: s.brier };
    if (s.n >= OVERCONFIDENT_MIN_N && s.p - s.y > OVERCONFIDENT_GAP) warnings.push(`overconfident:${id}`);
  }
  const byRelation: CalibrationReport['byRelation'] = {};
  for (const [id, s] of Object.entries(group(rows.map((r) => ({ key: r.c.claim.relation, p: r.p, y: r.y }))))) {
    byRelation[id] = { n: s.n, brier: s.brier };
  }
  const byTier: CalibrationReport['byTier'] = {};
  for (const [id, s] of Object.entries(group(rows.map((r) => ({ key: r.c.claim.tier, p: r.p, y: r.y }))))) {
    byTier[id] = { n: s.n, brier: s.brier };
  }

  const features = featureTable(claims, w);
  for (const [key, f] of Object.entries(features)) {
    if (f.present1 < SPARSE_BELOW || f.present0 < SPARSE_BELOW) warnings.push(`sparse:${key}`);
  }

  const report: CalibrationReport = {
    algorithmVersion: ALGORITHM_VERSION,
    weightsVersion: w.version,
    weightsSha256: w.sha256,
    rulesVersion: RELATION_RULES_VERSION,
    datasetSha256: sha256OfText(canonicalJson(claims)),
    seed: o.seed,
    n: claims.length,
    weightsStatus: w.status,
    mode: o.mode ?? 'scenarios',
    notice: CALIBRATION_NOTICE,
    meanPredicted: mean(p),
    observedRate: mean(y),
    brier: metrics.brier,
    logLoss: metrics.logLoss,
    ece: metrics.ece,
    bins: reliabilityBins(p, y, bins),
    byScenario,
    byRelation,
    byTier,
    features,
    warnings: [],
  };
  if (o.corpus) report.corpus = o.corpus;
  if (o.relationPairs)
    report.relationAccuracy = {
      ...relationAccuracy(o.relationPairs),
      n: o.relationPairs.length,
      unmatched: o.relationUnmatched ?? 0,
    };
  else warnings.push('corpus_missing');
  if (o.persona) {
    report.persona = [...o.persona];
    for (const r of o.persona) if (r.got !== r.expected) warnings.push(`persona_mismatch:${r.claim}`);
  }
  report.warnings = warnings.toSorted();
  return report;
}

/** Deterministic serialisation: the same report always gives the same bytes. */
export function serialiseReport(report: CalibrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
