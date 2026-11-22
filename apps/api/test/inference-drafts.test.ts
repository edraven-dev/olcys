/** Drafts for section C: explicit trigger, typed failures, decisions, and only confirmed drafts in the report. */
import type {
  AddressCandidate,
  AnalysisRun,
  Capture,
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmSuggestion,
} from '@olcys/core';
import { INFERENCE_DRAFT_TASK, newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { buildReportData, storeReport } from '@olcys/reporting';
import { createDraftInferencer, createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { reportRenderer } from '../src/stages.ts';
import { silent } from './analyst-fixtures.ts';

const ANALYST = 'Analityk Testowy';
let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let runId: string;
let wykopFact: string;
let telegramFact: string;
const requests: LlmRequest[] = [];
let mode: 'ok' | 'timeout' | 'unknown_id' = 'ok';

const fake: LlmClient = {
  enabled: true,
  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    requests.push(request as LlmRequest);
    if (mode === 'timeout') return { ok: false, code: 'timeout', message: 'down', callId: newId() };
    const basedOn = mode === 'unknown_id' ? ['F:nie-ma'] : [`F:${wykopFact}`];
    const draft = {
      statement: 'Wpis może wskazywać na posługiwanie się adresem; wymaga weryfikacji.',
      basedOn,
      alternatives: ['Wpis mógł pochodzić od osoby trzeciej.'],
      verificationSteps: ['Wystąpienie do dostawcy usług kryptoaktywów (VASP).'],
    };
    return { ok: true, output: request.parseOutput({ drafts: [draft] }), callId: newId(), model: 'fake-model' };
  },
};

const capture = (sourceId: string, url: string): Capture => ({
  id: newId(),
  runId,
  sourceId,
  url,
  finalUrl: url,
  collectedAt: '2026-11-22T10:00:00.000Z',
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

const candidate = (captureId: string, address: string): AddressCandidate => ({
  id: newId(),
  captureId,
  raw: address,
  address: { chain: 'tron', address },
  format: 'tron_base58',
  checksum: { scheme: 'base58check', present: true, valid: true, bits: 32 },
  chainAttribution: { method: 'format_unique' },
  view: 'visible_text',
  span: { start: 0, end: 6 },
  transforms: [],
  context: {
    snippet: `mój portfel: ${address}`,
    inCode: false,
    roleCues: [],
    pageAddressDensity: 1,
    occurrencesInCapture: 1,
  },
  reviewRequired: false,
});

const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload });
const list = async () => (await app.inject(`/api/runs/${runId}/suggestions`)).json().items as LlmSuggestion[];
const drafts = async () => (await list()).filter((s) => s.task === INFERENCE_DRAFT_TASK);
const renderedInferences = async () => {
  await reportRenderer(runtime)((await runtime.repos.runs.get(runId))!);
  const view = (await app.inject(`/api/runs/${runId}/report/view`)).json();
  return view.report.inferences as {
    id: string;
    statement: string;
    origin: string;
    ai?: { review: string; analyst: string };
  }[];
};

beforeAll(async () => {
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline', LLM_ENABLED: 'true', LLM_BASE_URL: 'http://localhost:2140/v3', LLM_MODEL: 'm' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: () => [],
  });
  app = buildApp({
    ...runtime,
    analyst: ANALYST,
    llm: fake,
    draftInferences: createDraftInferencer({
      repos: runtime.repos,
      blobs: runtime.blobs,
      sources: runtime.sources,
      llm: fake,
      logger: silent,
    }),
    renderReport: reportRenderer(runtime),
  });
  const kase = await runtime.repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test wniosków)',
      purpose: 'Test szkiców wniosków na danych syntetycznych',
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
    queuedAt: '2026-11-22T10:00:00.000Z',
  };
  await runtime.repos.runs.create(run);
  runId = run.id;
  const wykop = capture('wykop', 'http://127.0.0.1:4100/wykop/ludzie/fikcyjny_kacper');
  const telegram = capture('telegram_preview', 'http://127.0.0.1:4100/telegram/s/olcys_test');
  await runtime.repos.evidence.addCaptures([wykop, telegram]);
  const w = candidate(wykop.id, 'TFake000000000000000000000000000001');
  const t = candidate(telegram.id, 'TFake000000000000000000000000000002');
  wykopFact = w.id;
  telegramFact = t.id;
  for (const [c, cap] of [
    [w, wykop],
    [t, telegram],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await runtime.repos.evidence.addExtraction(run.id, {
      captureId: cap.id,
      candidates: [c],
      rejected: [],
      secrets: [],
      extractorVersion: 'test',
    });
  }
  await storeReport(runtime, await buildReportData(runtime.repos, runId, { sources: runtime.sources }));
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('draft inferences route', () => {
  it('announces the feature only with the model, and answers 409 llm_disabled without it', async () => {
    expect((await app.inject('/api/meta')).json().features.inferenceDrafts).toBe(true);
    const off = buildApp({ ...runtime, analyst: ANALYST, llm: { enabled: false } });
    expect((await off.inject('/api/meta')).json().features.inferenceDrafts).toBe(false);
    const refused = await off.inject({ method: 'POST', url: `/api/runs/${runId}/report/drafts`, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('llm_disabled');
    await off.close();
    expect(await drafts()).toEqual([]);
  });

  it('answers 404 for an unknown run', async () => {
    expect((await post(`/api/runs/${newId()}/report/drafts`)).statusCode).toBe(404);
  });

  it('turns a model failure into a typed result and stores nothing', async () => {
    mode = 'timeout';
    const response = await post(`/api/runs/${runId}/report/drafts`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'failed', reason: 'timeout' });
    expect(await drafts()).toEqual([]);
  });

  it('drops a draft that cites an unknown id', async () => {
    mode = 'unknown_id';
    const response = await post(`/api/runs/${runId}/report/drafts`);
    expect(response.json()).toEqual({ status: 'drafted', created: 0, dropped: { unknownBasis: 1, restatesScore: 0 } });
    expect(await drafts()).toEqual([]);
  });

  it('stores pending drafts, never sends Telegram items, and does not draft again while some are pending', async () => {
    mode = 'ok';
    requests.length = 0;
    const response = await post(`/api/runs/${runId}/report/drafts`);
    expect(response.json()).toMatchObject({ status: 'drafted', created: 1 });
    expect(requests[0]?.untrustedInput).toContain(`[F:${wykopFact}]`);
    expect(requests[0]?.untrustedInput).not.toContain(telegramFact);
    expect(requests[0]?.untrustedInput).not.toContain('olcys_test');
    const [stored] = await drafts();
    expect(stored).toMatchObject({ status: 'pending', label: 'draft', model: 'fake-model' });
    expect((stored?.output as { basedOn: string[] }).basedOn).toEqual([wykopFact]);
    expect((await post(`/api/runs/${runId}/report/drafts`)).json()).toEqual({
      status: 'skipped',
      reason: 'pending_drafts',
    });
  });

  it('keeps pending drafts out of the report and shows a confirmed, edited one labelled', async () => {
    expect((await renderedInferences()).filter((i) => i.origin === 'ai_suggestion')).toEqual([]);
    const [stored] = await drafts();
    const decided = await post(`/api/suggestions/${stored?.id}/decision`, {
      decision: 'confirmed',
      justification: 'Zgodne z materiałem dowodowym.',
      editedText: 'Wpis wskazuje na możliwe posługiwanie się adresem przez autora.',
    });
    expect(decided.statusCode).toBe(200);
    const ai = (await renderedInferences()).filter((i) => i.origin === 'ai_suggestion');
    expect(ai).toHaveLength(1);
    expect(ai[0]).toMatchObject({
      statement: 'Wpis wskazuje na możliwe posługiwanie się adresem przez autora.',
      ai: { review: 'edited', analyst: ANALYST },
    });
  });
});
