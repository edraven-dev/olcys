import type { AnalysisRun, LlmCallRecord, LlmSuggestionDecision, NewLlmSuggestion, Repositories } from '@olcys/core';
import { newId } from '@olcys/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createMemoryRepositories, createSqlRepositories, migrate, type Db } from '../src/index.ts';

const appUrl = process.env['OLCYS_TEST_DATABASE_URL'];
const ownerUrl = process.env['OLCYS_TEST_DATABASE_URL_OWNER'];
const enabled = Boolean(appUrl && ownerUrl);

async function seedRun(repos: Repositories): Promise<{ runId: string; caseId: string }> {
  const kase = await repos.cases.create(
    {
      title: 'Kacper Fikcyjny (test modelu)',
      purpose: 'Test zapisu wywołań modelu na danych syntetycznych',
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
  await repos.runs.create(run);
  return { runId: run.id, caseId: kase.id };
}

const callOf = (runId: string, caseId: string): LlmCallRecord => ({
  id: newId(),
  caseId,
  runId,
  task: 'test-role',
  promptVersion: 'v1',
  promptSha256: 'a'.repeat(64),
  baseUrl: 'http://localhost:2140/v3',
  modelRequested: 'm',
  modelReported: 'm-reported',
  modelDigest: 'sha256:abc',
  params: { temperature: 0, seed: 0, max_tokens: 100 },
  requestSha256: 'c'.repeat(64),
  requestBlob: { sha256: 'c'.repeat(64), bytes: 10, mediaType: 'application/json' },
  inputSha256: 'b'.repeat(64),
  inputCaptureIds: [newId()],
  inputSourceIds: ['fixture_site'],
  responseBlob: { sha256: 'd'.repeat(64), bytes: 20, mediaType: 'application/json' },
  output: { role: 'own' },
  outcome: 'ok',
  httpStatus: 200,
  latencyMs: 12,
  usage: { total_tokens: 15 },
  startedAt: '2026-11-22T10:00:00.000Z',
  finishedAt: '2026-11-22T10:00:01.000Z',
});

async function lifecycle(repos: Repositories): Promise<{ suggestion: NewLlmSuggestion }> {
  const llm = repos.llm!;
  const { runId, caseId } = await seedRun(repos);
  const call = callOf(runId, caseId);
  await llm.addCall(call);
  const first: NewLlmSuggestion = {
    id: newId(),
    runId,
    task: 'test-role',
    target: { candidateId: newId() },
    label: 'adres własny',
    rationale: 'Wzmianka w stopce.',
    output: { role: 'own' },
    model: 'm-reported',
    modelDigest: 'sha256:abc',
    promptVersion: 'v1',
    callId: call.id,
    createdAt: '2026-11-22T10:00:01.000Z',
  };
  const second: NewLlmSuggestion = { ...first, id: newId(), label: 'depozyt', createdAt: '2026-11-22T10:00:02.000Z' };
  await llm.addSuggestions([second, first]);
  expect((await llm.listSuggestionsByRun(runId)).map((s) => [s.label, s.status])).toEqual([
    ['adres własny', 'pending'],
    ['depozyt', 'pending'],
  ]);
  expect(await llm.getSuggestion(first.id)).toMatchObject({ ...first, status: 'pending' });

  const decision: LlmSuggestionDecision = {
    id: newId(),
    suggestionId: first.id,
    decision: 'confirmed',
    justification: 'Zgodne z profilem.',
    editedText: 'adres własny (potwierdzony)',
    decidedBy: 'Analityk Testowy',
    decidedAt: '2026-11-22T11:00:00.000Z',
  };
  expect(await llm.decide(decision)).toBe(true);
  expect(await llm.decide({ ...decision, id: newId(), decision: 'rejected' })).toBe(false);
  expect(await llm.getSuggestion(first.id)).toMatchObject({
    status: 'confirmed',
    decidedBy: 'Analityk Testowy',
    decidedAt: '2026-11-22T11:00:00.000Z',
    justification: 'Zgodne z profilem.',
    editedText: 'adres własny (potwierdzony)',
  });
  expect((await llm.getSuggestion(second.id))?.status).toBe('pending');
  expect(await llm.getSuggestion(newId())).toBeUndefined();
  return { suggestion: first };
}

describe('model calls and suggestions (memory)', () => {
  it('derive the status from the single decision', async () => {
    await expect(lifecycle(createMemoryRepositories())).resolves.toBeDefined();
  });
});

describe.skipIf(!enabled)(
  'model calls and suggestions (SQL integration: needs OLCYS_TEST_DATABASE_URL[_OWNER])',
  () => {
    let db: Db;
    beforeAll(async () => {
      await migrate(ownerUrl!);
      db = createDb(appUrl!);
    });
    afterAll(async () => {
      await db?.destroy();
    });

    it('derive the status from the single decision', async () => {
      await expect(lifecycle(createSqlRepositories(db))).resolves.toBeDefined();
    });

    it('keeps the logged call as written', async () => {
      const repos = createSqlRepositories(db);
      const { runId, caseId } = await seedRun(repos);
      const call = callOf(runId, caseId);
      await repos.llm!.addCall(call);
      const row = await db.selectFrom('llm_call').selectAll().where('id', '=', call.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        task: 'test-role',
        prompt_version: 'v1',
        prompt_sha256: 'a'.repeat(64),
        base_url: 'http://localhost:2140/v3',
        model_requested: 'm',
        model_reported: 'm-reported',
        model_digest: 'sha256:abc',
        params: { temperature: 0, seed: 0, max_tokens: 100 },
        request_sha256: 'c'.repeat(64),
        request_blob: call.requestBlob,
        response_blob: call.responseBlob,
        input_capture_ids: call.inputCaptureIds,
        input_source_ids: ['fixture_site'],
        output_json: { role: 'own' },
        outcome: 'ok',
        http_status: 200,
      });
    });

    it('cannot be updated, deleted or truncated by the application role', async () => {
      const repos = createSqlRepositories(db);
      const { suggestion } = await lifecycle(repos);
      const denied = /permission denied/;
      await expect(
        db.updateTable('llm_call').set({ error: 'x' }).where('id', '=', suggestion.callId).execute(),
      ).rejects.toThrow(denied);
      await expect(db.deleteFrom('llm_call').where('id', '=', suggestion.callId).execute()).rejects.toThrow(denied);
      await expect(
        db.updateTable('llm_suggestion').set({ label: 'x' }).where('id', '=', suggestion.id).execute(),
      ).rejects.toThrow(denied);
      await expect(db.deleteFrom('llm_suggestion').where('id', '=', suggestion.id).execute()).rejects.toThrow(denied);
      await expect(
        db
          .updateTable('llm_suggestion_decision')
          .set({ decided_by: 'x' })
          .where('suggestion_id', '=', suggestion.id)
          .execute(),
      ).rejects.toThrow(denied);
      await expect(
        db.deleteFrom('llm_suggestion_decision').where('suggestion_id', '=', suggestion.id).execute(),
      ).rejects.toThrow(denied);
      expect((await repos.llm!.getSuggestion(suggestion.id))?.status).toBe('confirmed');
    });
  },
);
