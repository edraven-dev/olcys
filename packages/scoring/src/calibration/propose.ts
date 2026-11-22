import { stringify } from 'yaml';
import type { ScoringWeights } from '../weights.ts';
import type { CalibrationReport } from './report.ts';

export const PROPOSAL_VERSION = 'weights.v2-proposed';
const MIN_BF = 1 / 1024;
const MAX_BF = 1024;

const significant = (value: number): number => Number(value.toPrecision(3));

/**
 * Proposed weights file (YAML text) from measured likelihood ratios: a feature seen at least `minCount` times in both
 * classes gets BF = (LR − (1 − ρ)) / ρ — the engine discounts BF to BF′ = ρ·BF + (1 − ρ), and the measured ratio is
 * the discounted one — clipped to [1/1024, 1024] and rounded to 3 significant digits; every other value, the scales
 * and the structure are copied unchanged. The file is a proposal from synthetic data and needs a human review; it
 * is never applied by this code.
 */
export function proposeWeights(report: CalibrationReport, w: ScoringWeights, minCount = 30): string {
  const features = (hop: 'identity' | 'address'): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of w.features.values()) {
      if (f.hop !== hop) continue;
      const stats = report.features[f.key];
      const rho = w.reliability[f.defaultGrade ?? 'A'] ?? 1;
      let bayesFactor = f.bayesFactor;
      if (stats && stats.present1 >= minCount && stats.present0 >= minCount) {
        const raw = (stats.empiricalLr - (1 - rho)) / rho;
        bayesFactor = significant(Math.min(MAX_BF, Math.max(MIN_BF, raw)));
      }
      out[f.key] = {
        bayesFactor,
        ...(f.defaultGrade === undefined ? {} : { defaultGrade: f.defaultGrade }),
        ...(f.tier === undefined ? {} : { tier: f.tier }),
        ...(f.reviewRequired === undefined ? {} : { reviewRequired: f.reviewRequired }),
        ...(f.note === '' ? {} : { note: f.note }),
      };
    }
    return out;
  };
  const config = {
    version: PROPOSAL_VERSION,
    status: 'uncalibrated',
    reliability: { ...w.reliability },
    identity: {
      anchorProbability: w.identity.anchorProbability,
      priorOdds: w.identity.priorOdds,
      features: features('identity'),
    },
    address: { priorOdds: w.address.priorOdds, features: features('address') },
    scales: {
      icd203: w.scales.icd203.map((r) => ({ max: r.max, term: r.term, pl: r.pl })),
      enfsi: w.scales.enfsi.map((r) => ({ maxLr: r.maxLr, term: r.term })),
    },
  };
  const header = [
    '# propozycja z danych syntetycznych — wymaga przeglądu',
    `# Źródło: ${w.version} (SHA-256 ${w.sha256}); zbiór danych ${report.datasetSha256}; ziarno ${report.seed}; n = ${report.n}; tryb ${report.mode}.`,
    `# Zmieniono tylko cechy z co najmniej ${minCount} wystąpieniami w obu klasach; pozostałe wartości skopiowano bez zmian.`,
    '# Plik nie jest stosowany automatycznie: zatwierdzenie jako nowej wersji wag to decyzja człowieka.',
    '',
  ].join('\n');
  return header + stringify(config, { lineWidth: 120 });
}
