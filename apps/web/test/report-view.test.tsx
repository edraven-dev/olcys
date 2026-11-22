// @vitest-environment happy-dom
import type { Capture, ReportModel } from '@olcys/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportDocument } from '../src/features/report/ReportDocument.tsx';
import { pl } from '../src/i18n/pl.ts';
import { setFetch } from '../src/lib/api.ts';
import { personaReport } from './fixtures/persona-report.ts';
import { capture } from './fixtures/persona.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = (report: ReportModel): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<ReportDocument report={report} />);
  return host;
};
const section = (host: HTMLElement, id: string): HTMLElement => {
  const heading = host.querySelector(`#${id}`);
  const found = heading?.closest('section');
  expect(found).toBeTruthy();
  return found as HTMLElement;
};

describe('report document', () => {
  const host = dom(personaReport);

  it('shows the sections in the required order', () => {
    const headings = [...host.querySelectorAll('section > h3[id^="report-"], section > div > h3[id^="report-"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual([
      'Blok odtwarzalności',
      'Podsumowanie',
      'A. Fakty źródłowe',
      'B. Wyniki obliczeń',
      'C. Wnioski wymagające weryfikacji',
      'Chronologia przepływu środków',
      'Zmiany od poprzedniej analizy',
      'Rejestr dowodów',
    ]);
  });

  it('keeps every statement inside its own class section', () => {
    const facts = section(host, 'report-facts');
    const computed = section(host, 'report-computed');
    const inferences = section(host, 'report-inferences');
    expect(personaReport.facts.length).toBeGreaterThan(0);
    for (const f of personaReport.facts) {
      expect(facts.textContent).toContain(f.statement);
      expect(computed.textContent).not.toContain(f.statement);
      expect(inferences.textContent).not.toContain(f.statement);
    }
    for (const c of personaReport.computed) {
      expect(computed.textContent).toContain(c.statement);
      expect(facts.textContent).not.toContain(c.statement);
      expect(inferences.textContent).not.toContain(c.statement);
    }
    for (const i of personaReport.inferences) {
      expect(inferences.textContent).toContain(i.statement);
      expect(facts.textContent).not.toContain(i.statement);
      expect(computed.textContent).not.toContain(i.statement);
    }
  });

  it('gives each likelihood its own paragraph and the analytic confidence a separate sentence', () => {
    const summary = section(host, 'report-summary');
    const paragraphs = [...summary.querySelectorAll('p')].map((p) => p.textContent);
    for (const statement of personaReport.summary.likelihoodStatements) expect(paragraphs).toContain(statement);
    expect(paragraphs).toContain('Pewność analityczna oceny: umiarkowana.');
    const mixed = paragraphs.filter(
      (p) => /pewność analityczna/i.test(p ?? '') && /prawdopodobne|niemal pewne/.test(p ?? ''),
    );
    expect(mixed).toEqual([]);
  });

  it('shows the reproducibility block', () => {
    const text = section(host, 'report-repro').textContent ?? '';
    for (const expected of [
      'weights.v1',
      'lr.v1',
      'exclusion.v1',
      'cashout.v1',
      'offline',
      '0.1.0',
      'nieskalibrowane',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('b'.repeat(12));
  });

  it('labels every inference as needing verification and the origin distinctly', () => {
    const withAi: ReportModel = {
      ...personaReport,
      inferences: [
        ...personaReport.inferences,
        {
          id: 'inference-ai',
          statement: 'Propozycja modelu: adres może należeć do osoby.',
          basedOn: [],
          alternatives: ['Adres należy do osoby trzeciej.'],
          origin: 'ai_suggestion',
          requiresVerification: true,
        },
      ],
    };
    const inferences = section(dom(withAi), 'report-inferences');
    expect(inferences.textContent).toContain('Sugestia AI — niezweryfikowana');
    expect(inferences.textContent).toContain('Reguła');
    expect(inferences.textContent).toContain(pl.report.alternatives);
    expect(inferences.querySelectorAll('.tag-ai')).toHaveLength(1);
    expect(inferences.textContent?.split(pl.report.requiresVerification).length).toBe(withAi.inferences.length + 1);
  });

  it('links computed items to the facts they rest on and shows data as text, never as markup', () => {
    const hostile: ReportModel = {
      ...personaReport,
      computed: personaReport.computed.map((c, i) =>
        i === personaReport.computed.findIndex((x) => x.basedOn.length > 0)
          ? { ...c, data: { note: '<script>alert(1)</script>' } }
          : c,
      ),
    };
    const result = dom(hostile);
    const computed = section(result, 'report-computed');
    const link = computed.querySelector('a[href^="#fact-"]');
    expect(link).toBeTruthy();
    const targetId = link?.getAttribute('href')?.slice(1) ?? '';
    expect(result.querySelector(`[id="${targetId}"]`)).toBeTruthy();
    expect(computed.textContent).toContain('<script>alert(1)</script>');
    expect(result.querySelector('script')).toBeNull();
  });

  it('lists the evidence register with digests and the timestamp state', () => {
    const register = section(host, 'report-register');
    expect(register.querySelectorAll('tbody tr')).toHaveLength(personaReport.evidenceRegister.length);
    expect(register.textContent).toContain(pl.report.timestampNone);
    expect(register.textContent).toContain(personaReport.evidenceRegister[0]?.sourceName ?? 'missing');
  });
});

describe('capture card on demand', () => {
  let root: Root;
  let container: HTMLElement;
  const requested: string[] = [];
  beforeEach(() => {
    requested.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    setFetch(async (input) => {
      requested.push(input);
      const body: Capture = { ...capture, id: 'cap-1' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads and shows the capture only after „Pokaż zabezpieczenie”', async () => {
    act(() => root.render(<ReportDocument report={{ ...personaReport, changesSincePrevious: [] }} />));
    expect(requested).toEqual([]);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === pl.report.showCapture);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual([`/api/captures/${personaReport.facts[0]?.captureId}`]);
    expect(container.querySelector('.capture-card')).toBeTruthy();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });
});
