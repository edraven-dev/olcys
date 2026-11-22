import { createHash } from 'node:crypto';
import type {
  AddressCandidate,
  AnalystOverride,
  LinkAssessment,
  Observation,
  OnlineAccount,
  RunWithProgress,
} from '@olcys/core';
import { canonicalJson, newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ADDRESS, ANALYST, analystStages, newCase, silent } from './analyst-fixtures.ts';

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let caseId: string;
let run1: string;
let wallet: Observation;
let repaired: AddressCandidate;
let plain: AddressCandidate;
let social: OnlineAccount;

const JUSTIFICATION = 'Korekta analityka na danych syntetycznych';
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const post = (payload: unknown, id = caseId) =>
  app.inject({ method: 'POST', url: `/api/cases/${id}/overrides`, payload: payload as object });
const links = async (runId: string) => (await app.inject(`/api/runs/${runId}/links`)).json().items as LinkAssessment[];
const linkOf = (items: LinkAssessment[], address: string) => items.find((l) => l.address.address === address)!;
const features = (l: LinkAssessment) => l.paths.flatMap((p) => p.addressHop.contributions.map((c) => c.feature));
/** The item of the wallet field observation in a link's address hops. */
const walletField = (l: LinkAssessment) =>
  l.paths.flatMap((p) => p.addressHop.contributions).find((c) => c.evidence.observationId === wallet.id);
const startRun = async (payload: object): Promise<RunWithProgress> => {
  const id = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload })).json().id as string;
  await runtime.idle();
  return (await app.inject(`/api/runs/${id}`)).json() as RunWithProgress;
};

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: (rt) => analystStages(rt.sources),
  });
  app = buildApp({ ...runtime, analyst: ANALYST });
  caseId = (await app.inject({ method: 'POST', url: '/api/cases', payload: newCase })).json().id as string;
  run1 = (await startRun({})).id;
  const observations = (await app.inject(`/api/runs/${run1}/observations`)).json().items as Observation[];
  wallet = observations.find((o) => o.property === 'profile.bitcoin_address')!;
  const candidates = (await app.inject(`/api/runs/${run1}/candidates`)).json().items as AddressCandidate[];
  repaired = candidates.find((c) => c.reviewRequired)!;
  plain = candidates.find((c) => !c.reviewRequired)!;
  const accounts = (await app.inject(`/api/runs/${run1}/accounts`)).json().items as OnlineAccount[];
  social = accounts.find((a) => a.platform === 'wykop')!;
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('analyst overrides', () => {
  it('refuses values and targets the kind does not allow', async () => {
    const cases: [object, number, string][] = [
      [{ kind: 'reliability_grade', value: 'F', target: { observationId: wallet.id } }, 422, 'grade_not_allowed'],
      [{ kind: 'reliability_grade', value: 'Z', target: { observationId: wallet.id } }, 422, 'invalid_value'],
      [{ kind: 'reliability_grade', value: 'B', target: {} }, 422, 'invalid_target'],
      [
        { kind: 'reliability_grade', value: 'B', target: { observationId: wallet.id, sourceId: 'bitcointalk' } },
        422,
        'invalid_target',
      ],
      [{ kind: 'reliability_grade', value: 'B', target: { observationId: newId() } }, 422, 'target_not_found'],
      [{ kind: 'reliability_grade', value: 'B', target: { sourceId: 'keybase' } }, 422, 'target_not_found'],
      [
        { kind: 'review_decision', value: 'confirmed', target: { candidateId: plain.id } },
        422,
        'candidate_not_review_required',
      ],
      [{ kind: 'review_decision', value: 'maybe', target: { candidateId: repaired.id } }, 422, 'invalid_value'],
      [
        { kind: 'add_evidence', value: 'e1_cryptographic_binding', target: { accountId: social.id } },
        422,
        'feature_not_allowed',
      ],
      [{ kind: 'add_evidence', value: 'onchain_consistency', target: { accountId: social.id } }, 422, 'invalid_target'],
      [
        {
          kind: 'add_evidence',
          value: 'second_independent_origin',
          target: { accountId: social.id, address: { chain: 'bitcoin', address: 'bc1qnieznanyadres' } },
        },
        422,
        'target_not_found',
      ],
      [{ kind: 'nothing', value: 'B', target: {} }, 400, 'invalid_input'],
    ];
    for (const [body, status, code] of cases) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await post({ ...body, justification: JUSTIFICATION });
      expect([JSON.stringify(body), response.statusCode, response.json().error]).toEqual([
        JSON.stringify(body),
        status,
        code,
      ]);
    }
    const short = await post({
      kind: 'reliability_grade',
      value: 'B',
      target: { sourceId: 'bitcointalk' },
      justification: 'krótko',
    });
    expect([short.statusCode, short.json().error]).toEqual([422, 'justification_too_short']);
    expect((await post({}, newId())).statusCode).toBe(404);
    expect((await app.inject(`/api/cases/${caseId}/overrides`)).json().items).toEqual([]);
  });

  it('changes nothing until a rescore; the rescore applies the overrides recorded before it was queued', async () => {
    const before = await links(run1);
    const created: AnalystOverride[] = [];
    for (const body of [
      { kind: 'reliability_grade', value: 'E', target: { observationId: wallet.id } },
      { kind: 'review_decision', value: 'confirmed', target: { candidateId: repaired.id } },
      {
        kind: 'add_evidence',
        value: 'contradicting_attribute',
        target: { accountId: social.id },
        analyst: 'ktoś inny',
      },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await post({ ...body, justification: JUSTIFICATION });
      expect(response.statusCode).toBe(201);
      created.push(response.json() as AnalystOverride);
    }
    expect(created.map((o) => o.analyst)).toEqual([ANALYST, ANALYST, ANALYST]);
    const listed = (await app.inject(`/api/cases/${caseId}/overrides`)).json().items as AnalystOverride[];
    expect(listed.map((o) => o.id)).toEqual(created.map((o) => o.id));
    // Recording overrides changes no stored assessment.
    expect(digest(await links(run1))).toBe(digest(before));

    const rescore = await startRun({ trigger: 'rescore', rescoreOfRunId: run1 });
    expect(rescore).toMatchObject({ status: 'succeeded', trigger: 'rescore', rescoreOfRunId: run1 });
    expect(rescore.config.rulesVersions['overrides']).toBe(`overrides@3:${created[2]!.id}`);
    const after = await links(rescore.id);

    // Grade E for the wallet field (ρ 0.2), named in the item's detail.
    const walletBefore = linkOf(before, ADDRESS.wallet);
    const walletAfter = linkOf(after, ADDRESS.wallet);
    expect(walletField(walletBefore)).toMatchObject({ reliability: 'B', rho: 0.8 });
    expect(walletField(walletAfter)).toMatchObject({ reliability: 'E', rho: 0.2 });
    expect(walletField(walletAfter)?.detail).toContain(`grade set by analyst: ${ANALYST}`);

    // Analyst evidence on the social account's identity hop.
    const socialPath = walletAfter.paths.find((p) => p.accountId === social.id);
    const contradicting = socialPath?.identityHop.contributions.find((c) => c.feature === 'contradicting_attribute');
    expect(contradicting).toMatchObject({ counted: true, reliability: 'B', originGroup: `analyst:${created[2]!.id}` });
    expect(contradicting?.bits).toBeCloseTo(-1.3219, 4);
    expect(walletAfter.score).toBeLessThan(walletBefore.score);

    // The confirmed repaired match: re-extracted under a new id, found again, review penalty and gate gone.
    const repairedBefore = linkOf(before, ADDRESS.repaired);
    const repairedAfter = linkOf(after, ADDRESS.repaired);
    expect(features(repairedBefore)).toContain('deobfuscated_or_ocr_repaired');
    expect(features(repairedAfter)).not.toContain('deobfuscated_or_ocr_repaired');
    expect(repairedBefore.gates.map((g) => g.gate)).toContain('review_required');
    expect(repairedAfter.gates.map((g) => g.gate)).not.toContain('review_required');
    expect(repairedAfter.score).toBeGreaterThan(repairedBefore.score);

    // Both assessments stay retrievable, the original one unchanged.
    expect(digest(await links(run1))).toBe(digest(before));
    expect(after.every((l) => l.runId === rescore.id)).toBe(true);
  });

  it('ignores overrides in collecting runs and those recorded after a rescore was queued', async () => {
    const collecting = await startRun({});
    expect(collecting.config.rulesVersions['overrides']).toBeUndefined();
    const field = linkOf(await links(collecting.id), ADDRESS.wallet).paths.flatMap((p) => p.addressHop.contributions);
    expect(field.find((c) => c.feature === 'e2_self_assertion')).toMatchObject({ reliability: 'B' });

    const earlier = await startRun({ trigger: 'rescore', rescoreOfRunId: run1 });
    const earlierLinks = await links(earlier.id);
    const late = await post({
      kind: 'reliability_grade',
      value: 'A',
      target: { sourceId: 'wykop' },
      justification: JUSTIFICATION,
    });
    expect(late.statusCode).toBe(201);
    expect(earlier.config.rulesVersions['overrides']).toMatch(/^overrides@3:/);
    expect(digest(await links(earlier.id))).toBe(digest(earlierLinks));

    const next = await startRun({ trigger: 'rescore', rescoreOfRunId: earlier.id });
    // A rescore of a rescore still analyses the evidence of the run that collected it.
    expect(next).toMatchObject({ rescoreOfRunId: run1, previousRunId: earlier.id });
    expect(next.config.rulesVersions['overrides']).toBe(`overrides@4:${late.json().id}`);
    const socialPath = linkOf(await links(next.id), ADDRESS.wallet).paths.find((p) => p.accountId === social.id);
    const cue = socialPath?.addressHop.contributions.find((c) => c.feature === 'e3_ownership_cue');
    expect(cue).toMatchObject({ reliability: 'A' });
  });
});
