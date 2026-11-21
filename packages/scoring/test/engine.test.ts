import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ExclusionDecision, LinkAssessment } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION,
  analyticConfidence,
  combinePaths,
  discount,
  enfsiTerm,
  icd203Term,
  parseWeights,
  scoreBand,
  scoreHop,
  scoreLink,
  weightsPath,
  type ClaimInput,
  type ScoringWeights,
} from '../src/index.ts';
import { clock, feature, idSequence, v1, v2 } from './fixtures/helpers.ts';
import { BTC1_PATH, claim, ETH2_PATH, TRON1_PATH, VECTORS } from './fixtures/worked-example.ts';

const close = (actual: number, expected: number, tolerance = 1e-6): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

function score(c: ClaimInput, w: ScoringWeights): LinkAssessment {
  const result = scoreLink(c, w, { clock, newId: idSequence() });
  if (!result.ok) throw new Error(result.reason);
  return result.assessment;
}

let w1: ScoringWeights;
let w2: ScoringWeights;
beforeAll(async () => {
  [w1, w2] = await Promise.all([v1(), v2()]);
});

describe('weights', () => {
  it('loads v1 with its SHA-256, scales and 16 features', async () => {
    const bytes = await readFile(weightsPath('weights.v1.yaml'));
    expect(w1.version).toBe('weights.v1');
    expect(w1.status).toBe('uncalibrated');
    expect(w1.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(w1.reliability.F).toBeNull();
    expect(w1.scales.enfsi.at(-1)?.maxLr).toBe(Number.POSITIVE_INFINITY);
    expect(w1.features.size).toBe(16);
    expect(w1.features.get('e3_ownership_cue')?.family).toBe('e3');
    expect(w1.features.get('e3_bare_mention')?.family).toBe('e3');
    expect(w1.features.get('listing_code_or_docs')?.family).toBe('listing_code_or_docs');
  });

  it('loads v2 by default: v1 plus the contact e-mail feature', () => {
    expect(w2.version).toBe('weights.v2');
    expect(w2.features.size).toBe(17);
    expect(w2.features.get('contact_email_match')).toMatchObject({
      hop: 'identity',
      bayesFactor: 64,
      defaultGrade: 'B',
    });
    for (const [key, f] of w1.features) expect(w2.features.get(key)).toEqual(f);
  });

  it('rejects inconsistent files', async () => {
    const text = await readFile(weightsPath('weights.v1.yaml'), 'utf8');
    const bad = (from: string, to: string) => () => parseWeights(new TextEncoder().encode(text.replace(from, to)));
    expect(bad('  A: 0.95', '  A: 0')).toThrow(/ρ must be in/);
    expect(bad('maxLr: .inf', 'maxLr: 1e9')).toThrow(/\.inf/);
    expect(bad('{ max: 0.20,', '{ max: 0.01,')).toThrow(/ascending/);
    expect(bad('bayesFactor: 1000', 'bayesFactor: -1')).toThrow(/bayesFactor/);
    expect(bad('status: uncalibrated', 'status: uncalibrated\nstatus: calibrated')).toThrow(/unique/i);
  });
});

const e1 = (group: string, captureId: string) =>
  feature('address', 'e1_cryptographic_binding', 'A', group, { captureId });

describe('hop arithmetic (worked example)', () => {
  it('BTC-1: anchor identity hop and e1 A + e2 B address hop → 99', () => {
    for (const w of [w1, w2]) {
      const identity = scoreHop('identity', [], w, { anchor: true });
      close(identity.priorBits, 6.629357);
      expect(identity.probability).toBe(0.99);
      expect(identity.contributions).toEqual([]);
      const address = scoreHop('address', BTC1_PATH.address, w);
      close(address.priorBits, -2);
      close(address.contributions[0]?.discountedBayesFactor ?? 0, 950.05);
      close(address.contributions[0]?.bits ?? 0, 9.89186);
      close(address.contributions[1]?.discountedBayesFactor ?? 0, 25.8);
      close(address.contributions[1]?.bits ?? 0, 4.689299);
      close(address.totalBits, VECTORS.btc1.addressBits);
      close(address.probability, VECTORS.btc1.addressP);
      close(address.likelihoodRatio, VECTORS.btc1.lr, 0.01);
      expect(address.enfsiVerbal).toBe('very strong support');
      const a = score(claim([BTC1_PATH]), w);
      close(a.probability, VECTORS.btc1.path);
      expect(a.score).toBe(99);
      expect(a.icd203).toBe('almost certain');
      expect(a.band).toBe('BARDZO_WYSOKIE');
    }
  });

  it('TRON-1 (single forum path): 50, roughly even chance', () => {
    const identity = scoreHop('identity', TRON1_PATH.identity, w1);
    close(identity.priorBits, -3.169925);
    close(identity.totalBits, VECTORS.tron1.identityBits);
    close(identity.probability, VECTORS.tron1.identityP);
    close(identity.likelihoodRatio, VECTORS.tron1.identityLr, 0.01);
    expect(identity.enfsiVerbal).toBe('moderate support');
    const address = scoreHop('address', TRON1_PATH.address, w1);
    close(address.contributions[0]?.bits ?? 0, 2.378512);
    close(address.totalBits, VECTORS.tron1.addressBits);
    close(address.probability, VECTORS.tron1.addressP);
    expect(address.enfsiVerbal).toBe('weak or limited support');
    const a = score(claim([TRON1_PATH], { tier: 'E3' }), w1);
    close(a.probability, VECTORS.tron1.path);
    expect([a.score, a.icd203, a.band]).toEqual([50, 'roughly even chance', 'SREDNIE']);
  });

  it('ETH-2 (same nick only, Drips claim): 24, unlikely', () => {
    const identity = scoreHop('identity', ETH2_PATH.identity, w1);
    close(identity.totalBits, VECTORS.eth2.identityBits);
    close(identity.probability, VECTORS.eth2.identityP);
    expect(identity.enfsiVerbal).toBe('weak or limited support');
    const address = scoreHop('address', ETH2_PATH.address, w1);
    close(address.totalBits, VECTORS.eth2.addressBits);
    close(address.probability, VECTORS.eth2.addressP);
    expect(address.enfsiVerbal).toBe('moderately strong support');
    const a = score(claim([ETH2_PATH]), w1);
    close(a.probability, VECTORS.eth2.path);
    expect([a.score, a.icd203, a.band]).toEqual([24, 'unlikely', 'NISKIE']);
  });

  it('two independent paths combine by noisy-OR: 62, likely, with visible trace synergy', () => {
    close(combinePaths([VECTORS.tron1.path, VECTORS.eth2.path]), VECTORS.combined.probability);
    const a = score(claim([TRON1_PATH, ETH2_PATH]), w1);
    close(a.probability, VECTORS.combined.probability);
    expect([a.score, a.icd203, a.band]).toEqual([62, 'likely', 'PRAWDOPODOBNE']);
    expect(a.synergy).toEqual({
      independentSources: ['github', 'wykop'],
      bestSingleScore: 50,
      bonusPoints: 12,
      repeatedPaths: 0,
      repeatedItems: 0,
    });
    expect(a.paths.map((p) => p.counted)).toEqual([true, true]);
  });

  it('repeats within one service do not add up', () => {
    const second = { ...TRON1_PATH, accountId: 'acct-2', originGroup: 'acct:wykop:alt' };
    const a = score(claim([TRON1_PATH, second]), w1);
    expect(a.score).toBe(50);
    expect(a.paths.map((p) => p.counted)).toEqual([true, false]);
    expect(a.synergy).toMatchObject({ independentSources: ['wykop'], bonusPoints: 0, repeatedPaths: 1 });
  });

  it('discounts by grade; grade F is not counted and gated for analyst grading', () => {
    expect(discount(8, 0.4)).toBeCloseTo(3.8, 12);
    const d = scoreHop('address', [feature('address', 'e3_ownership_cue', 'D', 'g')], w1);
    close(d.contributions[0]?.bits ?? 0, 1.925999);
    const f = scoreHop('address', [feature('address', 'e3_ownership_cue', 'F', 'g')], w1);
    expect(f.contributions[0]).toMatchObject({ counted: false, bits: 0, rho: 0, uncountedReason: 'ungraded' });
    const a = score(
      claim([{ ...TRON1_PATH, address: [...TRON1_PATH.address, feature('address', 'e2_self_assertion', 'F', 'x')] }]),
      w1,
    );
    expect(a.gates.find((g) => g.gate === 'analyst_grading')).toMatchObject({ passed: true });
  });

  it('counts only the strongest item per family per origin group', () => {
    const one = scoreHop('address', [e1('g1', 'c2'), e1('g1', 'c1')], w1);
    expect(one.contributions.map((c) => [c.evidence.captureId, c.counted, c.uncountedReason])).toEqual([
      ['c1', true, undefined],
      ['c2', false, 'same_origin_repeat'],
    ]);
    expect(scoreHop('address', [e1('g1', 'c1'), e1('g2', 'c2')], w1).contributions.every((c) => c.counted)).toBe(true);
    const e3 = scoreHop(
      'address',
      [feature('address', 'e3_bare_mention', 'C', 'g'), feature('address', 'e3_ownership_cue', 'C', 'g')],
      w1,
    );
    expect(e3.contributions.map((c) => [c.feature, c.counted])).toEqual([
      ['e3_ownership_cue', true],
      ['e3_bare_mention', false],
    ]);
  });

  it('throws on an unknown feature or a feature of the other hop', () => {
    expect(() => scoreHop('address', [feature('address', 'nope', 'A', 'g')], w1)).toThrow(/unknown/);
    expect(() => scoreHop('identity', [feature('identity', 'e1_cryptographic_binding', 'A', 'g')], w1)).toThrow(/hop/);
  });
});

describe('gates', () => {
  const a4: ExclusionDecision = {
    id: 'ex-1',
    runId: 'run-1',
    address: { chain: 'bitcoin', address: 'bc1qsynthetic0000000000000000000000000000' },
    ruleId: 'A4',
    outcome: 'reclassified',
    relation: 'CUSTODIAL_EXCHANGE',
    reason: 'deposit address sweeping to a labelled hot wallet',
    evidence: { kappa: 0.97 },
    rulesVersion: 'exclusion.v1',
  };

  it('an invalid checksum yields no claim; ownership without paths is not scored', () => {
    const invalid = scoreLink(
      claim([BTC1_PATH], { checksum: { scheme: 'bech32', present: true, valid: false, bits: 30 } }),
      w1,
      {
        clock,
        newId: idSequence(),
      },
    );
    expect(invalid).toEqual({ ok: false, reason: 'invalid_checksum' });
    expect(scoreLink(claim([]), w1, { clock, newId: idSequence() })).toEqual({ ok: false, reason: 'no_paths' });
  });

  it('a third-party attribution is a different relation: score 0, not assessed', () => {
    const a = score(claim([], { relation: 'THIRD_PARTY_ATTRIBUTION', tier: 'E4' }), w1);
    expect([a.score, a.probability, a.icd203, a.band, a.paths]).toEqual([0, 0, 'not assessed', 'WYKLUCZENIE', []]);
    expect(a.gates.find((g) => g.gate === 'relation')?.passed).toBe(false);
    expect(a.analyticConfidence).toBe('Low');
    expect(a.ungated).toBeUndefined();
  });

  it('an exclusion rejects the link: score 0, the arithmetic stays visible', () => {
    const a = score(claim([BTC1_PATH], { exclusions: [a4] }), w1);
    expect([a.score, a.band, a.icd203]).toEqual([0, 'WYKLUCZENIE', 'almost no chance']);
    expect(a.ungated).toMatchObject({ score: 99, icd203: 'almost certain' });
    expect(a.gates.find((g) => g.gate === 'exclusion')).toMatchObject({ passed: false });
    expect(a.gates.find((g) => g.gate === 'exclusion')?.detail).toContain(
      'A4 reclassified → CUSTODIAL_EXCHANGE, κ=0.97',
    );
    const kept = score(claim([BTC1_PATH], { exclusions: [{ ...a4, outcome: 'flagged' }] }), w1);
    expect([kept.score, kept.gates.find((g) => g.gate === 'exclusion')?.passed]).toEqual([99, true]);
  });

  it('a custodial-exchange relation is computed (KYC lead) but never presented as a holding', () => {
    const a = score(claim([TRON1_PATH], { relation: 'CUSTODIAL_EXCHANGE', tier: 'E3' }), w1);
    expect([a.score, a.band, a.ungated?.score]).toEqual([0, 'WYKLUCZENIE', 50]);
  });

  it('records the informational gates and versions', () => {
    const a = score(claim([BTC1_PATH], { reviewRequired: true, llmSuggestionsExcluded: 3 }), w2);
    expect(a.gates.map((g) => [g.gate, g.passed])).toEqual([
      ['relation', true],
      ['checksum', true],
      ['identity_anchor', true],
      ['review_required', true],
      ['llm_zero_weight', true],
    ]);
    expect(a.gates.find((g) => g.gate === 'checksum')?.detail).toBe('bech32, 30 bits');
    expect(a.gates.find((g) => g.gate === 'llm_zero_weight')?.detail).toContain('3');
    expect(a.score).toBe(99);
    expect(a).toMatchObject({
      algorithmVersion: ALGORITHM_VERSION,
      weightsVersion: 'weights.v2',
      weightsSha256: w2.sha256,
      rulesVersion: 'relations.v1',
      computedAt: '2026-11-21T12:00:00.000Z',
    });
  });
});

describe('scales and bands', () => {
  it('maps probabilities to ICD 203 terms and likelihood ratios to ENFSI terms', () => {
    expect(icd203Term(0.05, w1)).toBe('almost no chance');
    expect(icd203Term(0.0500001, w1)).toBe('very unlikely');
    expect(icd203Term(0.55, w1)).toBe('roughly even chance');
    expect(icd203Term(1, w1)).toBe('almost certain');
    expect(enfsiTerm(1, w1)).toBe('no support');
    expect(enfsiTerm(10, w1)).toBe('weak or limited support');
    expect(enfsiTerm(10.0001, w1)).toBe('moderate support');
    expect(enfsiTerm(1e7, w1)).toBe('extremely strong support');
  });

  it('maps scores to the cheat-sheet bands', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 10, 9, 0].map((s) => scoreBand(s))).toEqual([
      'BARDZO_WYSOKIE',
      'BARDZO_WYSOKIE',
      'PRAWDOPODOBNE',
      'PRAWDOPODOBNE',
      'SREDNIE',
      'SREDNIE',
      'NISKIE',
      'NISKIE',
      'NISKIE',
      'NISKIE',
    ]);
    expect(scoreBand(0, true)).toBe('WYKLUCZENIE');
  });
});

const confidence = (c: ClaimInput): string => analyticConfidence(score(c, w1).paths, c);

describe('analytic confidence', () => {
  it('High for a cryptographic binding on an anchor; Low for mention-grade or same-nick evidence', () => {
    expect(confidence(claim([BTC1_PATH]))).toBe('High');
    expect(confidence(claim([TRON1_PATH]))).toBe('Low');
    expect(confidence(claim([ETH2_PATH]))).toBe('Low');
    expect(confidence(claim([{ ...BTC1_PATH, address: [feature('address', 'e2_self_assertion', 'B', 'g')] }]))).toBe(
      'Moderate',
    );
    expect(confidence(claim([BTC1_PATH], { reviewRequired: true }))).toBe('Low');
  });
});
