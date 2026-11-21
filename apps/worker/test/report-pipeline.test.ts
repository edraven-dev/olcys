import type { Capture, Logger, RunConfigSnapshot } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createReportStage } from '@olcys/reporting';
import { describe, expect, it } from 'vitest';
import { createRun, runPipeline, type Stage } from '../src/index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const PROFILE = 'http://127.0.0.1:4100/bitcointalk/index.php?action=profile;u=900001';
const config: RunConfigSnapshot = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: '0'.repeat(64),
  weightsVersion: 'weights.v1',
  weightsSha256: '1'.repeat(64),
  rulesVersions: { exclusion: 'exclusion.v1' },
};

/** Synthetic profile page whose "Bitcoin address" changes between runs. */
function collectStage(wallets: string[]): Stage {
  return {
    step: 'collect.source',
    async run(ctx) {
      const capture: Capture = {
        id: newId(),
        runId: ctx.run.id,
        sourceId: 'bitcointalk',
        url: PROFILE,
        finalUrl: PROFILE,
        collectedAt: nowIso(),
        collector: 'test',
        clockSynced: true,
        toolVersion: '0.1.0',
        userAgent: 'test',
        httpStatus: 200,
        status: 'ok',
        artifacts: [],
        manifestSha256: 'a'.repeat(64),
        fetchIds: [],
      };
      await ctx.repos.evidence.addCaptures([capture]);
      await ctx.repos.evidence.addObservations([
        {
          id: newId(),
          runId: ctx.run.id,
          captureId: capture.id,
          sourceId: 'bitcointalk',
          subject: { type: 'account', key: 'bitcointalk:900001' },
          property: 'profile.bitcoin_address',
          value: wallets.shift() ?? 'bc1qnowy',
          locator: 'bitcointalk:u=900001#profile.bitcoin_address',
          observedAt: nowIso(),
        },
      ]);
    },
  };
}

describe('pipeline with the report stage', () => {
  it('runs report.render after the comparison, so the report shows the wallet swap', async () => {
    const repos = createMemoryRepositories();
    const blobs = new InMemoryBlobStore();
    const kase = await repos.cases.create(
      {
        title: 'Kacper Fikcyjny (test)',
        purpose: 'Test na danych syntetycznych',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
        scope: { enabledSources: ['bitcointalk'], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
      },
      'test',
    );
    const changesSeen: number[] = [];
    const probe: Stage = {
      step: 'report.render',
      async run(ctx) {
        changesSeen.push((await ctx.repos.analysis.listChanges(ctx.run.id)).length);
      },
    };
    // Registered out of order on purpose: the pipeline orders stages around the comparison by step.
    const stages = [probe, createReportStage(), collectStage(['bc1qstary', 'bc1qnowy'])];
    const deps = { repos, blobs, logger: silent, stages };

    const first = await createRun(repos, { caseId: kase.id, mode: 'offline' }, config);
    expect((await runPipeline(first.id, deps)).status).toBe('succeeded');
    const second = await createRun(repos, { caseId: kase.id, mode: 'offline' }, config);
    const finished = await runPipeline(second.id, deps);
    expect(finished).toMatchObject({ status: 'succeeded', progress: { step: 'run.finish', changes: 1 } });
    expect(changesSeen).toEqual([0, 1]);

    const firstReport = await repos.analysis.latestReport(first.id, 'html');
    const report = await repos.analysis.latestReport(second.id, 'html');
    expect(firstReport && report).toBeTruthy();
    const firstHtml = new TextDecoder().decode(await blobs.get(firstReport?.blobSha256 ?? ''));
    const html = new TextDecoder().decode(await blobs.get(report?.blobSha256 ?? ''));
    expect(firstHtml).toContain('Pierwsze uruchomienie — brak wcześniejszego wyniku do porównania.');
    expect(html).toContain('Alert: podmiana adresu portfela w profilu');
    expect(html).toContain('bc1qstary');
    expect(html).toContain('bc1qnowy');
  });
});
