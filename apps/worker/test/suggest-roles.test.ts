/**
 * The `llm.suggest` step with a fake model client (no network): suggestions are stored pending and with zero score
 * weight, Telegram-sourced captures never reach the model, the work is bounded, and an unreachable or failing model
 * never fails the run (it ends `partial` with a coded reason). In-memory store.
 */
import type {
  AddressCandidate,
  AnalysisRun,
  Capture,
  LlmClient,
  LlmRequest,
  LlmResult,
  Logger,
  Repositories,
} from '@olcys/core';
import { newId, nowIso, readPartialReasons } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { describe, expect, it } from 'vitest';
import {
  createRun,
  createSuggestRolesStage,
  defaultStages,
  maxMentionsFromEnv,
  runPipeline,
  type PipelineDeps,
} from '../src/index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const CONFIG: AnalysisRun['config'] = {
  toolVersion: '0.1.0',
  sourcesConfigSha256: 'a'.repeat(64),
  weightsVersion: 'weights.v1',
  weightsSha256: 'b'.repeat(64),
  rulesVersions: {},
};
const SOURCES = [
  { id: 'wykop', llmAllowed: true },
  { id: 'telegram_preview', llmAllowed: false },
] as never;

function fakeModel(mode: 'ok' | 'down' | 'bad_span' | 'throws' = 'ok', enabled = true) {
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    enabled,
    async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push(request as LlmRequest);
      if (mode === 'throws') throw new Error('boom');
      if (mode === 'down') return { ok: false, code: 'timeout', message: 'down', callId: newId() };
      const evidenceSpan = mode === 'bad_span' ? 'nie ma takiego cytatu' : 'mój portfel';
      const output = request.parseOutput({
        role: 'first_person_owner',
        evidenceSpan,
        rationale: 'Autor nazywa adres swoim.',
        confidence: 'high',
      });
      return { ok: true, output, callId: newId(), model: 'fake-model' };
    },
  };
  return { client, requests };
}

function candidate(captureId: string, n: number): AddressCandidate {
  return {
    id: newId(),
    captureId,
    raw: `TFake${n}`,
    address: { chain: 'tron', address: `TFake${String(n).padStart(30, '0')}` },
    format: 'tron_base58',
    checksum: { scheme: 'base58check', present: true, valid: true, bits: 32 },
    chainAttribution: { method: 'format_unique' },
    view: 'visible_text',
    span: { start: 10, end: 20 },
    transforms: [],
    context: {
      snippet: `Cześć, oto mój portfel ${n}: TFake${n} — pozdrawiam wszystkich`,
      inCode: false,
      roleCues: [],
      pageAddressDensity: 1,
      occurrencesInCapture: 1,
    },
    reviewRequired: false,
  };
}

async function capture(repos: Repositories, runId: string, sourceId: string, url: string): Promise<Capture> {
  const c: Capture = {
    id: newId(),
    runId,
    sourceId,
    url,
    finalUrl: url,
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
  await repos.evidence.addCaptures([c]);
  return c;
}

async function setup(counts: { wykop: number; telegram: number }) {
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
  const run = await createRun(repos, { caseId: kase.id, mode: 'offline' }, CONFIG);
  const wykop = await capture(repos, run.id, 'wykop', 'http://127.0.0.1:4100/wykop/p');
  const telegram = await capture(repos, run.id, 'telegram_preview', 'http://127.0.0.1:4100/telegram/s/x');
  const candidates = [
    ...Array.from({ length: counts.telegram }, (_, i) => candidate(telegram.id, 100 + i)),
    ...Array.from({ length: counts.wykop }, (_, i) => candidate(wykop.id, i)),
  ];
  for (const c of candidates) {
    await repos.evidence.addExtraction(run.id, {
      captureId: c.captureId,
      candidates: [c],
      rejected: [],
      secrets: [],
      extractorVersion: 'test',
    });
  }
  const deps = (stage: PipelineDeps['stages'][number]): PipelineDeps => ({
    repos,
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: [stage],
  });
  return { repos, run, wykop, telegram, deps };
}

describe('llm.suggest step', () => {
  it('stores pending suggestions with zero score weight and never sends Telegram captures', async () => {
    const { repos, run, deps } = await setup({ wykop: 2, telegram: 2 });
    const model = fakeModel();
    const links = await repos.analysis.listLinks(run.id);
    const finished = await runPipeline(run.id, deps(createSuggestRolesStage({ sources: SOURCES, llm: model.client })));
    expect(finished.status).toBe('succeeded');
    expect(model.requests).toHaveLength(2);
    expect(model.requests.every((r) => r.inputs.every((i) => i.sourceId === 'wykop' && i.llmAllowed))).toBe(true);
    expect(model.requests.some((r) => r.untrustedInput.includes('TFake1'))).toBe(true);
    expect(model.requests.some((r) => r.untrustedInput.includes('TFake0000000000000000000000000100'))).toBe(false);
    const suggestions = await repos.llm!.listSuggestionsByRun(run.id);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.status === 'pending' && s.label === 'first_person_owner')).toBe(true);
    expect(suggestions.every((s) => s.model === 'fake-model' && s.promptVersion === 'v1')).toBe(true);
    // Zero weight: the step writes no assessment, exclusion or other analysis row.
    expect(await repos.analysis.listLinks(run.id)).toEqual(links);
    expect(await repos.analysis.listExclusions(run.id)).toEqual([]);
  });

  it('is bounded by the per-run limit and counts only calls', async () => {
    const { repos, run, deps } = await setup({ wykop: 5, telegram: 3 });
    const model = fakeModel();
    await runPipeline(run.id, deps(createSuggestRolesStage({ sources: SOURCES, llm: model.client, maxMentions: 3 })));
    expect(model.requests).toHaveLength(3);
    expect(await repos.llm!.listSuggestionsByRun(run.id)).toHaveLength(3);
  });

  it('keeps the run alive when the model is unreachable: partial with a coded reason, calls stop after 3 failures', async () => {
    const { run, deps } = await setup({ wykop: 6, telegram: 0 });
    const model = fakeModel('down');
    const finished = await runPipeline(run.id, deps(createSuggestRolesStage({ sources: SOURCES, llm: model.client })));
    expect(finished.status).toBe('partial');
    expect(model.requests).toHaveLength(3);
    const [reason] = readPartialReasons(finished.progress);
    expect(reason).toMatchObject({ code: 'llm_unavailable', params: { count: 6 } });
  });

  it('survives an exception from the client the same way', async () => {
    const { repos, run, deps } = await setup({ wykop: 2, telegram: 0 });
    const finished = await runPipeline(
      run.id,
      deps(createSuggestRolesStage({ sources: SOURCES, llm: fakeModel('throws').client })),
    );
    expect(finished.status).toBe('partial');
    expect(await repos.llm!.listSuggestionsByRun(run.id)).toEqual([]);
  });

  it('drops an answer whose span is not in the text, without failing or marking the run partial', async () => {
    const { repos, run, deps } = await setup({ wykop: 2, telegram: 0 });
    const finished = await runPipeline(
      run.id,
      deps(createSuggestRolesStage({ sources: SOURCES, llm: fakeModel('bad_span').client })),
    );
    expect(finished.status).toBe('succeeded');
    expect(readPartialReasons(finished.progress)).toEqual([]);
    expect(await repos.llm!.listSuggestionsByRun(run.id)).toEqual([]);
  });

  it('is part of the default pipeline only when the model is enabled', () => {
    const steps = (llm?: LlmClient) =>
      defaultStages({ mode: 'offline', sources: SOURCES, env: {}, ...(llm ? { llm } : {}) }).map((s) => s.step);
    expect(steps()).not.toContain('llm.suggest');
    expect(steps(fakeModel('ok', false).client)).not.toContain('llm.suggest');
    expect(steps(fakeModel().client)).toContain('llm.suggest');
  });

  it('reads the per-run limit from LLM_MAX_MENTIONS_PER_RUN', () => {
    expect(maxMentionsFromEnv({})).toBe(20);
    expect(maxMentionsFromEnv({ LLM_MAX_MENTIONS_PER_RUN: '5' })).toBe(5);
    expect(maxMentionsFromEnv({ LLM_MAX_MENTIONS_PER_RUN: 'x' })).toBe(20);
  });
});
