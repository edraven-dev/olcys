import type { ScoreBand } from '@olcys/core';
import type { ScoringWeights } from './weights.ts';

/** ICD 203 likelihood term (English) of a probability: the first row with p ≤ `max`. */
export function icd203Term(p: number, w: ScoringWeights): string {
  const row = w.scales.icd203.find((r) => p <= r.max) ?? w.scales.icd203.at(-1);
  if (!row) throw new Error('weights have no ICD 203 scale');
  return row.term;
}

/** ENFSI verbal equivalent of a likelihood ratio: the first row with LR ≤ `maxLr` (LR ≤ 1 → `no support`). */
export function enfsiTerm(lr: number, w: ScoringWeights): string {
  const row = w.scales.enfsi.find((r) => lr <= r.maxLr) ?? w.scales.enfsi.at(-1);
  if (!row) throw new Error('weights have no ENFSI scale');
  return row.term;
}

/** Lower bounds of the cheat-sheet bands (`WYKLUCZENIE` is decided by the gates, not by the number). */
export const SCORE_BAND_FLOORS = [
  { band: 'BARDZO_WYSOKIE', min: 80 },
  { band: 'PRAWDOPODOBNE', min: 60 },
  { band: 'SREDNIE', min: 40 },
  { band: 'NISKIE', min: 0 },
] as const satisfies readonly { band: ScoreBand; min: number }[];

/**
 * Cheat-sheet band of a score: 80–100 `BARDZO_WYSOKIE`, 60–79 `PRAWDOPODOBNE`, 40–59 `SREDNIE`, 10–39 `NISKIE`
 * (below 10 is noise and stays `NISKIE`), and `WYKLUCZENIE` (score 0) when a hard gate rejected the link.
 */
export function scoreBand(score: number, rejected = false): ScoreBand {
  if (rejected) return 'WYKLUCZENIE';
  return SCORE_BAND_FLOORS.find((floor) => score >= floor.min)?.band ?? 'NISKIE';
}
