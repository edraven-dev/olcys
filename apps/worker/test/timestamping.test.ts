/**
 * Trusted timestamping in the worker with a fake TSA (keys generated in memory at test time): live stamping, rejected
 * replies, offline queueing and the idempotent flush, retries after an outage, the clock cross-check and the start-up
 * allow-list check. Runs on the in-memory store and, when OLCYS_TEST_DATABASE_URL[_OWNER] are set, on PostgreSQL.
 */
import type { AnalysisRun, Capture, FetchMode, Logger, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRuntime,
  createTrustedTimestamper,
  loadConfig,
  tsaSettings,
  TsaConfigError,
  type TsaSettings,
} from '../src/index.ts';
import {
  createFakeTsa,
  createFakeTsaEgress,
  type FakeTsa,
  type FakeTsaEgress,
} from '../../../packages/evidence/test/support/fake-tsa.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const COLLECTED_AT = '2026-11-21T12:00:00.000Z';

let tsa: FakeTsa;
let sources: Awaited<ReturnType<typeof loadConfig>>['sources'];
beforeAll(async () => {
  tsa = await createFakeTsa();
  sources = (await loadConfig()).sources;
});

async function seedCapture(repos: Repositories): Promise<Capture> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test znaczników czasu)',
      purpose: 'Test znakowania czasem na danych syntetycznych',
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
    mode: 'live',
    status: 'succeeded',
    config: { toolVersion: '0', sourcesConfigSha256: 'a', weightsVersion: 'w', weightsSha256: 'b', rulesVersions: {} },
    queuedAt: COLLECTED_AT,
  };
  await repos.runs.create(run);
  const capture: Capture = {
    id: newId(),
    runId: run.id,
    sourceId: 'fixture_site',
    url: 'https://forum.example.test/profile/fikcyjny_kacper',
    finalUrl: 'https://forum.example.test/profile/fikcyjny_kacper',
    collectedAt: COLLECTED_AT,
    collector: 'test',
    clockSynced: true,
    toolVersion: '0',
    userAgent: 'test',
    httpStatus: 200,
    status: 'ok',
    artifacts: [],
    manifestSha256: newId().replaceAll('-', '').padEnd(64, 'a'),
    fetchIds: [],
  };
  await repos.evidence.addCaptures([capture]);
  return capture;
}

const subjectOf = (c: Capture) => ({
  type: 'capture_manifest' as const,
  id: c.id,
  digest: c.manifestSha256,
  runId: c.runId,
  referenceTime: c.collectedAt,
});

/** A shared database also holds other tests' pending requests: flush only this capture. */
const only = (c: Capture) => ({ subjectIds: [c.id], limit: 100_000 });

async function setup(
  makeRepos: () => Repositories,
  options: { mode?: FetchMode; script?: FakeTsaEgress['script']; settings?: Partial<TsaSettings> } = {},
) {
  const repos = makeRepos();
  const blobs = new InMemoryBlobStore();
  const egress = createFakeTsaEgress(tsa, options.script ?? [{}]);
  const make = (mode: FetchMode) =>
    createTrustedTimestamper({
      repos,
      blobs,
      settings: { ...tsaSettings({}), ...options.settings },
      sources,
      mode,
      logger: silent,
      http: egress.client,
      anchorsPem: [tsa.caPem],
    });
  return {
    repos,
    blobs,
    egress,
    make,
    timestamper: await make(options.mode ?? 'live'),
    capture: await seedCapture(repos),
  };
}
const actions = async (repos: Repositories, id: string) =>
  (await repos.custody!.listBySubjects([id])).map((e) => e.action);

function suite(name: string, makeRepos: () => Repositories, enabled = true) {
  describe.skipIf(!enabled)(`timestamping on ${name}`, () => {
    it('AC2: live mode stamps the manifest digest with exactly one egress request', async () => {
      const { repos, blobs, egress, timestamper, capture } = await setup(makeRepos);
      const outcome = await timestamper.stamp(subjectOf(capture));
      expect(outcome.status).toBe('granted');
      expect(egress.calls).toHaveLength(1);
      expect(egress.calls[0]).toMatchObject({ method: 'POST', sourceId: 'freetsa', containsIdentifier: false });
      const read = await repos.evidence.getCapture(capture.id);
      expect(read?.timestamp).toMatchObject({
        genTime: '2026-11-21T12:00:05.000Z',
        messageImprint: capture.manifestSha256,
        skewSeconds: 5,
      });
      expect(read?.timestamp?.serialNumber).toMatch(/^\d+$/);
      expect(await blobs.has(read!.timestamp!.token.sha256)).toBe(true);
      expect(await actions(repos, capture.id)).toEqual(['timestamped']);
      // Stamping again returns the stored token without another request.
      expect((await timestamper.stamp(subjectOf(capture))).status).toBe('granted');
      expect(egress.calls).toHaveLength(1);
    });

    it('AC3: a reply that fails verification is rejected, stores no token and is not retried', async () => {
      const { repos, timestamper, capture, egress } = await setup(makeRepos, { script: [{ wrongImprint: true }] });
      expect(await timestamper.stamp(subjectOf(capture))).toEqual({
        status: 'rejected',
        reason: 'verification_failed: imprint',
      });
      expect((await repos.evidence.getCapture(capture.id))?.timestamp).toBeUndefined();
      expect((await repos.timestamps!.listRequests(capture.id)).map((r) => r.outcome)).toEqual(['rejected']);
      expect(await actions(repos, capture.id)).toEqual(['timestamp_failed']);
      expect((await timestamper.flush(only(capture))).attempted).toBe(0);
      expect(egress.calls).toHaveLength(1);
    });

    it.each<FetchMode>(['offline', 'replay'])('AC4: %s mode queues, a live flush grants it once', async (mode) => {
      const { repos, make, egress, capture } = await setup(makeRepos, { mode });
      const offline = await make(mode);
      expect(await offline.stamp(subjectOf(capture))).toEqual({ status: 'queued', reason: 'offline' });
      expect(egress.calls).toHaveLength(0);
      expect((await repos.timestamps!.listRequests(capture.id)).map((r) => r.outcome)).toEqual(['queued']);
      expect(await offline.flush()).toMatchObject({ ran: false, reason: 'not_live' });

      const live = await make('live');
      const first = await live.flush(only(capture));
      expect(first).toMatchObject({ ran: true, granted: 1 });
      expect(egress.calls).toHaveLength(1);
      expect((await live.flush(only(capture))).attempted).toBe(0);
      expect(egress.calls).toHaveLength(1);
      const requests = await repos.timestamps!.listRequests(capture.id);
      expect(requests.map((r) => r.outcome)).toEqual(['queued', 'granted']);
      expect((await repos.evidence.getCapture(capture.id))?.timestamp).toBeDefined();
      expect(await actions(repos, capture.id)).toEqual(['timestamped']);
    });

    it('AC5: a 503 is recorded as failed and the flush retry grants the token', async () => {
      const { repos, timestamper, capture, egress } = await setup(makeRepos, { script: [503, {}] });
      expect(await timestamper.stamp(subjectOf(capture))).toEqual({ status: 'queued', reason: 'transient_failure' });
      expect((await repos.timestamps!.listPending()).filter((r) => r.subject.id === capture.id)).toHaveLength(1);
      expect(await timestamper.flush(only(capture))).toMatchObject({ attempted: 1, granted: 1 });
      expect((await repos.timestamps!.listRequests(capture.id)).map((r) => r.outcome)).toEqual(['failed', 'granted']);
      expect(egress.calls).toHaveLength(2);
      expect(await actions(repos, capture.id)).toEqual(['timestamp_failed', 'timestamped']);
      expect((await repos.evidence.getCapture(capture.id))?.timestamp).toBeDefined();
    });

    it('AC6: a 10 minute skew is stored and flagged, a 30 second one is not', async () => {
      const slow = await setup(makeRepos, { script: [{ genTime: new Date('2026-11-21T12:10:00.000Z') }] });
      await slow.timestamper.stamp(subjectOf(slow.capture));
      expect((await slow.repos.evidence.getCapture(slow.capture.id))?.timestamp?.skewSeconds).toBe(600);
      const [slowEvent] = await slow.repos.custody!.listBySubjects([slow.capture.id]);
      expect(slowEvent?.detail).toMatchObject({ skewSeconds: 600, skewSuspected: true });

      const ok = await setup(makeRepos, { script: [{ genTime: new Date('2026-11-21T12:00:30.000Z') }] });
      await ok.timestamper.stamp(subjectOf(ok.capture));
      const [okEvent] = await ok.repos.custody!.listBySubjects([ok.capture.id]);
      expect(okEvent?.detail).toMatchObject({ skewSeconds: 30, skewSuspected: false });
      expect((await slow.repos.evidence.getCapture(slow.capture.id))?.timestamp?.skewSuspected).toBe(true);
      expect((await ok.repos.evidence.getCapture(ok.capture.id))?.timestamp?.skewSuspected).toBe(false);

      // A custom TSA_MAX_CLOCK_SKEW_SECONDS decides: 30 s is suspect under a 10 s limit, 600 s fine under 900 s.
      const strict = await setup(makeRepos, {
        script: [{ genTime: new Date('2026-11-21T12:00:30.000Z') }],
        settings: { maxClockSkewSeconds: 10 },
      });
      await strict.timestamper.stamp(subjectOf(strict.capture));
      expect((await strict.repos.evidence.getCapture(strict.capture.id))?.timestamp?.skewSuspected).toBe(true);
      const lenient = await setup(makeRepos, {
        script: [{ genTime: new Date('2026-11-21T12:10:00.000Z') }],
        settings: { maxClockSkewSeconds: 900 },
      });
      await lenient.timestamper.stamp(subjectOf(lenient.capture));
      expect((await lenient.repos.evidence.getCapture(lenient.capture.id))?.timestamp?.skewSuspected).toBe(false);
    });

    it('AC7: TSA_ENABLED=false queues every stamp as disabled and never calls the TSA', async () => {
      const { repos, timestamper, capture, egress } = await setup(makeRepos, { settings: { enabled: false } });
      expect(await timestamper.stamp(subjectOf(capture))).toEqual({ status: 'queued', reason: 'disabled' });
      expect(egress.calls).toHaveLength(0);
      expect(await timestamper.flush()).toMatchObject({ ran: false, reason: 'disabled' });
      expect((await repos.timestamps!.listRequests(capture.id)).map((r) => r.reason)).toEqual(['disabled']);
    });
  });
}

describe('start-up allow-list check (AC7)', () => {
  it('fails with tsa_host_not_allow_listed for a host outside freetsa.allowedHosts', async () => {
    const settings = tsaSettings({ TSA_URL: 'https://tsa.example.net/tsr' });
    const deps = {
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      settings,
      sources,
      mode: 'offline' as const,
      logger: silent,
    };
    await expect(createTrustedTimestamper(deps)).rejects.toThrow(TsaConfigError);
    await expect(createTrustedTimestamper(deps)).rejects.toThrow('tsa_host_not_allow_listed');
    await expect(
      createRuntime({ env: { OLCYS_MODE: 'offline', TSA_URL: 'https://tsa.example.net/tsr' }, logger: silent }),
    ).rejects.toThrow('tsa_host_not_allow_listed');
    await expect(
      createTrustedTimestamper({ ...deps, settings: tsaSettings({ TSA_SOURCE_ID: 'github' }) }),
    ).rejects.toThrow('tsa_source_invalid');
  });

  it('is skipped when the service is disabled, and the defaults are the FreeTSA demo setup', async () => {
    const deps = {
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      sources,
      mode: 'offline' as const,
      logger: silent,
    };
    await expect(
      createTrustedTimestamper({
        ...deps,
        settings: tsaSettings({ TSA_ENABLED: 'false', TSA_URL: 'https://tsa.example.net/tsr' }),
      }),
    ).resolves.toMatchObject({ enabled: false });
    expect(tsaSettings({})).toMatchObject({ enabled: true, url: 'https://freetsa.org/tsr', sourceId: 'freetsa' });
    expect(tsaSettings({ TSA_USERNAME: 'u', TSA_PASSWORD: 'p' }).authorization).toBe('Basic dTpw');
  });
});

suite('the in-memory store', () => createMemoryRepositories());

let db: Db | undefined;
const sqlEnabled = Boolean(appUrl && ownerUrl);
if (sqlEnabled) {
  beforeAll(async () => {
    await migrate(ownerUrl!);
    db = createDb(appUrl!);
  });
  afterAll(async () => {
    await db?.destroy();
  });
}
suite('PostgreSQL', () => createSqlRepositories(db!), sqlEnabled);
