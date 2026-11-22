import type { AnalysisRun, AnalystJudgement, AnalystOverride, LinkAssessment, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

/** A case with one run and one assessed link (synthetic). */
async function seed(repos: Repositories): Promise<{ caseId: string; run: AnalysisRun; link: LinkAssessment }> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test ocen)',
      purpose: 'Test ocen analityka na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
      scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
    },
    'test',
  );
  const run: AnalysisRun = {
    id: newId(),
    caseId: kase.id,
    trigger: 'manual',
    mode: 'offline',
    status: 'succeeded',
    config: {
      toolVersion: '0.0.0',
      sourcesConfigSha256: 'a',
      weightsVersion: 'weights.v2',
      weightsSha256: 'b',
      rulesVersions: {},
    },
    queuedAt: '2026-11-21T10:00:00.000Z',
  };
  await repos.runs.create(run);
  const link: LinkAssessment = {
    id: newId(),
    runId: run.id,
    identityId: kase.identifiers[0]!.id,
    address: { chain: 'bitcoin', address: 'bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2' },
    relation: 'SELF_DECLARED',
    tier: 'E2',
    paths: [],
    probability: 0.24,
    score: 24,
    icd203: 'unlikely',
    analyticConfidence: 'Low',
    gates: [],
    algorithmVersion: 'test',
    weightsVersion: 'weights.v2',
    weightsSha256: 'b',
    rulesVersion: 'test',
    computedAt: '2026-11-21T10:00:05.000Z',
  };
  await repos.analysis.addLinks([link]);
  return { caseId: kase.id, run, link };
}

const judgement = (linkAssessmentId: string, at: string, value: AnalystJudgement['judgement']): AnalystJudgement => ({
  id: newId(),
  linkAssessmentId,
  judgement: value,
  justification: 'Uzasadnienie oceny na danych syntetycznych',
  analyst: 'Analityk Testowy',
  at,
});

const override = (caseId: string, at: string): AnalystOverride => ({
  id: newId(),
  caseId,
  kind: 'reliability_grade',
  target: { sourceId: 'fixture_site' },
  value: 'B',
  justification: 'Ocena źródła na danych syntetycznych',
  analyst: 'Analityk Testowy',
  at,
});

/** The same contract for both stores: append-only records, oldest first, linked to stored links and cases. */
async function roundTrip(repos: Repositories): Promise<void> {
  const { caseId, run, link } = await seed(repos);
  const later = judgement(link.id, '2026-11-21T11:00:00.000Z', 'not_same');
  const earlier = judgement(link.id, '2026-11-21T10:30:00.000Z', 'unsure');
  await repos.judgements!.add(later);
  await repos.judgements!.add(earlier);
  expect(await repos.judgements!.listByLink(link.id)).toEqual([earlier, later]);
  expect(await repos.judgements!.listByRun(run.id)).toEqual([earlier, later]);
  expect(await repos.judgements!.listByRun(newId())).toEqual([]);
  await expect(repos.judgements!.add(judgement(newId(), '2026-11-21T11:00:00.000Z', 'same'))).rejects.toThrow(
    /not found|foreign key/,
  );

  const second = override(caseId, '2026-11-21T12:00:00.000Z');
  const first = { ...override(caseId, '2026-11-21T11:30:00.000Z'), target: { observationId: newId() } };
  await repos.overrides!.add(second);
  await repos.overrides!.add(first);
  expect(await repos.overrides!.listByCase(caseId)).toEqual([first, second]);
  await expect(repos.overrides!.add(override(newId(), '2026-11-21T12:00:00.000Z'))).rejects.toThrow(
    /not found|foreign key/,
  );

  expect(await repos.analysis.getLink!(link.id)).toEqual(link);
  expect(await repos.analysis.getLink!(newId())).toBeUndefined();
}

describe('analyst records (memory)', () => {
  it('are append-only, ordered oldest first and reference stored links and cases', async () => {
    await expect(roundTrip(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)('analyst records (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('are append-only, ordered oldest first and reference stored links and cases', async () => {
    await expect(roundTrip(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated or deleted by the application role, nor can link assessments', async () => {
    const repos = createSqlRepositories(db);
    const { caseId, link } = await seed(repos);
    await repos.judgements!.add(judgement(link.id, '2026-11-21T11:00:00.000Z', 'same'));
    await repos.overrides!.add(override(caseId, '2026-11-21T11:00:00.000Z'));
    const denied = /permission denied/;
    await expect(
      db.updateTable('link_assessments').set({ score: 99 }).where('id', '=', link.id).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('link_assessments').where('id', '=', link.id).execute()).rejects.toThrow(denied);
    await expect(
      db
        .updateTable('analyst_judgements')
        .set({ judgement: 'not_same' })
        .where('link_assessment_id', '=', link.id)
        .execute(),
    ).rejects.toThrow(denied);
    await expect(
      db.deleteFrom('analyst_judgements').where('link_assessment_id', '=', link.id).execute(),
    ).rejects.toThrow(denied);
    await expect(
      db.updateTable('analyst_overrides').set({ value: 'A' }).where('case_id', '=', caseId).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('analyst_overrides').where('case_id', '=', caseId).execute()).rejects.toThrow(denied);
    expect((await repos.analysis.getLink!(link.id))?.score).toBe(24);
  });
});
