import type { AnalysisRun, Capture, CustodyEvent, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

const event = (subjectId: string, at: string, runId?: string): CustodyEvent => ({
  id: newId(),
  at,
  actor: 'Analityk Testowy',
  action: 'collected',
  ...(runId ? { runId } : {}),
  subject: { type: 'capture', id: subjectId },
  detail: { manifestSha256: 'a'.repeat(64), clockSynced: false, count: 1 },
});

async function seedRun(repos: Repositories): Promise<string> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test custody)',
      purpose: 'Test zdarzeń łańcucha dowodowego na danych syntetycznych',
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
      weightsVersion: 'w',
      weightsSha256: 'b',
      rulesVersions: {},
    },
    queuedAt: '2026-11-21T10:00:00.000Z',
  };
  await repos.runs.create(run);
  return run.id;
}

const captureOf = (runId: string): Capture => ({
  id: newId(),
  runId,
  sourceId: 'fixture_site',
  url: 'https://forum.example.test/profile/fikcyjny_kacper',
  finalUrl: 'https://forum.example.test/profile/fikcyjny_kacper',
  collectedAt: '2026-11-21T10:00:00.000Z',
  collector: 'test',
  clockSynced: true,
  toolVersion: '0.0.0',
  userAgent: 'test',
  httpStatus: 200,
  status: 'ok',
  artifacts: [],
  manifestSha256: '0'.repeat(64),
  fetchIds: [],
});

/** Captures and their custody events are stored together; a failing event stores no capture. */
async function atomicity(repos: Repositories): Promise<void> {
  const runId = await seedRun(repos);
  const good = captureOf(runId);
  await repos.evidence.addCaptures([good], [{ ...event(good.id, good.collectedAt, runId) }]);
  expect(await repos.evidence.getCapture(good.id)).toBeDefined();
  expect(await repos.custody!.listBySubjects([good.id])).toHaveLength(1);

  const bad = captureOf(runId);
  const broken = { ...event(bad.id, bad.collectedAt, runId), action: 'not_an_action' } as unknown as CustodyEvent;
  await expect(repos.evidence.addCaptures([bad], [broken])).rejects.toThrow(/check|constraint|not_an_action/i);
  expect(await repos.evidence.getCapture(bad.id)).toBeUndefined();
  expect(await repos.custody!.listBySubjects([bad.id])).toEqual([]);
}

async function roundTrip(repos: Repositories): Promise<void> {
  const runId = await seedRun(repos);
  const a = newId();
  const b = newId();
  const later = event(a, '2026-11-21T11:00:00.000Z', runId);
  const earlier = event(a, '2026-11-21T10:30:00.000Z', runId);
  const other = event(b, '2026-11-21T10:45:00.000Z');
  await repos.custody!.add([later, earlier, other]);
  expect(await repos.custody!.listBySubjects([a])).toEqual([earlier, later]);
  expect(await repos.custody!.listBySubjects([a, b])).toEqual([earlier, other, later]);
  expect(await repos.custody!.listBySubjects([])).toEqual([]);
  expect(await repos.custody!.listBySubjects([newId()])).toEqual([]);
}

describe('custody events (memory)', () => {
  it('are stored and listed oldest first by subject', async () => {
    await expect(roundTrip(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe('capture and custody atomicity (memory)', () => {
  it('stores both together', async () => {
    const repos = createMemoryRepositories();
    const runId = await seedRun(repos);
    const capture = captureOf(runId);
    await repos.evidence.addCaptures([capture], [event(capture.id, capture.collectedAt, runId)]);
    expect(await repos.custody!.listBySubjects([capture.id])).toHaveLength(1);
  });
});

describe.skipIf(!enabled)('custody events (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;
  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('are stored and listed oldest first by subject', async () => {
    await expect(roundTrip(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('keeps no capture when its custody event fails (one transaction)', async () => {
    await expect(atomicity(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated or deleted by the application role', async () => {
    const repos = createSqlRepositories(db);
    const subject = newId();
    await repos.custody!.add([event(subject, '2026-11-21T11:00:00.000Z')]);
    const denied = /permission denied/;
    await expect(
      db.updateTable('custody_event').set({ actor: 'x' }).where('subject_id', '=', subject).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('custody_event').where('subject_id', '=', subject).execute()).rejects.toThrow(denied);
    expect(await repos.custody!.listBySubjects([subject])).toHaveLength(1);
  });
});
