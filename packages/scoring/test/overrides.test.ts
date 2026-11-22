import { addressKey, type AnalystJudgement, type AnalystOverride, type LinkAssessment } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyOverrides,
  buildClaims,
  latestJudgement,
  overridesAt,
  overridesVersion,
  scoreRun,
  type FeatureExtractionInput,
  type ScoringWeights,
} from '../src/index.ts';
import { clock, idSequence, v2 } from './fixtures/helpers.ts';
import { personaInputs, slot, type PersonaOptions } from './fixtures/persona-inputs.ts';

let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const score = (input: FeatureExtractionInput) => scoreRun(input, w, { clock, newId: idSequence() });

function link(assessments: LinkAssessment[], slotName: string): LinkAssessment {
  const ref = slot(slotName);
  const key = addressKey({
    chain: ref.chain,
    address: ref.chain.startsWith('evm:') ? ref.address.toLowerCase() : ref.address,
  });
  const found = assessments.find((a) => addressKey(a.address) === key);
  if (!found) throw new Error(`no assessment for ${slotName}`);
  return found;
}

let seq = 0;
function override(kind: AnalystOverride['kind'], value: string, target: AnalystOverride['target']): AnalystOverride {
  seq += 1;
  const n = String(seq).padStart(2, '0');
  return {
    id: `0190a000-0000-7000-8000-0000000000${n}`,
    caseId: 'case-persona',
    kind,
    target,
    value,
    justification: 'Uzasadnienie analityka na danych syntetycznych',
    analyst: 'Analityk Testowy',
    at: `2026-11-21T11:${n}:00.000Z`,
  };
}

/** The persona with the Wykop mention of TRON-1 as a gap-joined (review-required) match. */
function withRepairedWykopMention(opts: PersonaOptions = {}): FeatureExtractionInput {
  const input = personaInputs(opts);
  for (const c of input.extractions.flatMap((e) => e.candidates)) {
    if (c.id === 'cand-wykop') Object.assign(c, { reviewRequired: true, transforms: ['gap_joined'] });
  }
  return input;
}

const wykopPath = (l: LinkAssessment) => l.paths.find((p) => p.accountId === 'acc-wykop');
/** Origin groups of the items of one feature in a hop. */
const origins = (hop: LinkAssessment['paths'][number]['addressHop'], feature: string) =>
  hop.contributions.filter((c) => c.feature === feature).map((c) => c.originGroup);
const e1 = (l: LinkAssessment) =>
  l.paths[0]?.addressHop.contributions.find((c) => c.feature === 'e1_cryptographic_binding');
const judgement = (id: string, at: string): AnalystJudgement => ({
  id,
  linkAssessmentId: 'link-1',
  judgement: 'unsure',
  justification: 'Uzasadnienie testowe',
  analyst: 'Analityk Testowy',
  at,
});

describe('applyOverrides', () => {
  it('changes nothing without overrides', () => {
    const input = personaInputs();
    expect(score(applyOverrides(input, []))).toEqual(score(input));
  });

  it('counts an F-graded item only after an analyst grade, and only in the rescore (ρ 0.8 for B)', () => {
    const input = personaInputs({ grades: { fixture_site: 'F' } });
    const signed = input.observations.find((o) => o.property === 'post.signed_message.address');
    expect(signed).toBeDefined();

    const original = link(score(input).assessments, 'BTC-1');
    expect(e1(original)).toMatchObject({ reliability: 'F', counted: false, uncountedReason: 'ungraded' });

    const rescored = link(
      score(applyOverrides(input, [override('reliability_grade', 'B', { observationId: signed!.id })])).assessments,
      'BTC-1',
    );
    expect(e1(rescored)).toMatchObject({ reliability: 'B', rho: 0.8, counted: true });
    expect(e1(rescored)?.detail).toContain('grade set by analyst: Analityk Testowy');
    expect(rescored.score).toBeGreaterThan(original.score);
    // The original assessment is not touched by scoring the overridden input.
    expect(e1(original)).toMatchObject({ reliability: 'F', counted: false });
  });

  it('applies a source grade to every item of the source, and a more specific grade over it', () => {
    const input = personaInputs({ grades: { fixture_site: 'F' } });
    const signed = input.observations.find((o) => o.property === 'post.signed_message.address')!;
    const btc1 = link(
      score(
        applyOverrides(input, [
          override('reliability_grade', 'A', { observationId: signed.id }),
          override('reliability_grade', 'C', { sourceId: 'fixture_site' }),
        ]),
      ).assessments,
      'BTC-1',
    );
    const grades = btc1.paths[0]?.addressHop.contributions.map((c) => [c.feature, c.reliability]);
    // The later source grade does not override the earlier, more specific observation grade.
    expect(grades).toEqual([
      ['e1_cryptographic_binding', 'A'],
      ['e2_self_assertion', 'C'],
    ]);
  });

  it('never sets grade F and ignores overrides without a valid target', () => {
    const input = personaInputs();
    const applied = applyOverrides(input, [
      override('reliability_grade', 'F', { sourceId: 'fixture_site' }),
      override('reliability_grade', 'B', {}),
      override('reliability_grade', 'B', { sourceId: 'fixture_site', observationId: 'obs-001' }),
      override('review_decision', 'maybe', { candidateId: 'cand-wykop' }),
      override('add_evidence', 'e1_cryptographic_binding', { accountId: 'acc-wykop' }),
      override('add_evidence', 'onchain_consistency', { accountId: 'acc-wykop' }),
    ]);
    expect(applied.analyst).toEqual({ grades: [], reviews: [], evidence: [], cues: [] });
    expect(score(applied)).toEqual(score(input));
  });

  it('confirming a repaired match removes the review penalty; rejecting it removes its items', () => {
    const input = withRepairedWykopMention();
    const before = link(score(input).assessments, 'TRON-1');
    const features = (l: LinkAssessment) => wykopPath(l)?.addressHop.contributions.map((c) => c.feature);
    expect(features(before)).toContain('deobfuscated_or_ocr_repaired');

    const confirmed = link(
      score(applyOverrides(input, [override('review_decision', 'confirmed', { candidateId: 'cand-wykop' })]))
        .assessments,
      'TRON-1',
    );
    expect(features(confirmed)).toEqual(['e3_ownership_cue']);
    expect(wykopPath(confirmed)?.addressHop.contributions[0]?.detail).toContain('review confirmed by analyst');
    expect(confirmed.score).toBeGreaterThan(before.score);

    const rejected = scoreRun(
      applyOverrides(input, [override('review_decision', 'rejected', { candidateId: 'cand-wykop' })]),
      w,
      { clock, newId: idSequence() },
    );
    const tron1 = link(rejected.assessments, 'TRON-1');
    expect(wykopPath(tron1)).toBeUndefined();
    expect(tron1.paths.map((p) => p.service)).toEqual(['tablica']);
    expect(rejected.notes.some((n) => n.code === 'analyst_rejected_candidate')).toBe(true);
  });

  it('the latest decision on a candidate wins', () => {
    const input = withRepairedWykopMention();
    const tron1 = link(
      score(
        applyOverrides(input, [
          override('review_decision', 'rejected', { candidateId: 'cand-wykop' }),
          override('review_decision', 'confirmed', { candidateId: 'cand-wykop' }),
        ]),
      ).assessments,
      'TRON-1',
    );
    expect(wykopPath(tron1)?.addressHop.contributions.map((c) => c.feature)).toEqual(['e3_ownership_cue']);
  });

  it('finds a candidate of an earlier extraction again by capture and position', () => {
    const input = withRepairedWykopMention();
    const earlier = input.extractions.flatMap((e) => e.candidates).find((c) => c.id === 'cand-wykop')!;
    const applied = applyOverrides(
      input,
      [override('review_decision', 'confirmed', { candidateId: 'cand-from-run-1' })],
      { candidates: [{ ...earlier, id: 'cand-from-run-1' }] },
    );
    expect(applied.analyst?.reviews).toEqual([expect.objectContaining({ candidateId: 'cand-wykop' })]);
    const unknown = applyOverrides(input, [override('review_decision', 'confirmed', { candidateId: 'no-such' })]);
    expect(unknown.analyst?.reviews).toEqual([]);
  });

  it('adds a contradicting attribute to the identity hop: −1.32 bits (BF′ 0.4 at grade B), confidence Low', () => {
    const input = personaInputs();
    const before = link(score(input).assessments, 'TRON-1');
    const added = override('add_evidence', 'contradicting_attribute', { accountId: 'acc-wykop' });
    const after = link(score(applyOverrides(input, [added])).assessments, 'TRON-1');
    const item = wykopPath(after)?.identityHop.contributions.find((c) => c.feature === 'contradicting_attribute');
    expect(item).toMatchObject({
      reliability: 'B',
      rho: 0.8,
      counted: true,
      originGroup: `analyst:${added.id}`,
      evidence: {},
    });
    expect(item?.discountedBayesFactor).toBeCloseTo(0.4, 10);
    expect(item?.bits).toBeCloseTo(-1.3219, 4);
    expect(item?.detail).toBe(`analyst evidence: override ${added.id} by Analityk Testowy`);
    expect(wykopPath(after)!.identityHop.totalBits - wykopPath(before)!.identityHop.totalBits).toBeCloseTo(-1.3219, 4);
    expect(after.score).toBeLessThan(before.score);
    expect(after.analyticConfidence).toBe('Low');
  });

  it('adds address-hop evidence to the path of the account (second independent origin at grade B)', () => {
    const input = personaInputs();
    const tron1 = slot('TRON-1');
    const before = link(score(input).assessments, 'TRON-1');
    const added = override('add_evidence', 'second_independent_origin', { accountId: 'acc-wykop', address: tron1 });
    const after = link(score(applyOverrides(input, [added])).assessments, 'TRON-1');
    const item = wykopPath(after)?.addressHop.contributions.find((c) => c.feature === 'second_independent_origin');
    expect(item).toMatchObject({ reliability: 'B', counted: true, originGroup: `analyst:${added.id}` });
    expect(item?.bits).toBeCloseTo(Math.log2(0.8 * 8 + 0.2), 10);
    expect(after.score).toBeGreaterThan(before.score);
    // Relation and tier come from the collected evidence only.
    expect([after.relation, after.tier]).toEqual([before.relation, before.tier]);
  });

  it('counts one active analyst item per account, address and feature: the latest override wins', () => {
    const input = personaInputs();
    const tron1 = slot('TRON-1');
    const first = override('add_evidence', 'second_independent_origin', { accountId: 'acc-wykop', address: tron1 });
    const again = override('add_evidence', 'second_independent_origin', { accountId: 'acc-wykop', address: tron1 });
    const contradicting = override('add_evidence', 'contradicting_attribute', { accountId: 'acc-wykop' });
    const contradictingAgain = override('add_evidence', 'contradicting_attribute', { accountId: 'acc-wykop' });
    const once = wykopPath(link(score(applyOverrides(input, [first, contradicting])).assessments, 'TRON-1'))!;
    const repeated = wykopPath(
      link(score(applyOverrides(input, [first, again, contradicting, contradictingAgain])).assessments, 'TRON-1'),
    )!;
    expect(origins(repeated.addressHop, 'second_independent_origin')).toEqual([`analyst:${again.id}`]);
    expect(origins(repeated.identityHop, 'contradicting_attribute')).toEqual([`analyst:${contradictingAgain.id}`]);
    // Saving the same evidence again adds no weight.
    expect(repeated.addressHop.totalBits).toBeCloseTo(once.addressHop.totalBits, 10);
    expect(repeated.identityHop.totalBits).toBeCloseTo(once.identityHop.totalBits, 10);
    // The same feature on another account's path is another item.
    const tablica = override('add_evidence', 'second_independent_origin', { accountId: 'acc-tablica', address: tron1 });
    const both = link(score(applyOverrides(input, [first, tablica])).assessments, 'TRON-1');
    const withItem = both.paths.filter((p) =>
      p.addressHop.contributions.some((c) => c.feature === 'second_independent_origin'),
    );
    expect(withItem.map((p) => p.service)).toEqual(['tablica', 'wykop']);
  });

  it('a rejected match stays rejected: another page cannot confirm its observation', () => {
    const input = personaInputs();
    const field = input.observations.find((o) => o.property === 'profile.bitcoin_address')!;
    const fieldItem = (l: LinkAssessment) =>
      l.paths.flatMap((p) => p.addressHop.contributions).find((c) => c.evidence.observationId === field.id);
    expect(fieldItem(link(score(input).assessments, 'BTC-1'))).toBeDefined();
    // The profile page's match is rejected; the same address is still matched on the signed post's page.
    const { assessments, notes } = scoreRun(
      applyOverrides(input, [override('review_decision', 'rejected', { candidateId: 'cand-profile' })]),
      w,
      { clock, newId: idSequence() },
    );
    const btc1 = link(assessments, 'BTC-1');
    expect(fieldItem(btc1)).toBeUndefined();
    expect(btc1.paths[0]?.addressHop.contributions.find((c) => c.feature === 'e1_cryptographic_binding')).toMatchObject(
      {
        counted: true,
      },
    );
    expect(notes).toContainEqual(
      expect.objectContaining({ code: 'analyst_rejected_candidate', observationId: field.id }),
    );
  });

  it('notes analyst evidence that matches no path of this run', () => {
    const input = personaInputs();
    const { notes } = buildClaims(
      applyOverrides(input, [
        override('add_evidence', 'onchain_consistency', { accountId: 'acc-github', address: slot('TRON-1') }),
        override('add_evidence', 'contradicting_attribute', { accountId: 'acc-bt-persona' }),
        override('add_evidence', 'contradicting_attribute', { accountId: 'acc-unknown' }),
      ]),
      w,
    );
    expect(notes.filter((n) => n.code === 'analyst_evidence_unmatched')).toHaveLength(3);
  });
});

describe('override versions and judgements', () => {
  const a = override('reliability_grade', 'B', { sourceId: 'fixture_site' });
  const b = override('reliability_grade', 'C', { sourceId: 'fixture_site' });

  it('labels the overrides a run applies and selects them by time', () => {
    expect(overridesVersion([])).toBe('overrides@0');
    expect(overridesVersion([b, a])).toBe(`overrides@2:${b.id}`);
    expect(overridesAt([b, a], a.at)).toEqual([a]);
    expect(overridesAt([b, a], '2030-01-01T00:00:00.000Z')).toEqual([a, b]);
  });

  it('the current judgement is the latest by time, then id', () => {
    const first = judgement('0190a000-0000-7000-8000-000000000001', '2026-11-21T10:00:00.000Z');
    const second = judgement('0190a000-0000-7000-8000-000000000002', '2026-11-21T10:05:00.000Z');
    const third = judgement('0190a000-0000-7000-8000-000000000003', '2026-11-21T10:05:00.000Z');
    expect(latestJudgement([third, first, second])).toBe(third);
    expect(latestJudgement([])).toBeUndefined();
  });
});
