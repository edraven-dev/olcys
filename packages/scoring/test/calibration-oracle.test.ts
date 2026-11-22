import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION,
  calibrate,
  generateClaims,
  oracleScenarios,
  parsePersonaSet,
  parseScenarios,
  RELATION_RULES_VERSION,
  relationAccuracy,
  scorePersona,
  serialiseReport,
  type ScenarioSpec,
  type ScoringWeights,
} from '../src/index.ts';
import { v2 } from './fixtures/helpers.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'calibration');
const SEED = 20261121;
let w: ScoringWeights;
const tierOf = (f: string) => w.features.get(f)?.tier;
beforeAll(async () => {
  w = await v2();
});

describe('oracle mode (n = 20,000, seed 20261121)', () => {
  it('AC3: a correct engine is calibrated on data drawn from its own weights', () => {
    const report = calibrate(generateClaims(oracleScenarios(w), 20000, SEED, tierOf), w, {
      seed: SEED,
      mode: 'oracle',
    });
    expect(report.n).toBe(20000);
    expect(report.ece.value).toBeLessThan(0.03);
    expect(Math.abs(report.meanPredicted - report.observedRate)).toBeLessThan(0.01);
    expect(report.bins.reduce((s, b) => s + b.count, 0)).toBe(20000);
    let checked = 0;
    for (const [key, f] of Object.entries(report.features)) {
      if (f.present1 + f.present0 < 500) continue;
      checked += 1;
      expect(
        Math.abs(f.empiricalLr / f.weightBfPrime - 1),
        `${key}: ${f.empiricalLr} vs ${f.weightBfPrime}`,
      ).toBeLessThan(0.15);
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    // Every oracle group is calibrated: none is flagged.
    expect(report.warnings.filter((x) => x.startsWith('overconfident'))).toEqual([]);
  });

  it('AC5: same inputs and seed give byte-identical report.json carrying the provenance fields', () => {
    const run = () =>
      serialiseReport(
        calibrate(generateClaims(oracleScenarios(w), 2000, SEED, tierOf), w, { seed: SEED, bootstrap: 100 }),
      );
    const a = run();
    expect(run()).toBe(a);
    const report = JSON.parse(a) as Record<string, unknown>;
    expect(report['weightsSha256']).toBe(w.sha256);
    expect(report['weightsVersion']).toBe('weights.v2');
    expect(report['algorithmVersion']).toBe(ALGORITHM_VERSION);
    expect(report['rulesVersion']).toBe(RELATION_RULES_VERSION);
    expect(report['datasetSha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(report['seed']).toBe(SEED);
    expect(report['weightsStatus']).toBe('uncalibrated');
    expect(typeof report['notice']).toBe('string');
  });
});

const base = (originGroups: number): ScenarioSpec => ({
  id: 'mirrored_duplicates',
  label: 0.56,
  weight: 1,
  relation: 'SELF_DECLARED',
  anchor: true,
  identity: [],
  address: [{ feature: 'e3_ownership_cue', p: 1, grade: 'C', originGroups, copies: 4 }],
});
const warnings = (originGroups: number): string[] =>
  calibrate(generateClaims([base(originGroups)], 1000, SEED, tierOf), w, { seed: SEED, bootstrap: 10 }).warnings;

describe('double counting (AC4)', () => {
  it('mirrors from one shared origin group are counted once: no warning', () => {
    expect(warnings(1)).not.toContain('overconfident:mirrored_duplicates');
  });

  it('simulated double counting (independent origin group per mirror) raises overconfident:<scenario>', () => {
    expect(warnings(4)).toContain('overconfident:mirrored_duplicates');
  });
});

describe('scenario file, persona set and corpus fields', () => {
  it('the committed scenarios run and flag the same-nick stranger the engine rates above the assumed truth', () => {
    const { scenarios } = parseScenarios(readFileSync(join(FIXTURES, 'scenarios.v1.yaml'), 'utf8'));
    const report = calibrate(generateClaims(scenarios, 4000, SEED, tierOf), w, { seed: SEED, bootstrap: 50 });
    expect(report.warnings).toContain('overconfident:same_nick_stranger_with_proof');
    expect(report.warnings).toContain('corpus_missing');
    expect(report.relationAccuracy).toBeUndefined();
    expect(report.byScenario['exchange_deposit_mention']?.meanPredicted).toBe(0);
    expect(Math.abs((report.byScenario['mirrored_duplicates']?.meanPredicted ?? 0) - 0.56)).toBeLessThan(0.01);
  });

  it('AC6: the persona set reproduces 99 / 77 / 24 and the worked example 50 / 62', () => {
    const { cases } = parsePersonaSet(readFileSync(join(FIXTURES, 'persona.v1.yaml'), 'utf8'));
    const result = scorePersona(cases, w);
    expect(result.map((r) => r.got)).toEqual(result.map((r) => r.expected));
    const report = calibrate([], w, { seed: 1, bootstrap: 0, persona: result });
    expect(report.warnings.some((x) => x.startsWith('persona_mismatch'))).toBe(false);
    const wrong = calibrate([], w, { seed: 1, bootstrap: 0, persona: [{ claim: 'BTC-1', expected: 99, got: 98 }] });
    expect(wrong.warnings).toContain('persona_mismatch:BTC-1');
  });

  it('AC8: relation accuracy is reported when pairs are given, with a confusion matrix and macro-F1', () => {
    const pairs = [
      { truth: 'SELF_DECLARED', predicted: 'SELF_DECLARED' },
      { truth: 'SELF_DECLARED', predicted: 'MENTION_UNCLEAR' },
      { truth: 'MENTION_UNCLEAR', predicted: 'MENTION_UNCLEAR' },
    ] as const;
    const direct = relationAccuracy(pairs);
    expect(direct.confusion['SELF_DECLARED']).toEqual({ MENTION_UNCLEAR: 1, SELF_DECLARED: 1 });
    expect(direct.macroF1).toBeCloseTo(2 / 3, 12);
    const report = calibrate([], w, { seed: 1, bootstrap: 0, relationPairs: pairs, relationUnmatched: 2 });
    expect(report.relationAccuracy).toMatchObject({ n: 3, unmatched: 2 });
    expect(report.warnings).not.toContain('corpus_missing');
  });
});
