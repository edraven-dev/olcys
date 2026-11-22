/**
 * Metric maths: precision / recall / F1 from confusion counts, document-level bootstrap confidence intervals
 * (seeded, so a report is reproducible) and macro-F1 over role classes. Undefined ratios are `NaN`.
 */
import { Prng } from './prng.ts';
import type { Metrics } from './types.ts';

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export const ratio = (num: number, den: number): number => (den === 0 ? Number.NaN : num / den);

export function precisionOf(c: Counts): number {
  return ratio(c.tp, c.tp + c.fp);
}

export function recallOf(c: Counts): number {
  return ratio(c.tp, c.tp + c.fn);
}

export function f1Of(c: Counts): number {
  const p = precisionOf(c);
  const r = recallOf(c);
  if (Number.isNaN(p) || Number.isNaN(r)) return Number.NaN;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Per-document counts of one metric group (sparse: documents without counts are omitted). */
export class Tally {
  readonly #docs = new Map<number, Counts>();

  add(doc: number, kind: keyof Counts, n = 1): void {
    const c = this.#docs.get(doc) ?? { tp: 0, fp: 0, fn: 0 };
    c[kind] += n;
    this.#docs.set(doc, c);
  }

  total(): Counts {
    const out = { tp: 0, fp: 0, fn: 0 };
    for (const c of this.#docs.values()) {
      out.tp += c.tp;
      out.fp += c.fp;
      out.fn += c.fn;
    }
    return out;
  }

  entries(): [number, Counts][] {
    return [...this.#docs];
  }
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = q * (sorted.length - 1);
  return sorted[q < 0.5 ? Math.floor(at) : Math.ceil(at)] ?? Number.NaN;
}

/** Resampling weights (documents drawn with replacement), shared by every metric group of a report. */
export class Bootstrap {
  readonly resamples: number;
  readonly #weights: Uint16Array[];

  constructor(documents: number, resamples: number, seed: string) {
    this.resamples = resamples;
    const prng = new Prng(seed);
    this.#weights = Array.from({ length: resamples }, () => {
      const w = new Uint16Array(documents);
      for (let i = 0; i < documents; i += 1) {
        const doc = prng.int(documents);
        w[doc] = (w[doc] ?? 0) + 1;
      }
      return w;
    });
  }

  /** 95 % percentile intervals of precision and recall. */
  intervals(tally: Tally): { precision: [number, number]; recall: [number, number] } {
    const entries = tally.entries();
    const precisions: number[] = [];
    const recalls: number[] = [];
    for (const w of this.#weights) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const [doc, c] of entries) {
        const k = w[doc] ?? 0;
        if (k === 0) continue;
        tp += k * c.tp;
        fp += k * c.fp;
        fn += k * c.fn;
      }
      const p = ratio(tp, tp + fp);
      const r = ratio(tp, tp + fn);
      if (!Number.isNaN(p)) precisions.push(p);
      if (!Number.isNaN(r)) recalls.push(r);
    }
    precisions.sort((a, b) => a - b);
    recalls.sort((a, b) => a - b);
    return {
      precision: [percentile(precisions, 0.025), percentile(precisions, 0.975)],
      recall: [percentile(recalls, 0.025), percentile(recalls, 0.975)],
    };
  }

  metrics(tally: Tally): Metrics {
    const c = tally.total();
    const ci = this.intervals(tally);
    return {
      ...c,
      precision: precisionOf(c),
      recall: recallOf(c),
      f1: f1Of(c),
      precisionCi95: ci.precision,
      recallCi95: ci.recall,
    };
  }
}

export interface ClassScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Macro-F1 over the classes present in the truth (single-label: each pair is one truth and one predicted class).
 * Classes only ever predicted still get their own row but do not enter the average.
 */
export function macroF1(pairs: readonly { truth: string; predicted: string }[]): {
  macroF1: number;
  byClass: Record<string, ClassScore>;
} {
  const counts = new Map<string, Counts>();
  const get = (k: string): Counts => {
    const c = counts.get(k) ?? { tp: 0, fp: 0, fn: 0 };
    counts.set(k, c);
    return c;
  };
  for (const { truth, predicted } of pairs) {
    if (truth === predicted) get(truth).tp += 1;
    else {
      get(truth).fn += 1;
      get(predicted).fp += 1;
    }
  }
  const byClass: Record<string, ClassScore> = {};
  const f1s: number[] = [];
  for (const [k, c] of [...counts].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const score = { ...c, precision: precisionOf(c), recall: recallOf(c), f1: f1Of(c) };
    byClass[k] = score;
    if (c.tp + c.fn > 0) f1s.push(Number.isNaN(score.f1) ? 0 : score.f1);
  }
  return { macroF1: f1s.length === 0 ? Number.NaN : f1s.reduce((a, b) => a + b, 0) / f1s.length, byClass };
}
