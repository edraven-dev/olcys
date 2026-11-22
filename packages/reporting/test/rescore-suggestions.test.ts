/** A rescore's report shows the confirmed suggestions its snapshot lists, as recorded when it was queued. */
import type { AddressCandidate, AnalysisRun, Capture, LlmSuggestion } from '@olcys/core';
import { newId } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData } from '../src/index.ts';

const CONFIG = {
  toolVersion: '0',
  sourcesConfigSha256: 'a',
  weightsVersion: 'w',
  weightsSha256: 'b',
  rulesVersions: {},
};

const candidate = (captureId: string, n: number): AddressCandidate => ({
  id: newId(),
  captureId,
  raw: `TFake${n}`,
  address: { chain: 'tron', address: `TFake${String(n).padStart(30, '0')}` },
  format: 'tron_base58',
  checksum: { scheme: 'base58check', present: true, valid: true, bits: 32 },
  chainAttribution: { method: 'format_unique' },
  view: 'visible_text',
  span: { start: n, end: n + 6 },
  transforms: [],
  context: {
    snippet: `mój portfel TFake${n}`,
    inCode: false,
    roleCues: [],
    pageAddressDensity: 1,
    occurrencesInCapture: 1,
  },
  reviewRequired: false,
});

describe('role suggestions in a rescore report', () => {
  it('shows exactly the suggestions of the snapshot, on the re-extracted candidates, never later decisions', async () => {
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
    const run = (over: Partial<AnalysisRun>): AnalysisRun => ({
      id: newId(),
      caseId: kase.id,
      trigger: 'manual',
      mode: 'offline',
      status: 'succeeded',
      config: CONFIG,
      queuedAt: '2026-11-22T10:00:00.000Z',
      ...over,
    });
    const original = run({});
    await repos.runs.create(original);
    const capture: Capture = {
      id: newId(),
      runId: original.id,
      sourceId: 'wykop',
      url: 'http://127.0.0.1/p',
      finalUrl: 'http://127.0.0.1/p',
      collectedAt: '2026-11-22T10:00:00.000Z',
      collector: 'test',
      clockSynced: true,
      toolVersion: '0',
      userAgent: 'test',
      httpStatus: 200,
      status: 'ok',
      artifacts: [],
      manifestSha256: '0'.repeat(64),
      fetchIds: [],
    };
    await repos.evidence.addCaptures([capture]);
    const [c1, c2] = [candidate(capture.id, 1), candidate(capture.id, 2)] as [AddressCandidate, AddressCandidate];
    for (const c of [c1, c2]) {
      await repos.evidence.addExtraction(original.id, {
        captureId: capture.id,
        candidates: [c],
        rejected: [],
        secrets: [],
        extractorVersion: 't',
      });
    }
    const callId = newId();
    await repos.llm!.addCall({
      id: callId,
      runId: original.id,
      task: 'address-role-classification',
      promptVersion: 'v1',
      promptSha256: 'a'.repeat(64),
      baseUrl: 'http://localhost:2140/v3',
      modelRequested: 'm',
      params: {},
      inputSha256: 'b'.repeat(64),
      inputCaptureIds: [],
      inputSourceIds: [],
      outcome: 'ok',
      startedAt: '2026-11-22T10:00:00.000Z',
      finishedAt: '2026-11-22T10:00:01.000Z',
    });
    const suggestion = (candidateId: string, label: string, span: string): LlmSuggestion => ({
      id: newId(),
      runId: original.id,
      task: 'address-role-classification',
      target: { candidateId },
      label,
      output: { role: label, evidenceSpan: span },
      model: 'm',
      promptVersion: 'v1',
      callId,
      status: 'pending',
      createdAt: '2026-11-22T10:00:01.000Z',
    });
    const s1 = suggestion(c1.id, 'first_person_owner', 'mój portfel');
    const s2 = suggestion(c2.id, 'quote', 'cytat drugi');
    await repos.llm!.addSuggestions([s1, s2]);
    const decide = (id: string, decision: 'confirmed' | 'rejected', decidedAt: string) =>
      repos.llm!.decide({
        id: newId(),
        suggestionId: id,
        decision,
        justification: 'Decyzja analityka w teście',
        decidedBy: 'Analityk Testowy',
        decidedAt,
      });
    await decide(s1.id, 'confirmed', '2026-11-22T11:00:00.000Z');
    // The rescore re-extracts the capture under new ids and lists only what was confirmed when it was queued.
    const r1 = candidate(capture.id, 1);
    const r2 = candidate(capture.id, 2);
    const rescore = run({
      trigger: 'rescore',
      rescoreOfRunId: original.id,
      queuedAt: '2026-11-22T12:00:00.000Z',
      config: {
        ...CONFIG,
        confirmedSuggestions: [
          {
            suggestionId: s1.id,
            decidedAt: '2026-11-22T11:00:00.000Z',
            role: 'first_person_owner',
            candidateId: c1.id,
            address: c1.address,
          },
        ],
      },
    });
    await repos.runs.create(rescore);
    for (const c of [r1, r2]) {
      await repos.evidence.addExtraction(rescore.id, {
        captureId: capture.id,
        candidates: [c],
        rejected: [],
        secrets: [],
        extractorVersion: 't',
      });
    }
    // Decided after the rescore was queued: must not show.
    await decide(s2.id, 'rejected', '2026-11-22T13:00:00.000Z');

    const data = await buildReportData(repos, rescore.id, { evidenceRunId: original.id });
    expect(data.suggestions).toHaveLength(1);
    expect(data.suggestions?.[0]).toMatchObject({
      id: s1.id,
      status: 'confirmed',
      decidedAt: '2026-11-22T11:00:00.000Z',
      target: { candidateId: r1.id },
    });
    // The original run's own report still shows both with their current status.
    const own = await buildReportData(repos, original.id);
    expect(own.suggestions?.map((s) => s.status).toSorted()).toEqual(['confirmed', 'rejected']);
  });
});
