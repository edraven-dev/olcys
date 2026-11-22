// @vitest-environment happy-dom
import type { RunWithProgress } from '@olcys/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportTab } from '../src/features/report/ReportTab.tsx';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { setFetch } from '../src/lib/api.ts';
import { personaView } from './fixtures/persona-report.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = {
  run: { id: 'run-stale', caseId: 'case-1', mode: 'offline', status: 'succeeded' } as unknown as RunWithProgress,
  kase: { id: 'case-1', title: 'Sprawa testowa', identifiers: [] },
  version: 'v-stale',
} as unknown as RunScope;

let host: HTMLElement;
let root: Root;
let failReport = false;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  setFetch(async (input) => {
    if (input.endsWith('/report/view')) {
      if (failReport) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(personaView), { status: 200 });
    }
    if (input.startsWith('/api/captures/')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(input === '/api/meta' ? { features: {} } : { items: [] }), { status: 200 });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

describe('report tab', () => {
  it('keeps the cached report visible when a refresh fails, with a warning and a retry', async () => {
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    expect(host.textContent).toContain('A. Fakty źródłowe');
    expect(host.querySelector('.state-warning')).toBeNull();

    act(() => root.unmount());
    failReport = true;
    root = createRoot(host);
    act(() => root.render(<ReportTab scope={scope} />));
    await flush();
    expect(host.textContent).toContain('A. Fakty źródłowe');
    const alert = host.querySelector('.state-warning');
    expect(alert?.textContent).toContain('Nie udało się odświeżyć danych');
    expect([...(alert?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toContain('Spróbuj ponownie');
  });
});
