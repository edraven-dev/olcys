import { addressKey, type LinkAssessment } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildClaims, normaliseHandle, scoreRun, type ScoringWeights } from '../src/index.ts';
import { clock, idSequence, v1, v2 } from './fixtures/helpers.ts';
import {
  capture,
  candidate,
  exclusion,
  MANIFEST,
  personaInputs,
  slot,
  URLS,
  type PersonaOptions,
} from './fixtures/persona-inputs.ts';

let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const run = (opts: PersonaOptions = {}, weights?: ScoringWeights) =>
  scoreRun(personaInputs(opts), weights ?? w, { clock, newId: idSequence() });

function link(assessments: LinkAssessment[], slotName: string, relation?: string): LinkAssessment {
  const ref = slot(slotName);
  const key = addressKey({
    chain: ref.chain,
    address: ref.chain.startsWith('evm:') ? ref.address.toLowerCase() : ref.address,
  });
  const found = assessments.find((a) => addressKey(a.address) === key && (!relation || a.relation === relation));
  if (!found) throw new Error(`no assessment for ${slotName}`);
  return found;
}

const has = (assessments: LinkAssessment[], slotName: string): boolean => {
  try {
    link(assessments, slotName);
    return true;
  } catch {
    return false;
  }
};

const expectedScore = (slotName: string): number | null | undefined =>
  MANIFEST.expected.v1.links.find((l) => l.slot === slotName)?.score;

describe('persona v1', () => {
  it('scores the persona links as the fixture manifest expects (BTC-1 99, TRON-1, ETH-2 24)', () => {
    const { assessments } = run();
    const btc1 = link(assessments, 'BTC-1');
    expect([btc1.score, btc1.relation, btc1.tier, btc1.band, btc1.analyticConfidence]).toEqual([
      99,
      'SELF_DECLARED',
      'E1',
      'BARDZO_WYSOKIE',
      'High',
    ]);
    expect(
      btc1.paths[0]?.addressHop.contributions
        .filter((c) => c.counted)
        .map((c) => [c.feature, c.reliability, c.originGroup]),
    ).toEqual([
      ['e1_cryptographic_binding', 'A', 'acct:bitcointalk:900001'],
      ['e2_self_assertion', 'B', 'acct:bitcointalk:900001'],
    ]);
    const eth2 = link(assessments, 'ETH-2');
    expect([eth2.score, eth2.relation, eth2.tier, eth2.band, eth2.analyticConfidence]).toEqual([
      24,
      'SELF_DECLARED',
      'E1',
      'NISKIE',
      'Low',
    ]);
    const tron1 = link(assessments, 'TRON-1');
    expect([tron1.relation, tron1.tier, tron1.band, tron1.icd203]).toEqual([
      'SELF_DECLARED',
      'E3',
      'PRAWDOPODOBNE',
      'likely',
    ]);
    expect(tron1.score).toBe(expectedScore('TRON-1'));
    expect(expectedScore('BTC-1')).toBe(99);
    expect(expectedScore('ETH-2')).toBe(24);
  });

  it('TRON-1: two independent sources add up (trace synergy)', () => {
    const tron1 = link(run().assessments, 'TRON-1');
    const [tablica, wykop] = tron1.paths;
    expect(tron1.paths.map((p) => [p.service, p.counted])).toEqual([
      ['tablica', true],
      ['wykop', true],
    ]);
    // P2P ad: login, display name and seller name match (one family: counted once), contact e-mail = input e-mail.
    expect(tablica?.identityHop.contributions.map((c) => [c.feature, c.counted])).toEqual([
      ['contact_email_match', true],
      ['exact_username_or_name', true],
      ['exact_username_or_name', false],
      ['exact_username_or_name', false],
    ]);
    expect(tablica?.identityHop.probability).toBeCloseTo(0.943059, 5);
    // Social profile linking to the forum anchor: the worked example's 50.
    expect(wykop?.probability).toBeCloseTo(0.50452834, 7);
    expect(tron1.synergy).toEqual({
      independentSources: ['tablica', 'wykop'],
      bestSingleScore: 53,
      bonusPoints: 24,
      repeatedPaths: 0,
      repeatedItems: 2,
    });
    expect(tron1.analyticConfidence).toBe('Low');
  });

  it('rejects misattributions: deposit, contract, third-party warning; third-party listings make no claim', () => {
    const { assessments, notes } = run({
      exclusions: [
        exclusion('ETH-1', 'A4', {
          outcome: 'reclassified',
          relation: 'CUSTODIAL_EXCHANGE',
          evidence: { kappa: 0.98875 },
        }),
        exclusion('CONTRACT-1', 'A2'),
        exclusion('HOT-1', 'A1'),
      ],
    });
    const eth1 = link(assessments, 'ETH-1');
    expect([eth1.relation, eth1.score, eth1.band, eth1.ungated?.score]).toEqual([
      'CUSTODIAL_EXCHANGE',
      0,
      'WYKLUCZENIE',
      56,
    ]);
    expect(eth1.gates.filter((g) => !g.passed).map((g) => g.gate)).toEqual(['relation', 'exclusion']);
    expect(eth1.gates.find((g) => g.gate === 'exclusion')?.detail).toContain('κ=0.98875');
    const contract = link(assessments, 'CONTRACT-1');
    expect([contract.relation, contract.score, contract.band, contract.ungated?.score]).toEqual([
      'MENTION_UNCLEAR',
      0,
      'WYKLUCZENIE',
      28,
    ]);
    const tron2 = link(assessments, 'TRON-2');
    expect([tron2.relation, tron2.tier, tron2.score, tron2.icd203, tron2.paths]).toEqual([
      'THIRD_PARTY_ATTRIBUTION',
      'E4',
      0,
      'not assessed',
      [],
    ]);
    expect(assessments.filter((a) => addressKey(a.address) === addressKey(tron2.address))).toHaveLength(1);
    for (const name of ['HOT-1', 'LISTING-01', 'LISTING-02']) expect(has(assessments, name)).toBe(false);
    expect(notes.filter((n) => n.code === 'no_identity_path')).toHaveLength(3);
    expect(assessments.map((a) => addressKey(a.address))).toEqual(
      assessments.map((a) => addressKey(a.address)).toSorted(),
    );
  });

  it('without exclusion decisions the contract mention scores as an unclear mention', () => {
    const contract = link(run().assessments, 'CONTRACT-1');
    expect([contract.score, contract.band, contract.relation]).toEqual([28, 'NISKIE', 'MENTION_UNCLEAR']);
  });
});

describe('persona v2 (wallet swap on the profile)', () => {
  it('BTC-2 enters with the profile field only (86); BTC-1 keeps its signed message (99)', () => {
    const { assessments } = run({ variant: 'v2' });
    const btc2 = link(assessments, 'BTC-2');
    expect([btc2.score, btc2.tier, btc2.analyticConfidence]).toEqual([86, 'E2', 'Moderate']);
    expect(link(assessments, 'BTC-1').score).toBe(99);
    for (const l of MANIFEST.expected.v2.links) expect(link(assessments, l.slot).score).toBe(l.score);
  });
});

describe('evidence rules', () => {
  it('an invalid or unsupported signature gives no cryptographic binding', () => {
    const tampered = run({ signature: 'not-base64!' });
    expect(link(tampered.assessments, 'BTC-1').score).toBe(86);
    expect(tampered.notes.map((n) => n.code)).toContain('signature_unsupported_format');
    const sig = MANIFEST.signedMessages[0]?.signature ?? '';
    const flipped = `${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`;
    const invalid = run({ signature: flipped });
    expect(link(invalid.assessments, 'BTC-1').tier).toBe('E2');
    expect(invalid.notes.map((n) => n.code)).toContain('signature_invalid');
  });

  it('an archived copy of the same entry is one origin group: one item counted, score unchanged', () => {
    const input = personaInputs();
    input.captures.push(
      capture('cap-wayback', `https://web.archive.org/web/20261013000000/${URLS.wykop}`, {
        archive: { provider: 'wayback', snapshotTimestamp: '20261013000000', originalUrl: URLS.wykop },
      }),
    );
    input.extractions.push({
      captureId: 'cap-wayback',
      candidates: [candidate('cand-wayback', 'cap-wayback', 'TRON-1', ['first_person_owner'])],
      rejected: [],
      secrets: [],
      extractorVersion: 'test',
    });
    const tron1 = link(scoreRun(input, w, { clock, newId: idSequence() }).assessments, 'TRON-1');
    const wykop = tron1.paths.find((p) => p.service === 'wykop');
    expect(wykop?.addressHop.contributions.map((c) => [c.feature, c.counted, c.evidence.captureId])).toEqual([
      ['e3_ownership_cue', true, 'cap-wayback'],
      ['e3_ownership_cue', false, 'cap-wykop'],
    ]);
    expect(tron1.score).toBe(expectedScore('TRON-1'));
  });

  it('an observed address that no valid candidate confirms is not a feature', () => {
    const input = personaInputs();
    input.extractions = input.extractions.map((e) => (e.captureId === 'cap-funding' ? { ...e, candidates: [] } : e));
    const { assessments, notes } = scoreRun(input, w, { clock, newId: idSequence() });
    expect(has(assessments, 'ETH-2')).toBe(false);
    expect(notes.find((n) => n.code === 'observation_address_invalid')?.captureId).toBe('cap-funding');
  });

  it('a source graded F needs analyst grading before its evidence counts', () => {
    const { assessments } = run({ grades: { fixture_site: 'F' } });
    const btc1 = link(assessments, 'BTC-1');
    expect(btc1.paths[0]?.addressHop.contributions.every((c) => !c.counted && c.uncountedReason === 'ungraded')).toBe(
      true,
    );
    expect(btc1.gates.find((g) => g.gate === 'analyst_grading')?.passed).toBe(true);
    expect(btc1.score).toBe(20);
  });

  it('LLM suggestions never weigh: a gate records them and the scores do not change', () => {
    const base = run();
    const withLlm = run({ llmSuggestionsExcluded: 3 });
    expect(withLlm.assessments.map((a) => a.score)).toEqual(base.assessments.map((a) => a.score));
    expect(link(withLlm.assessments, 'BTC-1').gates.find((g) => g.gate === 'llm_zero_weight')?.detail).toContain('3');
  });

  it('is deterministic', () => {
    expect(buildClaims(personaInputs(), w)).toEqual(buildClaims(personaInputs(), w));
    expect(run()).toEqual(run());
  });

  it('under weights v1 the contact e-mail is not scored (the feature is new in v2)', async () => {
    const result = run({}, await v1());
    expect(link(result.assessments, 'TRON-1').score).toBe(57);
    expect(result.notes.map((n) => n.code)).toContain('feature_not_in_weights');
  });

  it('normalises handles', () => {
    expect(normaliseHandle('@Fikcyjny-Kacper')).toBe('fikcyjny_kacper');
    expect(normaliseHandle('fikcyjny..kacper')).toBe('fikcyjny_kacper');
  });
});
