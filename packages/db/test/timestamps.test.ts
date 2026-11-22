import type {
  AnalysisRun,
  Capture,
  CustodyEvent,
  Repositories,
  TimestampRequestRecord,
  TimestampSubject,
  TimestampTokenRecord,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

async function seedCapture(repos: Repositories): Promise<Capture> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test znaczników czasu)',
      purpose: 'Test znaczników czasu na danych syntetycznych',
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
    config: { toolVersion: '0', sourcesConfigSha256: 'a', weightsVersion: 'w', weightsSha256: 'b', rulesVersions: {} },
    queuedAt: '2026-11-21T10:00:00.000Z',
  };
  await repos.runs.create(run);
  const capture: Capture = {
    id: newId(),
    runId: run.id,
    sourceId: 'fixture_site',
    url: 'https://forum.example.test/profile/fikcyjny_kacper',
    finalUrl: 'https://forum.example.test/profile/fikcyjny_kacper',
    collectedAt: '2026-11-21T10:00:00.000Z',
    collector: 'test',
    clockSynced: true,
    toolVersion: '0',
    userAgent: 'test',
    httpStatus: 200,
    status: 'ok',
    artifacts: [],
    manifestSha256: 'c'.repeat(64),
    fetchIds: [],
  };
  await repos.evidence.addCaptures([capture]);
  return capture;
}

const requestOf = (
  subject: TimestampSubject,
  outcome: TimestampRequestRecord['outcome'],
  at: string,
): TimestampRequestRecord => ({
  id: newId(),
  subject,
  tsaSourceId: 'freetsa',
  tsaUrl: 'https://freetsa.org/tsr',
  outcome,
  at,
  ...(outcome === 'granted' || outcome === 'failed' ? { nonce: '9223372036854775807' } : {}),
  ...(outcome === 'failed' ? { reason: 'HTTP 503', httpStatus: 503 } : {}),
});

const tokenOf = (request: TimestampRequestRecord): TimestampTokenRecord => ({
  id: newId(),
  subject: request.subject,
  requestId: request.id,
  token: {
    tsaUrl: request.tsaUrl,
    token: { sha256: 'd'.repeat(64), bytes: 1500, mediaType: 'application/timestamp-reply' },
    genTime: '2026-11-21T10:00:05.000Z',
    hashAlgorithm: 'sha256',
    messageImprint: request.subject.digest,
    serialNumber: '123456789012345678901234',
    policyOid: '1.2.3.4.1',
    tsaName: 'CN=Test TSA',
    qualified: false,
    skewSeconds: 5,
  },
  verification: { ok: true, checks: [{ name: 'imprint', passed: true }] },
  createdAt: '2026-11-21T10:00:06.000Z',
});

const custodyOf = (subject: TimestampSubject, action: CustodyEvent['action']): CustodyEvent => ({
  id: newId(),
  at: '2026-11-21T10:00:06.000Z',
  actor: 'test',
  action,
  subject: { type: 'capture', id: subject.id },
  detail: {},
});

async function lifecycle(repos: Repositories): Promise<void> {
  const timestamps = repos.timestamps!;
  const capture = await seedCapture(repos);
  const subject: TimestampSubject = {
    type: 'capture_manifest',
    id: capture.id,
    digest: capture.manifestSha256,
    runId: capture.runId,
    referenceTime: capture.collectedAt,
  };
  // A shared database also holds other tests' requests: look at this capture's subject only.
  const pendingOf = async () => (await timestamps.listPending(10_000)).filter((r) => r.subject.id === capture.id);
  expect((await repos.evidence.getCapture(capture.id))?.timestamp).toBeUndefined();

  // Queued offline, then a failed retry: still pending, the latest request first in the history.
  const queued = requestOf(subject, 'queued', '2026-11-21T10:00:01.000Z');
  await timestamps.record({ request: queued });
  expect((await pendingOf()).map((r) => r.id)).toEqual([queued.id]);
  const failed = requestOf(subject, 'failed', '2026-11-21T10:01:00.000Z');
  await timestamps.record({ request: failed, custody: [custodyOf(subject, 'timestamp_failed')] });
  const pending = await pendingOf();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id: failed.id, outcome: 'failed', subject, nonce: '9223372036854775807' });

  // Granted: token stored, custody written, no longer pending; Capture.timestamp is filled.
  const granted = requestOf(subject, 'granted', '2026-11-21T10:02:00.000Z');
  const token = tokenOf(granted);
  expect(await timestamps.record({ request: granted, token, custody: [custodyOf(subject, 'timestamped')] })).toEqual({
    tokenStored: true,
  });
  expect(await pendingOf()).toEqual([]);
  expect((await timestamps.getToken(subject))?.token).toEqual(token.token);
  expect((await repos.evidence.getCapture(capture.id))?.timestamp).toEqual(token.token);
  expect((await repos.evidence.listCaptures(capture.runId))[0]?.timestamp?.serialNumber).toBe(
    '123456789012345678901234',
  );
  expect((await repos.custody!.listBySubjects([capture.id])).map((e) => e.action)).toEqual([
    'timestamp_failed',
    'timestamped',
  ]);

  // A second grant for the same subject: one token only, no second custody event.
  const again = requestOf(subject, 'granted', '2026-11-21T10:03:00.000Z');
  expect(
    await timestamps.record({ request: again, token: tokenOf(again), custody: [custodyOf(subject, 'timestamped')] }),
  ).toEqual({ tokenStored: false });
  expect((await repos.custody!.listBySubjects([capture.id])).filter((e) => e.action === 'timestamped')).toHaveLength(1);
  expect((await timestamps.listRequests(capture.id)).map((r) => r.outcome)).toEqual([
    'queued',
    'failed',
    'granted',
    'granted',
  ]);

  // A rejected latest request is terminal: not pending.
  const other = { ...subject, digest: 'e'.repeat(64) };
  await timestamps.record({ request: { ...requestOf(other, 'rejected', '2026-11-21T10:04:00.000Z'), reason: 'x' } });
  expect(await pendingOf()).toEqual([]);
}

describe('timestamps (memory)', () => {
  it('keeps requests and tokens append-only and fills Capture.timestamp', async () => {
    await expect(lifecycle(createMemoryRepositories())).resolves.toBeUndefined();
  });
});

describe.skipIf(!enabled)('timestamps (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])', () => {
  let db: Db;
  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('keeps requests and tokens append-only and fills Capture.timestamp', async () => {
    await expect(lifecycle(createSqlRepositories(db))).resolves.toBeUndefined();
  });

  it('cannot be updated or deleted by the application role', async () => {
    const repos = createSqlRepositories(db);
    const capture = await seedCapture(repos);
    const subject: TimestampSubject = { type: 'capture_manifest', id: capture.id, digest: capture.manifestSha256 };
    const request = requestOf(subject, 'queued', '2026-11-21T10:00:01.000Z');
    await repos.timestamps!.record({ request });
    const denied = /permission denied/;
    await expect(
      db.updateTable('timestamp_request').set({ outcome: 'granted' }).where('id', '=', request.id).execute(),
    ).rejects.toThrow(denied);
    await expect(db.deleteFrom('timestamp_request').where('id', '=', request.id).execute()).rejects.toThrow(denied);
    await expect(db.deleteFrom('timestamp_token').where('subject_id', '=', capture.id).execute()).rejects.toThrow(
      denied,
    );
  });
});
