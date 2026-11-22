// @vitest-environment happy-dom
/** Draft inferences in the report tab: the button follows the model feature, drafts are labelled, failures are messages. */
import type { DraftInferencesResult, LlmSuggestion, RunWithProgress } from '@olcys/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportDocument } from '../src/features/report/ReportDocument.tsx';
import { resultMessage } from '../src/features/report/DraftInferences.tsx';
import { ReportTab, REPORT_POLL_SCHEDULE_MS } from '../src/features/report/ReportTab.tsx';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { setFetch } from '../src/lib/api.ts';
import { personaView } from './fixtures/persona-report.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = {
  run: { id: 'run-d', caseId: 'case-1', mode: 'offline', status: 'succeeded' } as unknown as RunWithProgress,
  kase: { id: 'case-1', title: 'Sprawa testowa', identifiers: [] },
  version: 'v-d',
} as unknown as RunScope;

const pending: LlmSuggestion = {
  id: 'draft-1',
  runId: 'run-d',
  task: 'report-inference-draft',
  target: { reportId: 'rep-1' },
  label: 'draft',
  output: {
    statement: 'Wpis może wskazywać na posługiwanie się adresem.',
    basedOn: ['f-1'],
    alternatives: ['Wpis pochodzi od osoby trzeciej.'],
    verificationSteps: ['Wystąpienie do VASP.'],
  },
  model: 'qwen3.6-35b-ov',
  promptVersion: 'v1',
  callId: 'call-1',
  status: 'pending',
  createdAt: '2026-11-21T10:00:00.000Z',
};

let host: HTMLElement;
let root: Root;
let features: Record<string, boolean>;
let items: LlmSuggestion[];
let drafted: DraftInferencesResult;
let viewVersion = 'v-initial';
let bumpOnDecision = true;
let viewGets = 0;
const posted: string[] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  features = { inferenceDrafts: true };
  items = [];
  posted.length = 0;
  viewVersion = 'v-initial';
  bumpOnDecision = true;
  viewGets = 0;
  drafted = { status: 'failed', reason: 'timeout' };
  setFetch(async (input, init) => {
    if (init?.method === 'POST') {
      posted.push(input);
      if (input.endsWith('/decision')) {
        if (bumpOnDecision) viewVersion = 'v-rendered';
        return new Response(JSON.stringify({ ...pending, status: 'confirmed' }), { status: 200 });
      }
      return new Response(JSON.stringify(drafted), { status: 200 });
    }
    if (input.endsWith('/report/view')) {
      viewGets += 1;
      return new Response(JSON.stringify({ ...personaView, version: viewVersion }), { status: 200 });
    }
    if (input.endsWith('/suggestions')) return new Response(JSON.stringify({ items }), { status: 200 });
    if (input.startsWith('/api/captures/')) return new Response('{}', { status: 404 });
    if (input === '/api/meta') return new Response(JSON.stringify({ features }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);

describe('draft inferences in the report tab', () => {
  it('offers the button only when the model is enabled', async () => {
    features = {};
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    expect(buttons()).not.toContain('Zaproponuj wnioski (AI)');
    expect(host.textContent).not.toContain('Sugestia AI — niezweryfikowana');
  });

  it('shows a failure as a Polish message and lists pending drafts as unverified AI suggestions', async () => {
    items = [pending, { ...pending, id: 'role', task: 'address-role-classification' }];
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    expect(buttons()).toContain('Zaproponuj wnioski (AI)');
    const text = host.textContent ?? '';
    expect(text).toContain('Sugestia AI — niezweryfikowana');
    expect(text).toContain('Wpis może wskazywać na posługiwanie się adresem.');
    expect(text).toContain('Wystąpienie do VASP.');
    expect(text).toContain('Szkic niepotwierdzony nie trafia do raportu ani do PDF.');
    expect(buttons()).toContain('Potwierdź');

    const propose = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Zaproponuj wnioski (AI)');
    act(() => propose?.click());
    await flush();
    expect(posted).toEqual(['/api/runs/run-d/report/drafts']);
    expect(host.textContent).toContain('Model nie jest dostępny');
    expect(host.textContent).toContain('przekroczono czas oczekiwania');
  });
});

describe('resultMessage', () => {
  it('words every typed result in Polish', () => {
    expect(resultMessage({ status: 'drafted', created: 2, dropped: { unknownBasis: 1, restatesScore: 1 } })).toBe(
      'Dodano szkiców: 2. Odrzucone przez kontrolę: 2.',
    );
    expect(resultMessage({ status: 'drafted', created: 0, dropped: { unknownBasis: 1, restatesScore: 0 } })).toContain(
      'nie zaproponował',
    );
    expect(resultMessage({ status: 'skipped', reason: 'pending_drafts' })).toContain('rozstrzygnij');
    expect(resultMessage({ status: 'skipped', reason: 'no_report' })).toContain('nie jest jeszcze gotowy');
  });
});

describe('confirmed draft in the report document', () => {
  it('is labelled as AI-assisted with the analyst and the verification steps', () => {
    const report = {
      ...personaView.report,
      inferences: [
        {
          id: 'inference-draft-1',
          statement: 'Tekst analityka.',
          basedOn: [],
          alternatives: ['Inna możliwość.'],
          verificationSteps: ['Wystąpienie do VASP.'],
          origin: 'ai_suggestion' as const,
          requiresVerification: true as const,
          ai: {
            review: 'edited' as const,
            analyst: 'Analityk Testowy',
            decidedAt: '2026-11-21T12:00:00.000Z',
            model: 'qwen3.6-35b-ov',
            promptVersion: 'v1',
          },
        },
      ],
    };
    const html = renderToStaticMarkup(<ReportDocument report={report} />).replace(/<[^>]+>/g, ' ');
    expect(html).toContain('Wspomagane AI, zatwierdzone przez analityka: Analityk Testowy');
    expect(html).toContain('tekst zredagowany przez analityka na podstawie sugestii AI');
    expect(html).toContain('Wystąpienie do VASP.');
    expect(html).not.toContain('niezweryfikowana');
  });
});

const type = (el: Element | null, value: string) => {
  const input = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = (label: string) =>
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)?.click());
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

async function confirmDraft() {
  click('Potwierdź');
  type(host.querySelector('textarea[id$="-justification"]'), 'Zgodne z materiałem dowodowym.');
  act(() => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await flush();
}

describe('saved drafts with the model switched off', () => {
  it('still lists them for review but offers no way to generate new ones', async () => {
    features = { inferenceDrafts: false };
    items = [pending];
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    const text = host.textContent ?? '';
    expect(text).toContain('Wpis może wskazywać na posługiwanie się adresem.');
    expect(text).toContain('Model AI jest wyłączony');
    expect(buttons()).toContain('Potwierdź');
    expect(buttons()).toContain('Odrzuć');
    expect(buttons()).not.toContain('Zaproponuj wnioski (AI)');
  });

  it('shows no drafts panel at all when the model is off and there are no drafts', async () => {
    features = { inferenceDrafts: false };
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    expect(host.textContent).not.toContain('Wnioski zaproponowane przez AI');
  });
});

describe('waiting for the re-rendered report after a decision', () => {
  it('polls until the published version changes, then reloads the report and stops', async () => {
    items = [pending];
    act(() => root.render(<ReportTab scope={scope} pollSchedule={[5, 5, 5, 5, 5, 5]} />));
    await flush();
    const before = viewGets;
    await confirmDraft();
    await wait(60);
    expect(posted).toContain('/api/suggestions/draft-1/decision');
    expect(host.textContent).not.toContain('Czekam na zaktualizowany raport');
    expect(host.textContent).not.toContain('Zaktualizowany raport nie pojawił się');
    // one check that saw the new version plus the reload of the report resource; polling stopped afterwards
    const after = viewGets;
    expect(after).toBeGreaterThan(before);
    await wait(60);
    expect(viewGets).toBe(after);
  });

  it('keeps waiting while the version is unchanged, then reports a timeout with a retry that checks again', async () => {
    bumpOnDecision = false;
    items = [pending];
    act(() => root.render(<ReportTab scope={scope} pollSchedule={[5, 5, 5]} />));
    await flush();
    await confirmDraft();
    expect(host.textContent).toContain('Czekam na zaktualizowany raport');
    await wait(80);
    expect(host.textContent).not.toContain('Czekam na zaktualizowany raport');
    expect(host.textContent).toContain('Zaktualizowany raport nie pojawił się');
    expect(buttons()).toContain('Sprawdź ponownie');
    viewVersion = 'v-rendered';
    click('Sprawdź ponownie');
    await wait(60);
    expect(host.textContent).not.toContain('Zaktualizowany raport nie pojawił się');
    expect(host.textContent).not.toContain('Czekam na zaktualizowany raport');
  });

  it('backs off up to about a minute in total', () => {
    const total = REPORT_POLL_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(70_000);
    expect(REPORT_POLL_SCHEDULE_MS.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe('cited ids in the native report', () => {
  it('every fact and computed id a draft cites has a target in the document', () => {
    const ids = [...personaView.report.facts.map((f) => f.id), ...personaView.report.computed.map((c) => c.id)];
    const report = {
      ...personaView.report,
      inferences: [
        {
          id: 'inference-draft-1',
          statement: 'Tekst.',
          basedOn: ids,
          alternatives: [],
          origin: 'ai_suggestion' as const,
          requiresVerification: true as const,
          ai: {
            review: 'confirmed' as const,
            analyst: 'A',
            decidedAt: '2026-11-21T12:00:00.000Z',
            model: 'm',
            promptVersion: 'v1',
          },
        },
      ],
    };
    const html = renderToStaticMarkup(<ReportDocument report={report} />);
    const inference = html.slice(html.indexOf('id="inference-inference-draft-1"'));
    const links = [...inference.matchAll(/<a href="#([^"]+)">/g)].map((m) => m[1] ?? '');
    expect(links.length).toBe(ids.length);
    expect(links.filter((target) => !html.includes(`id="${target}"`))).toEqual([]);
  });
});
