import type { AnalysisRun, Capture, LinkAssessment, Observation } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

describe.skipIf(!enabled)('SQL repositories (integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('migrations are idempotent', async () => {
    expect((await migrate(ownerUrl!)).applied).toEqual([]);
  });

  it('round-trips a case, a run and evidence', async () => {
    const repos = createSqlRepositories(db);
    const created = await repos.cases.create(
      {
        title: 'Kacper Fikcyjny (test)',
        purpose: 'Test integracyjny na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
        scope: { enabledSources: ['fixture_site'], amberJustifications: {}, chains: [], maxPivotDepth: 2 },
      },
      'test',
    );
    expect(created.identifiers[0]?.isAnchor).toBe(true);
    expect((await repos.cases.get(created.id))?.title).toBe('Kacper Fikcyjny (test)');

    const run: AnalysisRun = {
      id: newId(),
      caseId: created.id,
      trigger: 'manual',
      mode: 'offline',
      status: 'queued',
      config: {
        toolVersion: '0.0.0',
        sourcesConfigSha256: 'a',
        weightsVersion: 'weights.v1',
        weightsSha256: 'b',
        rulesVersions: {},
      },
      queuedAt: new Date().toISOString(),
    };
    await repos.runs.create(run);
    await repos.runs.update(run.id, {
      status: 'succeeded',
      progress: { step: 'run.finish' },
      finishedAt: new Date().toISOString(),
    });
    expect((await repos.runs.latestCompleted(created.id))?.id).toBe(run.id);

    const capture: Capture = {
      id: newId(),
      runId: run.id,
      sourceId: 'fixture_site',
      url: 'http://127.0.0.1:4100/forum/profile/900001',
      finalUrl: 'http://127.0.0.1:4100/forum/profile/900001',
      collectedAt: new Date().toISOString(),
      collector: 'test',
      clockSynced: true,
      toolVersion: '0.0.0',
      userAgent: 'test',
      httpStatus: 200,
      status: 'ok',
      artifacts: [],
      manifestSha256: '0'.repeat(64),
      fetchIds: [],
    };
    await repos.evidence.addCaptures([capture]);
    const observation: Observation = {
      id: newId(),
      runId: run.id,
      captureId: capture.id,
      sourceId: 'fixture_site',
      subject: { type: 'account', key: 'bitcointalk:900001' },
      property: 'profile.bitcoin_address',
      value: 'bc1qexample',
      locator: 'bitcointalk:u=900001#profile.bitcoin_address',
      observedAt: new Date().toISOString(),
    };
    await repos.evidence.addObservations([observation]);
    expect(await repos.evidence.listObservations(run.id)).toEqual([observation]);
    expect((await repos.evidence.getCapture(capture.id))?.url).toBe(capture.url);

    const link = {
      id: newId(),
      runId: run.id,
      identityId: created.identifiers[0]!.id,
      address: { chain: 'bitcoin', address: 'bc1qexample' },
      relation: 'SELF_DECLARED',
      tier: 'E1',
      paths: [],
      probability: 0.99,
      score: 99,
      icd203: 'almost certain',
      analyticConfidence: 'High',
      gates: [],
      algorithmVersion: 'test',
      weightsVersion: 'weights.v1',
      weightsSha256: 'b',
      rulesVersion: 'test',
      computedAt: new Date().toISOString(),
    } satisfies LinkAssessment;
    await repos.analysis.addLinks([link]);
    expect((await repos.analysis.listLinks(run.id))[0]?.score).toBe(99);
  });

  it('evidence is append-only for the application role', async () => {
    const repos = createSqlRepositories(db);
    const [anyCapture] = await db.selectFrom('captures').select('id').limit(1).execute();
    expect(anyCapture).toBeDefined();
    await expect(
      db.updateTable('captures').set({ status: 'error' }).where('id', '=', anyCapture!.id).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(db.deleteFrom('captures').where('id', '=', anyCapture!.id).execute()).rejects.toThrow(
      /permission denied/,
    );
    expect(repos).toBeDefined();
  });
});
