import { addressKey, newId, type AddressCluster } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { scoreRun, type ScoringWeights } from '../src/index.ts';
import { clock, idSequence, v2 } from './fixtures/helpers.ts';
import { personaInputs, slot } from './fixtures/persona-inputs.ts';

let w: ScoringWeights;
beforeAll(async () => {
  w = await v2();
});

const cluster = (seeds: string[], members: string[]): AddressCluster => ({
  id: 'c_0123456789abcdef',
  runId: newId(),
  chain: 'bitcoin',
  heuristic: 'co_spend',
  algorithmVersion: 'cospend.v1',
  seeds,
  members,
  size: members.length,
  mergeEvidence: [],
  skipped: [],
  serviceMembers: [],
  flags: { serviceMerge: false, capped: false },
});

const run = (clusters: AddressCluster[]) =>
  scoreRun({ ...personaInputs(), clusters }, w, { clock, newId: idSequence() });

describe('cluster-associated claims', () => {
  const seed = slot('BTC-1').address;
  const partner = 'bc1q-synthetic-cospend-partner';

  it('makes a member of a cluster seeded by a claimed address a lead with no score', () => {
    const base = run([]).assessments;
    const { assessments } = run([cluster([seed], [seed, partner])]);
    expect(assessments).toHaveLength(base.length + 1);
    const link = assessments.find((a) => addressKey(a.address) === `bitcoin:${partner}`);
    expect(link).toMatchObject({ relation: 'CLUSTER_ASSOCIATED', score: 0, icd203: 'not assessed', paths: [] });
    expect(link?.gates.find((g) => g.gate === 'relation')?.passed).toBe(false);
    // The seed keeps its own assessment unchanged.
    const before = base.find((a) => addressKey(a.address) === `bitcoin:${seed}`);
    const after = assessments.find((a) => addressKey(a.address) === `bitcoin:${seed}`);
    expect(after?.score).toBe(before?.score);
  });

  it('ignores a cluster whose seed is not an address the subject claims', () => {
    const { assessments } = run([cluster(['bc1q-synthetic-unclaimed'], ['bc1q-synthetic-unclaimed', partner])]);
    expect(assessments.some((a) => a.relation === 'CLUSTER_ASSOCIATED')).toBe(false);
  });

  it('adds one claim per member, however many clusters list it', () => {
    const base = run([]).assessments;
    const { assessments } = run([cluster([seed], [seed, partner]), cluster([seed], [seed, partner, `${partner}-2`])]);
    expect(assessments.filter((a) => a.relation === 'CLUSTER_ASSOCIATED')).toHaveLength(2);
    expect(assessments).toHaveLength(base.length + 2);
  });
});
