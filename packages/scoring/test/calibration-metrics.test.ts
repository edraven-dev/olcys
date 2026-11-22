import { describe, expect, it } from 'vitest';
import { binIndex, brier, ece, estimateMetrics, logLoss, reliabilityBins } from '../src/index.ts';

const P = [0.9, 0.2, 0.6, 0.5];
const Y = [1, 0, 1, 0];

describe('calibration metrics', () => {
  it('AC1: toy set gives Brier 0.115, log loss 0.383119 and ECE 0.3', () => {
    expect(brier(P, Y)).toBeCloseTo(0.115, 12);
    expect(logLoss(P, Y)).toBeCloseTo(0.383119, 6);
    expect(ece(P, Y, 10)).toBeCloseTo(0.3, 12);
  });

  it('AC2: p = 1 lands in [0.9, 1], p = 0.1 in [0.1, 0.2), and the counts sum to n', () => {
    expect(binIndex(1)).toBe(9);
    expect(binIndex(0.1)).toBe(1);
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.9)).toBe(9);
    const p = [0, 0.05, 0.1, 0.19, 0.5, 0.9, 1, 1];
    const bins = reliabilityBins(
      p,
      p.map(() => 1),
    );
    expect(bins).toHaveLength(10);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(p.length);
    expect(bins[9]?.count).toBe(3);
    expect(bins[1]?.count).toBe(2);
    expect([bins[1]?.lower, bins[1]?.upper]).toEqual([0.1, 0.2]);
  });

  it('clips probabilities for the log loss, so a certain wrong answer stays finite', () => {
    expect(Number.isFinite(logLoss([0, 1], [1, 0]))).toBe(true);
    expect(logLoss([0], [1])).toBeCloseTo(-Math.log(1e-15), 9);
  });

  it('bootstrap intervals contain the point estimate and are reproducible for a seed', () => {
    const p = Array.from({ length: 400 }, (_, i) => (i % 10) / 10 + 0.05);
    const y = p.map((v, i) => (i % 7 === 0 ? 1 : v > 0.5 ? 1 : 0));
    const a = estimateMetrics(p, y, { bootstrap: 200, seed: 7 });
    const b = estimateMetrics(p, y, { bootstrap: 200, seed: 7 });
    expect(a).toEqual(b);
    for (const e of [a.brier, a.logLoss, a.ece]) {
      expect(e.ci95[0]).toBeLessThanOrEqual(e.ci95[1]);
    }
    expect(a.brier.ci95[0]).toBeLessThanOrEqual(a.brier.value);
    expect(a.brier.ci95[1]).toBeGreaterThanOrEqual(a.brier.value);
    expect(estimateMetrics(p, y, { bootstrap: 200, seed: 8 }).brier.ci95).not.toEqual(a.brier.ci95);
  });
});
