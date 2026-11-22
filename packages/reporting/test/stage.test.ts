import type { ActivityIndicators, AnalysisRun, LinkAssessment, Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import {
  buildReportData,
  createReportStage,
  EXPORT_KINDS,
  EXPORT_MEDIA_TYPES,
  findExportSet,
  storeReport,
  REPORT_HTML_MEDIA_TYPE,
  renderReport,
  type ReportData,
} from '../src/index.ts';
import { personaData } from './fixtures.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Stores the synthetic persona run through the repository ports, as the pipeline stages would. */
async function seed() {
  const repos = createMemoryRepositories();
  const blobs = new InMemoryBlobStore();
  const fixture = personaData();
  const kase = await repos.cases.create(
    {
      title: fixture.case.title,
      purpose: fixture.case.purpose,
      legalBasis: fixture.case.legalBasis,
      identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
      scope: fixture.case.scope,
    },
    'analityk-testowy',
  );
  const identityId = kase.identifiers[0]?.id ?? '';
  const previous: AnalysisRun = { ...fixture.run, id: 'run-0001', caseId: kase.id, status: 'succeeded' };
  delete previous.previousRunId;
  const run: AnalysisRun = { ...fixture.run, caseId: kase.id, previousRunId: previous.id };
  await repos.runs.create(previous);
  await repos.runs.create(run);
  await repos.evidence.addCaptures(fixture.captures);
  await repos.evidence.addCaptures(fixture.earlierCaptures);
  await repos.evidence.addAccounts(fixture.accounts);
  await repos.evidence.addObservations(fixture.observations);
  await repos.evidence.addEgressLog(fixture.egress);
  await repos.evidence.addExtraction(run.id, {
    captureId: 'cap-2',
    candidates: fixture.candidates,
    rejected: fixture.rejectedCandidates.map((r) => ({
      raw: r.raw,
      reason: r.reason,
      view: r.view,
      span: { start: 0, end: 1 },
    })),
    secrets: [],
    extractorVersion: 'test',
  });
  await Promise.all(
    fixture.transfers.map((t) => repos.chain.addTransfers(run.id, { chain: t.chain, address: t.from }, [t])),
  );
  await repos.analysis.addLinks(fixture.links.map((l) => ({ ...l, identityId })));
  await repos.analysis.addExclusions(fixture.exclusions);
  await repos.analysis.addActivity(run.id, fixture.activity);
  await repos.analysis.addCashOuts(fixture.cashOuts);
  await repos.analysis.addChanges(fixture.changes);
  await repos.labels.upsert(fixture.labels);
  return { repos, blobs, run, kase, fixture };
}

describe('report.render stage', () => {
  it('renders, stores and registers the HTML report and its input data', async () => {
    const { repos, blobs, run, kase } = await seed();
    const progress: Record<string, unknown>[] = [];
    const stage = createReportStage({
      sources: [],
      weightsStatus: 'uncalibrated',
      clock: { now: () => new Date('2026-11-21T13:41:00.000Z') },
    });
    expect(stage.step).toBe('report.render');
    await stage.run({
      run,
      repos,
      blobs,
      logger: silent,
      async progress(detail) {
        progress.push(detail);
      },
    });

    const stored = await repos.analysis.latestReport(run.id, 'html');
    expect(stored?.mediaType).toBe(REPORT_HTML_MEDIA_TYPE);
    const html = decode(await blobs.get(stored?.blobSha256 ?? ''));
    expect(html).toContain(`<h1>Raport z analizy OSINT: ${kase.title}</h1>`);
    expect(html).toContain('Alert: podmiana adresu portfela w profilu');
    expect(html).toContain('2026-11-21 13:41:00 UTC');
    expect(progress).toEqual([{ report: stored?.blobSha256 }]);

    // The stored input data reproduces the identical document; its digest is printed in the report.
    const data = await repos.analysis.latestReport(run.id, 'data_json');
    expect(data?.mediaType).toBe('application/json');
    expect(html).toContain(data?.blobSha256);
    const parsed = JSON.parse(decode(await blobs.get(data?.blobSha256 ?? ''))) as ReportData;
    expect(renderReport(parsed)).toBe(html);
  });

  it('stores the STIX, MISP and CSV exports as further reports of the run', async () => {
    const { repos, blobs, run } = await seed();
    const stage = createReportStage({
      exports: { producerName: 'OŁCyŚ (test)', tlp: 'green' },
      clock: { now: () => new Date('2026-11-21T13:41:00.000Z') },
    });
    await stage.run({ run, repos, blobs, async progress() {} });
    const set = await findExportSet({ repos, blobs }, run.id);
    expect(Object.keys(set?.exports ?? {}).toSorted()).toEqual([...EXPORT_KINDS].toSorted());
    expect(set?.htmlSha256).toBe((await repos.analysis.latestReport(run.id, 'html'))?.blobSha256);
    for (const kind of EXPORT_KINDS) {
      expect(set?.exports[kind]?.mediaType).toBe(EXPORT_MEDIA_TYPES[kind]);
      // oxlint-disable-next-line no-await-in-loop
      expect(await blobs.has(set?.exports[kind]?.sha256 ?? '')).toBe(true);
    }
    const bundle = JSON.parse(decode(await blobs.get(set?.exports['stix']?.sha256 ?? ''))) as {
      objects: { name?: string }[];
    };
    expect(bundle.objects.some((o) => o.name === 'OŁCyŚ (test)')).toBe(true);
    expect(bundle.objects.some((o) => o.name === 'TLP:GREEN')).toBe(true);
  });

  it('registers nothing when an export cannot be saved, so the previous version stays whole', async () => {
    const { repos, blobs, run, fixture } = await seed();
    await storeReport({ repos, blobs }, { ...fixture, run });
    const before = await repos.analysis.latestReport(run.id, 'html');
    const failing = {
      ...blobs,
      has: (sha: string) => blobs.has(sha),
      get: (sha: string) => blobs.get(sha),
      async put(bytes: Uint8Array, mediaType: string) {
        if (mediaType.startsWith('application/stix')) throw new Error('disk full');
        return blobs.put(bytes, mediaType);
      },
    } as typeof blobs;
    const next = { ...fixture, run, generatedAt: '2026-11-22T10:00:00.000Z' };
    await expect(storeReport({ repos, blobs: failing }, next)).rejects.toThrow('disk full');
    expect((await repos.analysis.latestReport(run.id, 'html'))?.blobSha256).toBe(before?.blobSha256);
    expect((await findExportSet({ repos, blobs }, run.id))?.htmlSha256).toBe(before?.blobSha256);
  });

  it('keeps the latest HTML and the latest export set in step when renders overlap', async () => {
    const { repos, blobs, run, fixture } = await seed();
    let setsSeen = 0;
    const slow = {
      ...repos,
      analysis: {
        ...repos.analysis,
        listLinks: repos.analysis.listLinks.bind(repos.analysis),
        async addReport(report: Parameters<typeof repos.analysis.addReport>[0]) {
          // The first export set to be registered is slow, so a second render would overtake it without the lock.
          if (report.kind === 'export_set' && setsSeen++ === 0) await new Promise((r) => setTimeout(r, 30));
          return repos.analysis.addReport(report);
        },
      },
    } as typeof repos;
    const a = { ...fixture, run, generatedAt: '2026-11-22T10:00:00.000Z' };
    const b = { ...fixture, run, generatedAt: '2026-11-22T11:00:00.000Z' };
    await Promise.all([storeReport({ repos: slow, blobs }, a), storeReport({ repos: slow, blobs }, b)]);
    const html = await repos.analysis.latestReport(run.id, 'html');
    expect((await findExportSet({ repos, blobs }, run.id))?.htmlSha256).toBe(html?.blobSha256);
  });

  it('offers no exports when a newer HTML report has none (older or interrupted versions)', async () => {
    const { repos, blobs, run, fixture } = await seed();
    await storeReport({ repos, blobs }, { ...fixture, run });
    expect(await findExportSet({ repos, blobs }, run.id)).toBeDefined();
    const sha = (await blobs.put(new TextEncoder().encode('<p>newer</p>'), 'text/html')).sha256;
    await repos.analysis.addReport({ runId: run.id, kind: 'html', blobSha256: sha, mediaType: 'text/html' });
    expect(await findExportSet({ repos, blobs }, run.id)).toBeUndefined();
  });

  it('assembles the data from the repositories with stable ordering', async () => {
    const { repos, run } = await seed();
    await repos.runs.update(run.id, { progress: { step: 'report.render', partial: ['keybase: blocked'] } });
    const data = await buildReportData(repos, run.id, { generatedAt: '2026-11-21T13:41:00.000Z', reportId: 'r1' });
    expect(data.partialReasons).toEqual(['keybase: blocked']);
    expect(data.previousRun?.id).toBe('run-0001');
    expect(data.earlierCaptures.map((c) => c.id)).toEqual(['cap-0']);
    expect(data.captures.map((c) => c.id)).toEqual(data.captures.map((c) => c.id).toSorted());
    expect(data.rejectedCandidates).toHaveLength(5);
    expect(data.labels.map((l) => l.id)).toEqual(['label-hot1']);
    expect(data.case.identifiers).toHaveLength(1);
    expect('progress' in data.run).toBe(false);
    await expect(buildReportData(repos, 'missing')).rejects.toThrow(/not found/);
  });

  it('tolerates optional fields that other packages have not filled in yet', async () => {
    const { repos, run, fixture } = await seed();
    const bare = { ...fixture.links[1], id: 'link-bare' } as Partial<LinkAssessment>;
    delete bare.paths;
    delete bare.gates;
    delete bare.icd203;
    await repos.analysis.addLinks([bare as LinkAssessment]);
    const thin = { address: { chain: 'bitcoin', address: 'bc1qthin' }, txCount: 0 } as unknown as ActivityIndicators;
    await repos.analysis.addActivity(run.id, [thin]);
    const data = await buildReportData(repos, run.id);
    const html = renderReport(data);
    expect(html).toContain('bc1qthin');
    expect(html).toContain('niemal pewne');
  });
});
