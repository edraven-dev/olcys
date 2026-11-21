/**
 * Confidence Score bands from the challenge's cheat sheet: 80–100 very high, 60–79 probable, 40–59 medium,
 * 10–39 low / noise, 0 exclusion. A link rejected by a hard gate (exclusion rule, non-ownership relation) is
 * `WYKLUCZENIE`; a link that is not rejected but scores below 10 is `NISKIE` (noise). The scoring engine sends the
 * band with each link; the console computes it only when the field is missing.
 */
export const SCORE_BANDS = ['BARDZO_WYSOKIE', 'PRAWDOPODOBNE', 'SREDNIE', 'NISKIE', 'WYKLUCZENIE'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export function isScoreBand(value: unknown): value is ScoreBand {
  return typeof value === 'string' && (SCORE_BANDS as readonly string[]).includes(value);
}

export function bandForScore(score: number, rejected = false): ScoreBand {
  if (rejected) return 'WYKLUCZENIE';
  if (score >= 80) return 'BARDZO_WYSOKIE';
  if (score >= 60) return 'PRAWDOPODOBNE';
  if (score >= 40) return 'SREDNIE';
  return 'NISKIE';
}

/** Band to display: the engine's own band when present and valid, otherwise computed from the score. */
export function resolveBand(link: { band?: unknown; score: number }, rejected = false): ScoreBand {
  return isScoreBand(link.band) ? link.band : bandForScore(link.score, rejected);
}
