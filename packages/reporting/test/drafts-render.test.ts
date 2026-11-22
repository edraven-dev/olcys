/** AI-drafted inferences in the report: only confirmed drafts enter it, labelled, and nothing else changes. */
import type { LlmSuggestion, ReportModel } from '@olcys/core';
import { INFERENCE_DRAFT_TASK } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData, buildReportModel, inferencesFromDrafts, renderReport } from '../src/index.ts';
import { personaData } from './fixtures.ts';

const draft = (id: string, patch: Partial<LlmSuggestion> = {}): LlmSuggestion => ({
  id,
  runId: 'run-0002',
  task: INFERENCE_DRAFT_TASK,
  target: { reportId: 'rep-1' },
  label: 'draft',
  output: {
    statement: `Hipoteza ${id} <b>wymaga weryfikacji</b>.`,
    basedOn: ['f-1'],
    alternatives: ['Adres opublikowała osoba trzecia.'],
    verificationSteps: ['Wystąpienie do VASP o dane klienta.'],
  },
  model: 'qwen3.6-35b-ov',
  promptVersion: 'v1',
  callId: 'call-1',
  status: 'pending',
  createdAt: '2026-11-20T10:00:00.000Z',
  ...patch,
});
const confirmed = (id: string, patch: Partial<LlmSuggestion> = {}) =>
  draft(id, {
    status: 'confirmed',
    decidedBy: 'Analityk Testowy',
    decidedAt: '2026-11-21T12:00:00.000Z',
    justification: 'Zgodne z materiałem dowodowym.',
    ...patch,
  });

function sectionC(html: string): string {
  const summary = html.slice(html.indexOf('id="podsumowanie"'));
  const start = summary.indexOf('blk-wnioski');
  return summary.slice(start, summary.indexOf('</section>', start));
}

describe('AI-drafted inferences in the report', () => {
  it('shows only confirmed drafts, labelled as AI-assisted, escaped and with their references', () => {
    const data = personaData();
    const fact = data.observations[0]!;
    data.inferenceDrafts = [
      confirmed('d-ok', { output: { ...(draft('d-ok').output as object), basedOn: [fact.id] } }),
      confirmed('d-edit', { editedText: 'Tekst analityka o adresie.' }),
    ];
    const c = sectionC(renderReport(data));
    expect(c).toContain('Wspomagane AI, zatwierdzone przez analityka: Analityk Testowy');
    expect(c).toContain('Hipoteza d-ok &lt;b&gt;wymaga weryfikacji&lt;/b&gt;.');
    expect(c).toContain('Wyjaśnienia alternatywne');
    expect(c).toContain('Wystąpienie do VASP o dane klienta.');
    expect(c).toContain('tekst zredagowany przez analityka na podstawie sugestii AI');
    expect(c).toContain('Tekst analityka o adresie.');
    expect(c).not.toContain('Hipoteza d-edit');
    expect(c).toContain(`<code class="addr">${fact.id}</code> (<a class="ref" href="#zab-`);
  });

  it('ignores pending and rejected drafts and drafts of another task or shape', () => {
    const rejected = draft('r', { status: 'rejected', decidedBy: 'A', decidedAt: '2026-11-21T12:00:00.000Z' });
    const other = confirmed('o', { task: 'address-role-classification' });
    const broken = confirmed('b', { output: { statement: 1 } });
    expect(inferencesFromDrafts([draft('p'), rejected, other, broken])).toEqual([]);
    const data = personaData();
    expect(renderReport(data)).not.toContain('Wspomagane AI');
  });

  it('adds a labelled AI inference to the model; scores, computed results and the summary stay equal', () => {
    const before = buildReportModel(personaData());
    const data = personaData();
    data.inferenceDrafts = [confirmed('d-1', { editedText: 'Wersja analityka.' })];
    const after: ReportModel = buildReportModel(data);
    expect(after.computed).toEqual(before.computed);
    expect(after.summary).toEqual(before.summary);
    expect(after.inferences.slice(0, before.inferences.length)).toEqual(before.inferences);
    const added = after.inferences.slice(before.inferences.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      origin: 'ai_suggestion',
      statement: 'Wersja analityka.',
      verificationSteps: ['Wystąpienie do VASP o dane klienta.'],
      ai: {
        review: 'edited',
        analyst: 'Analityk Testowy',
        decidedAt: '2026-11-21T12:00:00.000Z',
        draftStatement: 'Hipoteza d-1 <b>wymaga weryfikacji</b>.',
      },
    });
    expect(JSON.stringify(after.summary)).not.toContain('Hipoteza');
  });
});

describe('report data of a run with drafts', () => {
  it('carries only the confirmed drafts, in decision order', async () => {
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
    await repos.runs.create({
      id: 'run-d',
      caseId: kase.id,
      trigger: 'manual',
      mode: 'offline',
      status: 'succeeded',
      config: {
        toolVersion: '0',
        sourcesConfigSha256: 'a',
        weightsVersion: 'w',
        weightsSha256: 'b',
        rulesVersions: {},
      },
      queuedAt: '2026-11-22T10:00:00.000Z',
    });
    const llm = repos.llm!;
    const { status: _s, ...stored } = draft('x');
    await llm.addSuggestions(
      ['d-pending', 'd-rejected', 'd-late', 'd-early'].map((id) => Object.assign({}, stored, { id, runId: 'run-d' })),
    );
    const decide = (id: string, decision: 'confirmed' | 'rejected', decidedAt: string) =>
      llm.decide({
        id: `dec-${id}`,
        suggestionId: id,
        decision,
        justification: 'Uzasadnienie decyzji.',
        decidedBy: 'Analityk Testowy',
        decidedAt,
      });
    await decide('d-rejected', 'rejected', '2026-11-21T09:00:00.000Z');
    await decide('d-late', 'confirmed', '2026-11-21T11:00:00.000Z');
    await decide('d-early', 'confirmed', '2026-11-21T10:00:00.000Z');
    const data = await buildReportData(repos, 'run-d');
    expect(data.inferenceDrafts?.map((d) => d.id)).toEqual(['d-early', 'd-late']);
    expect(data.suggestions).toBeUndefined();
    expect(buildReportModel(data).inferences.map((i) => i.id)).toEqual([
      'inference-draft-d-early',
      'inference-draft-d-late',
    ]);
  });
});
