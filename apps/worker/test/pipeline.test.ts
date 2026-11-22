import type { AnalysisRun, Capture, Logger, Observation, Repositories } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import { createCollectStage, createRun, diffWithPrevious, runPipeline, type Stage } from '../src/index.ts';

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

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function newCase(repos: Repositories) {
  return repos.cases.create(
    {
      title: 'Sprawa testowa',
      purpose: 'Test na danych syntetycznych',
      legalBasis: 'test',
      identifiers: [{ kind: 'nickname', value: 'x', isAnchor: true }],
      scope: { enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 0 },
    },
    'test',
  );
}

describe('runPipeline', () => {
  const partialStage: Stage = {
    step: 'chain.fetch',
    async run(ctx) {
      ctx.markPartial('chain data incomplete for 2 address(es): tron timeout (2)', {
        code: 'chain_incomplete',
        params: { count: 2, items: [{ chain: 'tron', status: 'error', count: 2 }] },
      });
    },
  };

  it('ends a rescore as failed, not queued, when the rescored run cannot be read', async () => {
    const repos = createMemoryRepositories();
    const kase = await newCase(repos);
    const first = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    await repos.runs.update(first.id, { status: 'succeeded', finishedAt: nowIso() });
    const rescore = await createRun(
      repos,
      { caseId: kase.id, mode: 'offline', trigger: 'rescore', rescoreOfRunId: first.id },
      CONFIG,
    );
    const get = repos.runs.get.bind(repos.runs);
    repos.runs.get = async (id) => {
      // The rescore itself is readable; the run it rescores is not.
      if (id === first.id) throw new Error('database unavailable');
      return get(id);
    };
    const finished = await runPipeline(rescore.id, {
      repos,
      blobs: new InMemoryBlobStore(),
      logger: silent,
      stages: [],
    });
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('database unavailable');
    expect(finished.finishedAt).toBeDefined();
  });

  it('records reasons with codes and a rescore inherits them', async () => {
    const repos = createMemoryRepositories();
    const kase = await newCase(repos);
    const deps = { repos, blobs: new InMemoryBlobStore(), logger: silent, stages: [partialStage] };
    const first = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
    const run = await runPipeline(first.id, deps);
    expect(run.status).toBe('partial');
    expect(run.progress['partial']).toEqual(['chain data incomplete for 2 address(es): tron timeout (2)']);
    expect(run.progress['partialCodes']).toEqual([
      {
        text: 'chain data incomplete for 2 address(es): tron timeout (2)',
        code: 'chain_incomplete',
        params: { count: 2, items: [{ chain: 'tron', status: 'error', count: 2 }] },
      },
    ]);
    const rescore = await createRun(
      repos,
      { caseId: kase.id, mode: 'offline', trigger: 'rescore', rescoreOfRunId: first.id },
      CONFIG,
    );
    const again = await runPipeline(rescore.id, { ...deps, stages: [] });
    expect(again.status).toBe('partial');
    expect(again.progress['partialCodes']).toEqual(run.progress['partialCodes']);
  });
});
