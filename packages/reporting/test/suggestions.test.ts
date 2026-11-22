/** Model suggestions in the report: listed under the inferences with their status, never as facts. */
import type { LlmSuggestion } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/index.ts';
import { personaData } from './fixtures.ts';

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

const suggestion = (candidateId: string, patch: Partial<LlmSuggestion> = {}): LlmSuggestion => ({
  id: `s-${candidateId}`,
  runId: 'run-1',
  task: 'address-role-classification',
  target: { candidateId },
  label: 'first_person_owner',
  output: { role: 'first_person_owner', evidenceSpan: 'mój portfel <b>', agreement: 'agrees' },
  model: 'qwen3.6-35b-ov',
  promptVersion: 'v1',
  callId: 'call-1',
  status: 'pending',
  createdAt: '2026-11-20T10:00:00.000Z',
  ...patch,
});

describe('AI role suggestions in the report', () => {
  it('lists them among the inferences with their status, escaped, and not among facts or computed results', () => {
    const data = personaData();
    const cand = data.candidates[0]!;
    data.suggestions = [
      suggestion(cand.id),
      suggestion(cand.id, {
        id: 's-confirmed',
        status: 'confirmed',
        decidedBy: 'Analityk Testowy',
        decidedAt: '2026-11-21T10:00:00.000Z',
      }),
      suggestion(cand.id, {
        id: 's-rejected',
        status: 'rejected',
        decidedBy: 'Analityk Testowy',
        decidedAt: '2026-11-21T10:00:00.000Z',
      }),
    ];
    const summary = sectionOf(renderReport(data), 'podsumowanie');
    const inferences = summary.slice(summary.indexOf('blk-wnioski'));
    expect(inferences).toContain('Sugestia AI — niezweryfikowana');
    expect(inferences).toContain('potwierdzona przez analityka Analityk Testowy');
    expect(inferences).toContain('odrzucona przez analityka Analityk Testowy');
    expect(inferences).toContain('wypowiedź o własności w 1. osobie');
    expect(inferences).toContain('zerowy wpływ na Wskaźnik Pewności');
    expect(inferences).toContain('&lt;b&gt;');
    expect(inferences).not.toContain('<b>');
    const beforeInferences = summary.slice(0, summary.indexOf('blk-wnioski'));
    expect(beforeInferences).not.toContain('Sugestia AI');
  });

  it('omits the section content when the run has no suggestions', () => {
    expect(renderReport(personaData())).not.toContain('Sugestia AI');
  });
});
