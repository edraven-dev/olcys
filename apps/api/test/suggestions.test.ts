import type { AnalysisRun, LlmSuggestion, NewLlmSuggestion } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { InMemoryBlobStore } from '@olcys/evidence';
import { createRuntime, type Runtime } from '@olcys/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { silent } from './analyst-fixtures.ts';

const LLM_ENV = {
  OLCYS_MODE: 'offline',
  LLM_ENABLED: 'true',
  LLM_BASE_URL: 'http://localhost:2140/v3',
  LLM_MODEL: 'm',
};
const ANALYST = 'Analityk Testowy';

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let runId: string;

async function suggestion(): Promise<NewLlmSuggestion> {
  const callId = newId();
  await runtime.repos.llm!.addCall({
    id: callId,
    runId,
    task: 'test-role',
    promptVersion: 'v1',
    promptSha256: 'a'.repeat(64),
    baseUrl: LLM_ENV.LLM_BASE_URL,
    modelRequested: 'm',
    params: {},
    inputSha256: 'b'.repeat(64),
    inputCaptureIds: [],
    inputSourceIds: [],
    outcome: 'ok',
    startedAt: '2026-11-22T10:00:00.000Z',
    finishedAt: '2026-11-22T10:00:01.000Z',
  });
  const s: NewLlmSuggestion = {
    id: newId(),
    runId,
    task: 'test-role',
    target: {},
    label: 'adres własny',
    rationale: 'Wzmianka w stopce profilu.',
    model: 'm',
    promptVersion: 'v1',
    callId,
    createdAt: '2026-11-22T10:00:01.000Z',
  };
  await runtime.repos.llm!.addSuggestions([s]);
  return s;
}

const decide = (id: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/suggestions/${id}/decision`, payload: payload as object });

beforeAll(async () => {
  runtime = await createRuntime({
    env: LLM_ENV,
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
  });
  app = buildApp({ ...runtime, analyst: ANALYST });
  const kase = await runtime.repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test sugestii)',
      purpose: 'Test decyzji o sugestiach na danych syntetycznych',
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
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('suggestions', () => {
  it('announces the feature only when the model is enabled', async () => {
    expect((await app.inject('/api/meta')).json().features.suggestions).toBe(true);
    const off = await createRuntime({
      env: { OLCYS_MODE: 'offline' },
      repos: createMemoryRepositories(),
      blobs: new InMemoryBlobStore(),
      logger: silent,
    });
    const offApp = buildApp({ ...off, analyst: ANALYST });
    expect((await offApp.inject('/api/meta')).json().features.suggestions).toBe(false);
    await offApp.close();
    await off.close();
  });

  it('lists the suggestions of a run as pending', async () => {
    const s = await suggestion();
    const items = (await app.inject(`/api/runs/${runId}/suggestions`)).json().items as LlmSuggestion[];
    expect(items.find((i) => i.id === s.id)).toMatchObject({ status: 'pending', label: 'adres własny' });
  });

  it('confirms with a justification, records the configured analyst and refuses a second decision', async () => {
    const s = await suggestion();
    const first = await decide(s.id, {
      decision: 'confirmed',
      justification: 'Zgodne z profilem.',
      analyst: 'ktoś inny',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: s.id,
      status: 'confirmed',
      decidedBy: ANALYST,
      justification: 'Zgodne z profilem.',
    });
    expect(first.json().decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const second = await decide(s.id, { decision: 'rejected', justification: 'Zmiana zdania po namyśle.' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('already_decided');
    expect((await runtime.repos.llm!.getSuggestion(s.id))?.status).toBe('confirmed');
  });

  it('rejects a short justification, an unknown decision and an unknown suggestion', async () => {
    const s = await suggestion();
    expect((await decide(s.id, { decision: 'confirmed', justification: 'krótko' })).statusCode).toBe(400);
    expect((await decide(s.id, { decision: 'maybe', justification: 'Wystarczająco długie.' })).statusCode).toBe(400);
    expect((await decide(newId(), { decision: 'confirmed', justification: 'Wystarczająco długie.' })).statusCode).toBe(
      404,
    );
    expect((await runtime.repos.llm!.getSuggestion(s.id))?.status).toBe('pending');
  });
});
