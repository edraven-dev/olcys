import type { AnalysisRun, Capture, Observation, Repositories } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { createCollectStage, createRun, diffWithPrevious } from '../src/index.ts';

const CONFIG: AnalysisRun['config'] = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: 'a'.repeat(64),
  weightsVersion: 'weights.v1',
  weightsSha256: 'b'.repeat(64),
  rulesVersions: {},
};
const LOC = 'bitcointalk:u=900001#profile.bitcoin_address';

async function collected(repos: Repositories, run: AnalysisRun, wallet: string): Promise<void> {
  const capture: Capture = {
    id: newId(),
    runId: run.id,
    sourceId: 'bitcointalk',
    url: 'http://127.0.0.1:4100/p',
    finalUrl: 'http://127.0.0.1:4100/p',
    collectedAt: nowIso(),
    collector: 'test',
    clockSynced: true,
    toolVersion: '0.1.0',
    userAgent: 'test',
    httpStatus: 200,
    status: 'ok',
    artifacts: [],
    manifestSha256: '0'.repeat(64),
    fetchIds: [],
  };
  const observation: Observation = {
    id: newId(),
    runId: run.id,
    captureId: capture.id,
    sourceId: 'bitcointalk',
    subject: { type: 'account', key: 'bitcointalk:900001' },
    property: 'profile.bitcoin_address',
    value: wallet,
    locator: LOC,
    observedAt: nowIso(),
  };
  await repos.evidence.addCaptures([capture]);
  await repos.evidence.addObservations([observation]);
  await repos.runs.update(run.id, { status: 'succeeded', finishedAt: nowIso() });
}

describe('diffWithPrevious', () => {
  it('compares with the predecessor recorded at creation, even when runs overlap', async () => {
    const repos = createMemoryRepositories();
    const kase = await repos.cases.create(
      {
        title: 'Test',
        purpose: 'Test',
        legalBasis: 'demonstracja',
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', isAnchor: true }],
        scope: { enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 1 },
      },
      'test',
    );
    const baseline = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    await collected(repos, baseline, 'bc1qbazowy');
    const slow = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    const fast = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    expect([slow.previousRunId, fast.previousRunId]).toEqual([baseline.id, baseline.id]);
    await collected(repos, fast, 'bc1qszybki');
    await collected(repos, slow, 'bc1qwolny');
    const changes = await diffWithPrevious(repos, (await repos.runs.get(slow.id))!);
    expect(changes.map((c) => [c.kind, c.before, c.after, c.previousRunId])).toEqual([
      ['VALUE_CHANGED', 'bc1qbazowy', 'bc1qwolny', baseline.id],
    ]);
    expect(await diffWithPrevious(repos, (await repos.runs.get(baseline.id))!)).toEqual([]);
  });
});

describe('collect stage configuration', () => {
  it('refuses an unknown search mode when the stage is created, not in every run', () => {
    expect(() => createCollectStage({ mode: 'offline', sources: [], env: { OLCYS_SEARCH_MODE: 'google' } })).toThrow(
      /OLCYS_SEARCH_MODE must be one of off, mock, external/,
    );
    expect(createCollectStage({ mode: 'offline', sources: [], env: {} }).step).toBe('collect.source');
  });
});
