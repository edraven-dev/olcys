/**
 * `GET /api/cases/:caseId/timeline` on the in-memory store: archived copies and live runs of one synthetic page in one
 * timeline, and 400 for bad filters. The SQL store is exercised by the shared repository tests, not here.
 */
import type { AddressCandidate, AnalysisRun, Capture, Observation, PropertyTimeline, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const PAGE = 'https://forum.example.org/profile/900001';
const SNAPSHOTS = [
  ['20250301120000', 'BTC-0', 'DIGEST-A'],
  ['20260210101500', 'BTC-1', 'DIGEST-B'],
] as const;

const capture = (id: string, runId: string, collectedAt: string, archive?: string): Capture =>
  ({
    id,
    runId,
    sourceId: archive ? 'wayback_cdx' : 'forum_example',
    url: archive ? `https://web.archive.org/web/${archive}id_/${PAGE}` : PAGE,
    finalUrl: PAGE,
    collectedAt,
    status: 'ok',
    ...(archive ? { archive: { provider: 'wayback', snapshotTimestamp: archive, originalUrl: PAGE } } : {}),
  }) as Capture;

const candidate = (captureId: string, address: string): AddressCandidate =>
  ({ id: newId(), captureId, address: { chain: 'bitcoin', address } }) as AddressCandidate;

const observation = (runId: string, captureId: string, property: string, value: string, locator: string) =>
  ({
    id: newId(),
    runId,
    captureId,
    sourceId: 'wayback_cdx',
    subject: { type: 'page', key: PAGE },
    property,
    value,
    locator,
    observedAt: '2026-03-01T09:00:00.000Z',
  }) as Observation;

async function seed(repos: Repositories) {
  const kase = await repos.cases.create(
    {
      title: 'Sprawa syntetyczna (oś czasu)',
      purpose: 'Test osi czasu na danych syntetycznych',
      legalBasis: 'demonstracja',
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
      scope: { enabledSources: ['wayback_cdx'], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
    },
    'test',
  );
  const runIds = [newId(), newId()] as const;
  for (const [i, id] of runIds.entries()) {
    // oxlint-disable-next-line no-await-in-loop
    await repos.runs.create({
      id,
      caseId: kase.id,
      trigger: 'manual',
      mode: 'offline',
      status: 'succeeded',
      config: {},
      queuedAt: `2026-03-0${1 + i * 7}T09:00:00.000Z`,
    } as unknown as AnalysisRun);
  }
  const [run1, run2] = runIds;
  const archived = SNAPSHOTS.map(([ts]) => capture(newId(), run1, '2026-03-01T09:00:01.000Z', ts));
  const live = [capture(newId(), run1, '2026-03-01T09:00:10.000Z'), capture(newId(), run2, '2026-03-08T09:00:10.000Z')];
  await repos.evidence.addCaptures([...archived, ...live]);
  await repos.evidence.addObservations(
    SNAPSHOTS.flatMap(([ts, , digest], i) => {
      const locator = `wayback:${PAGE}@${ts}`;
      return [
        observation(run1, archived[i]!.id, 'archive.snapshot', ts, locator),
        observation(run1, archived[i]!.id, 'archive.digest', digest, locator),
      ];
    }),
  );
  const values = [...SNAPSHOTS.map(([, v]) => v), 'BTC-1', 'BTC-2'];
  for (const [i, c] of [...archived, ...live].entries()) {
    // oxlint-disable-next-line no-await-in-loop
    await repos.evidence.addExtraction(c.runId, {
      captureId: c.id,
      candidates: [candidate(c.id, values[i]!)],
      rejected: [],
      secrets: [],
      extractorVersion: 'test',
    });
  }
  return { caseId: kase.id, run1: run1, live, archived };
}

const appFor = (repos: Repositories) =>
  buildApp({
    repos,
    blobs: new InMemoryBlobStore(),
    sources: [],
    startRun: async () => {
      throw new Error('runs are not started in these tests');
    },
  });

describe('GET /api/cases/:caseId/timeline', () => {
  it('returns the page timeline of the case: archive before live, two bracketed wallet changes', async () => {
    const repos = createMemoryRepositories();
    const { caseId } = await seed(repos);
    const app = appFor(repos);
    const response = await app.inject(`/api/cases/${caseId}/timeline?url=${encodeURIComponent(PAGE)}&walletOnly=true`);
    expect(response.statusCode).toBe(200);
    const [timeline, ...rest] = response.json() as PropertyTimeline[];
    expect(rest).toEqual([]);
    expect(timeline!.key.property).toBe('page.address');
    expect(timeline!.points.map((p) => p.provenance)).toEqual(['archive', 'archive', 'live', 'live']);
    expect(timeline!.changes.map((c) => [c.before, c.after, c.wallet])).toEqual([
      [['bitcoin:BTC-0'], ['bitcoin:BTC-1'], true],
      [['bitcoin:BTC-1'], ['bitcoin:BTC-2'], true],
    ]);
    await app.close();
  });

  it('uses the newest analysis of a capture: a rescore that rejects an address removes it from the timeline', async () => {
    const repos = createMemoryRepositories();
    const { caseId, run1, live } = await seed(repos);
    const rescore = newId();
    await repos.runs.create({
      id: rescore,
      caseId,
      trigger: 'rescore',
      rescoreOfRunId: run1,
      mode: 'offline',
      status: 'succeeded',
      config: {},
      queuedAt: '2026-03-20T09:00:00.000Z',
    } as unknown as AnalysisRun);
    // The rescore re-extracted the first live capture and rejected its address (documentation example): no candidates.
    await repos.evidence.addExtraction(rescore, {
      captureId: live[0]!.id,
      candidates: [],
      rejected: [],
      secrets: [],
      extractorVersion: 'test-2',
    });
    const app = appFor(repos);
    const [timeline] = (await app.inject(`/api/cases/${caseId}/timeline?walletOnly=true`)).json() as PropertyTimeline[];
    expect(timeline!.points.filter((p) => p.provenance === 'live').map((p) => p.values)).toEqual([
      [],
      ['bitcoin:BTC-2'],
    ]);
    await app.close();
  });

  it('shows a capture whose extraction has not run as a gap, not as a removal', async () => {
    const repos = createMemoryRepositories();
    const { caseId } = await seed(repos);
    const run3 = newId();
    await repos.runs.create({
      id: run3,
      caseId,
      trigger: 'manual',
      mode: 'offline',
      status: 'running',
      config: {},
      queuedAt: '2026-03-30T09:00:00.000Z',
    } as unknown as AnalysisRun);
    await repos.evidence.addCaptures([capture(newId(), run3, '2026-03-30T09:00:10.000Z')]);
    const app = appFor(repos);
    const [timeline] = (await app.inject(`/api/cases/${caseId}/timeline?walletOnly=true`)).json() as PropertyTimeline[];
    expect(timeline!.points.at(-1)).toMatchObject({ values: null, gapReason: 'extraction_pending' });
    expect(timeline!.changes).toHaveLength(2);
    await app.close();
  });

  it('is empty for a case without archived copies and 404 for an unknown case', async () => {
    const repos = createMemoryRepositories();
    const empty = await repos.cases.create(
      {
        title: 'Pusta',
        purpose: 'x',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
        scope: { enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
      },
      'test',
    );
    const app = appFor(repos);
    expect((await app.inject(`/api/cases/${empty.id}/timeline`)).json()).toEqual([]);
    expect((await app.inject(`/api/cases/${newId()}/timeline`)).statusCode).toBe(404);
    await app.close();
  });

  it('answers 400 with the failing path for bad filters', async () => {
    const repos = createMemoryRepositories();
    const { caseId } = await seed(repos);
    const app = appFor(repos);
    for (const [query, path] of [
      ['walletOnly=maybe', 'walletOnly'],
      ['property=Bad%20Name', 'property'],
      ['url=', 'url'],
      ['other=1', ''],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await app.inject(`/api/cases/${caseId}/timeline?${query}`);
      expect([query, response.statusCode]).toEqual([query, 400]);
      expect(response.json()).toMatchObject({ error: 'invalid_input', issues: [expect.objectContaining({ path })] });
    }
    await app.close();
  });
});
