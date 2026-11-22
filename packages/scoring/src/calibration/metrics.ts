import { Rng } from './prng.ts';

/** A point estimate with a bootstrap 95 % percentile interval. */
export interface Estimate {
  value: number;
  ci95: [number, number];
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export const DEFAULT_BINS = 10;
export const DEFAULT_BOOTSTRAP = 1000;
const EPS = 1e-15;

const zeros = (length: number): number[] => Array.from({ length }, () => 0);

const flat = (value: number): Estimate => ({ value, ci95: [value, value] });

function interval(values: number[]): [number, number] {
  const sorted = values.toSorted((a, b) => a - b);
  return [percentile(sorted, 0.025), percentile(sorted, 0.975)];
}

/** Equal-width bin of a probability: `[0, .1) … [.9, 1]`, p = 1 falls in the last one. */
export function binIndex(p: number, bins: number = DEFAULT_BINS): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
}

const squaredError = (p: number, y: number): number => (p - y) ** 2;

function logLossOf(p: number, y: number): number {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return -(y === 1 ? Math.log(q) : Math.log(1 - q));
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

export function brier(p: readonly number[], y: readonly number[]): number {
  return mean(p.map((v, i) => squaredError(v, y[i] ?? 0)));
}

export function logLoss(p: readonly number[], y: readonly number[]): number {
  return mean(p.map((v, i) => logLossOf(v, y[i] ?? 0)));
}

export function reliabilityBins(
  p: readonly number[],
  y: readonly number[],
  bins: number = DEFAULT_BINS,
): ReliabilityBin[] {
  const count = zeros(bins);
  const sumP = zeros(bins);
  const sumY = zeros(bins);
  p.forEach((v, i) => {
    const b = binIndex(v, bins);
    count[b] = (count[b] ?? 0) + 1;
    sumP[b] = (sumP[b] ?? 0) + v;
    sumY[b] = (sumY[b] ?? 0) + (y[i] ?? 0);
  });
  return count.map((n, b) => ({
    lower: b / bins,
    upper: (b + 1) / bins,
    count: n,
    meanPredicted: n === 0 ? 0 : (sumP[b] ?? 0) / n,
    observedRate: n === 0 ? 0 : (sumY[b] ?? 0) / n,
  }));
}

/** ECE = Σ (n_b / N) · |observed_b − mean predicted_b|. */
export function ece(p: readonly number[], y: readonly number[], bins: number = DEFAULT_BINS): number {
  if (p.length === 0) return 0;
  return reliabilityBins(p, y, bins).reduce(
    (s, b) => s + (b.count / p.length) * Math.abs(b.observedRate - b.meanPredicted),
    0,
  );
}

function percentile(sorted: readonly number[], q: number): number {
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at] ?? 0;
}

/**
 * Brier, log loss and ECE with bootstrap 95 % intervals (resampling claims with replacement, seeded: the same
 * inputs and seed give the same numbers).
 */
export function estimateMetrics(
  p: readonly number[],
  y: readonly number[],
  o: { bins?: number; bootstrap?: number; seed: number },
): { brier: Estimate; logLoss: Estimate; ece: Estimate } {
  const bins = o.bins ?? DEFAULT_BINS;
  const resamples = o.bootstrap ?? DEFAULT_BOOTSTRAP;
  const n = p.length;
  const point = { brier: brier(p, y), logLoss: logLoss(p, y), ece: ece(p, y, bins) };
  if (n === 0 || resamples === 0) {
    return { brier: flat(point.brier), logLoss: flat(point.logLoss), ece: flat(point.ece) };
  }
  const bin = p.map((v) => binIndex(v, bins));
  const se = p.map((v, i) => squaredError(v, y[i] ?? 0));
  const ll = p.map((v, i) => logLossOf(v, y[i] ?? 0));
  const rng = new Rng(o.seed ^ 0x5bd1e995);
  const briers: number[] = [];
  const losses: number[] = [];
  const eces: number[] = [];
  const count = zeros(bins);
  const sumP = zeros(bins);
  const sumY = zeros(bins);
  for (let r = 0; r < resamples; r += 1) {
    count.fill(0);
    sumP.fill(0);
    sumY.fill(0);
    let sb = 0;
    let sl = 0;
    for (let k = 0; k < n; k += 1) {
      const i = rng.int(n);
      const b = bin[i] as number;
      sb += se[i] as number;
      sl += ll[i] as number;
      count[b] = (count[b] as number) + 1;
      sumP[b] = (sumP[b] as number) + (p[i] as number);
      sumY[b] = (sumY[b] as number) + (y[i] as number);
    }
    let e = 0;
    for (let b = 0; b < bins; b += 1) {
      const c = count[b] as number;
      if (c > 0) e += (c / n) * Math.abs((sumY[b] as number) / c - (sumP[b] as number) / c);
    }
    briers.push(sb / n);
    losses.push(sl / n);
    eces.push(e);
  }
  return {
    brier: { value: point.brier, ci95: interval(briers) },
    logLoss: { value: point.logLoss, ci95: interval(losses) },
    ece: { value: point.ece, ci95: interval(eces) },
  };
}
