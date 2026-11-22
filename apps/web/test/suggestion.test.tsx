/** Model suggestions in the console: always labelled as unverified AI until decided; the decision is shown. */
import type { LlmSuggestion } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isRoleSuggestion, SuggestionCard } from '../src/features/links/SuggestionCard.tsx';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const base: LlmSuggestion = {
  id: 's-1',
  runId: 'run-1',
  task: 'address-role-classification',
  target: { candidateId: 'cand-1' },
  label: 'first_person_owner',
  rationale: 'Autor nazywa adres swoim portfelem.',
  output: { role: 'first_person_owner', evidenceSpan: 'mój portfel', agreement: 'differs' },
  model: 'qwen3.6-35b-ov',
  promptVersion: 'v1',
  callId: 'call-1',
  status: 'pending',
  createdAt: '2026-11-21T10:00:00.000Z',
};

describe('SuggestionCard', () => {
  it('shows a pending suggestion as unverified AI with role, span, model and the decision buttons', () => {
    const html = text(renderToStaticMarkup(<SuggestionCard suggestion={base} />));
    expect(html).toContain('Sugestia AI — niezweryfikowana');
    expect(html).toContain('Sugerowana rola: wypowiedź o własności w 1. osobie');
    expect(html).toContain('mój portfel');
    expect(html).toContain('Model qwen3.6-35b-ov, prompt v1');
    expect(html).toContain('Sugestia AI różni się od sygnałów leksykalnych');
    expect(html).toContain('zerowym wpływie na Wskaźnik Pewności');
    expect(html).toContain('Potwierdź');
    expect(html).toContain('Odrzuć');
  });

  it('shows the analyst decision instead of the buttons once decided', () => {
    const confirmed: LlmSuggestion = {
      ...base,
      status: 'confirmed',
      decidedBy: 'Analityk Testowy',
      decidedAt: '2026-11-21T11:00:00.000Z',
      justification: 'Zgodne z treścią wpisu',
    };
    const html = text(renderToStaticMarkup(<SuggestionCard suggestion={confirmed} />));
    expect(html).toContain('Sugestia AI — potwierdzona przez analityka');
    expect(html).not.toContain('Sugestia AI — niezweryfikowana');
    expect(html).toContain('Analityk Testowy');
    expect(html).toContain('Zgodne z treścią wpisu');
    expect(html).not.toContain('Potwierdź');
    const rejected = text(renderToStaticMarkup(<SuggestionCard suggestion={{ ...confirmed, status: 'rejected' }} />));
    expect(rejected).toContain('Sugestia AI — odrzucona przez analityka');
  });

  it('offers no decision buttons when deciding is not allowed', () => {
    expect(text(renderToStaticMarkup(<SuggestionCard suggestion={base} canDecide={false} />))).not.toContain('Odrzuć');
  });

  it('recognises role suggestions only', () => {
    expect(isRoleSuggestion(base)).toBe(true);
    expect(isRoleSuggestion({ ...base, task: 'other' })).toBe(false);
  });
});
