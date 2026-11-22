import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  generateClaims,
  oracleScenarios,
  parsePersonaSet,
  parseScenarios,
  sha256OfText,
  type ScenarioSpec,
  type ScoringWeights,
} from '../src/index.ts';
import { v2 } from './fixtures/helpers.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'calibration');
let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const spec = (extra: Partial<ScenarioSpec>): ScenarioSpec => ({
  id: 's',
  label: 1,
  weight: 1,
  relation: 'SELF_DECLARED',
  anchor: false,
  identity: [],
  address: [],
  ...extra,
});

describe('scenario generator', () => {
  it('is deterministic: same specs and seed give the same claims, another seed does not', () => {
    const specs = oracleScenarios(w);
    const a = generateClaims(specs, 500, 11);
    expect(generateClaims(specs, 500, 11)).toEqual(a);
    expect(canonicalJson(generateClaims(specs, 500, 12))).not.toBe(canonicalJson(a));
    expect(sha256OfText(canonicalJson(a))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allocates exactly n claims by weight and never generates third-party attributions', () => {
    const claims = generateClaims(
      [
        spec({ id: 'a', weight: 3 }),
        spec({ id: 'b', weight: 1 }),
        spec({ id: 'tp', weight: 9, relation: 'THIRD_PARTY_ATTRIBUTION' }),
      ],
      1001,
      1,
    );
    expect(claims).toHaveLength(1001);
    expect(claims.filter((c) => c.scenario === 'a')).toHaveLength(751);
    expect(claims.some((c) => c.scenario === 'tp')).toBe(false);
  });

  it('draws features as Bernoulli, honours copies and origin groups, and ignores identity items on anchors', () => {
    const claims = generateClaims(
      [
        spec({
          anchor: true,
          identity: [{ feature: 'exact_username_or_name', p: 1 }],
          address: [
            { feature: 'e3_ownership_cue', p: 1, grade: 'C', originGroups: 2, copies: 4 },
            { feature: 'onchain_consistency', p: 0 },
          ],
        }),
      ],
      20,
      3,
    );
    for (const { claim } of claims) {
      const [path] = claim.paths;
      expect(path?.identity).toEqual([]);
      expect(path?.address.map((i) => i.originGroup)).toEqual([
        'acct:calibration:0',
        'acct:calibration:1',
        'acct:calibration:0',
        'acct:calibration:1',
      ]);
    }
  });

  it('draws fractional labels as Bernoulli and fixed labels exactly', () => {
    const claims = generateClaims(
      [spec({ id: 'half', label: 0.5 }), spec({ id: 'one', label: 1 }), spec({ id: 'zero', label: 0 })],
      3000,
      5,
    );
    const rate = (id: string): number => {
      const own = claims.filter((c) => c.scenario === id);
      return own.reduce((s, c) => s + c.label, 0) / own.length;
    };
    expect(rate('one')).toBe(1);
    expect(rate('zero')).toBe(0);
    expect(rate('half')).toBeGreaterThan(0.44);
    expect(rate('half')).toBeLessThan(0.56);
  });

  it('oracle scenarios follow the weights: priors, anchor probability and m / u = BF′', () => {
    const specs = oracleScenarios(w);
    expect(specs).toHaveLength(8);
    expect(specs.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 12);
    const truth = specs.find((s) => s.id === 'oracle:enumerated:id1:addr1');
    const lie = specs.find((s) => s.id === 'oracle:enumerated:id0:addr0');
    const m = truth?.address.find((f) => f.feature === 'e3_ownership_cue')?.p ?? 0;
    const u = lie?.address.find((f) => f.feature === 'e3_ownership_cue')?.p ?? 0;
    expect(m / u).toBeCloseTo(0.6 * 8 + 0.4, 9);
    expect(specs.filter((s) => s.anchor).every((s) => s.identity.length === 0)).toBe(true);
  });

  it('parses the committed scenario file and rejects malformed ones', () => {
    const { scenarios } = parseScenarios(readFileSync(join(FIXTURES, 'scenarios.v1.yaml'), 'utf8'));
    expect(scenarios.map((s) => s.id)).toContain('mirrored_duplicates');
    for (const s of scenarios) {
      for (const f of [...s.identity, ...s.address]) expect(w.features.has(f.feature)).toBe(true);
    }
    expect(() => parseScenarios('version: x\nscenarios: []')).toThrow(/non-empty/);
    expect(() =>
      parseScenarios(
        'version: x\nscenarios:\n  - { id: a, label: 2, weight: 1, relation: SELF_DECLARED, anchor: true }',
      ),
    ).toThrow(/label/);
    expect(() =>
      parseScenarios(
        'version: x\nscenarios:\n  - { id: a, label: 1, weight: 1, relation: THIRD_PARTY_ATTRIBUTION, anchor: true }',
      ),
    ).toThrow(/not assessed/);
  });

  it('parses the persona set', () => {
    const { cases } = parsePersonaSet(readFileSync(join(FIXTURES, 'persona.v1.yaml'), 'utf8'));
    expect(cases.map((c) => [c.id, c.expected])).toEqual([
      ['BTC-1', 99],
      ['TRON-1', 77],
      ['ETH-2', 24],
      ['WORKED-TRON-1', 50],
      ['WORKED-COMBINED', 62],
    ]);
  });
});
