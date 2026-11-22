import type { ApiMeta } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/features/settings/SettingsPage.tsx';
import type { SourceItem } from '../src/lib/domain.ts';
import { ApiRequestError } from '../src/lib/api.ts';
import type { Resource } from '../src/lib/use-api.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const meta: ApiMeta = {
  toolVersion: '0.1.0',
  contracts: '1.0.0',
  mode: 'replay',
  features: { judgements: true, suggestions: false, schedules: true, reportPdf: false, exports: false, auth: false },
  scoring: {
    weightsVersion: 'weights.v1',
    weightsSha256: 'b'.repeat(64),
    rulesVersions: { exclusion: 'exclusion.v1', cashout: 'cashout.v1' },
    weightsStatus: 'uncalibrated',
  },
  extractorVersion: '0.1.0+patterns.v1',
  llm: { enabled: false, baseUrlHost: '127.0.0.1:11434', model: 'model-testowy', modelDigest: 'd'.repeat(64) },
  telemetryOptOuts: [
    { name: 'DO_NOT_TRACK', set: true },
    { name: 'HF_HUB_OFFLINE', set: false },
  ],
};

const sources: SourceItem[] = [
  {
    id: 'x_twitter',
    name: 'X (Twitter)',
    kind: 'web',
    compliance: 'RED',
    complianceNote: 'Regulamin zabrania automatycznego pobierania.',
    enabledByDefault: false,
    sendsIdentifiersExternally: true,
  },
  {
    id: 'fixture_site',
    name: 'Strona testowa',
    kind: 'fixture',
    compliance: 'GREEN',
    complianceNote: 'Syntetyczne dane.',
    enabledByDefault: true,
    sendsIdentifiersExternally: false,
  },
];

const resource = (data: SourceItem[] | undefined, error?: unknown): Resource<SourceItem[]> => ({
  data,
  error,
  loading: false,
  updatedAt: data ? Date.parse('2026-11-21T10:00:00.000Z') : undefined,
  reload: vi.fn(),
});

describe('settings page', () => {
  const html = renderToStaticMarkup(<SettingsView meta={meta} sources={resource(sources)} />);
  const content = text(html);

  it('shows mode, versions, model, weights status and the source register', () => {
    expect(content).toContain('Odtwarzanie — odpowiedzi z nagrań (kaset), bez sieci');
    for (const expected of ['0.1.0', '1.0.0', '0.1.0+patterns.v1', 'exclusion.v1', 'cashout.v1', 'weights.v1']) {
      expect(content).toContain(expected);
    }
    expect(content).toContain('127.0.0.1:11434');
    expect(content).toContain('model-testowy');
    expect(content).toContain('wyłączony');
    expect(content).toContain('nieskalibrowane');
    expect(content).toContain('x_twitter');
    expect(content).toContain('Regulamin zabrania automatycznego pobierania.');
    expect(content).toContain('czerwone (nigdy nie odpytywane): 1');
  });

  it('shows the telemetry opt-outs and whether they are set', () => {
    expect(content).toMatch(/DO_NOT_TRACK\s*:\s*ustawione/);
    expect(content).toMatch(/HF_HUB_OFFLINE\s*:\s*brak/);
  });

  it('is read-only and exposes no secret, credential or key value', () => {
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('://');
    expect(html).not.toMatch(/api[_-]?key\s*[:=]\s*\S+/i);
    expect(html).not.toContain('Bearer');
  });

  it('has a labelled heading for every section', () => {
    const sections = [...html.matchAll(/<section[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThanOrEqual(6);
    for (const id of sections) expect(html).toContain(`id="${id}"`);
  });
});

describe('source register states', () => {
  const failure = new ApiRequestError(500, 'internal', '');
  const render = (sourcesResource: Resource<SourceItem[]>) =>
    text(renderToStaticMarkup(<SettingsView meta={meta} sources={sourcesResource} />));

  it('shows loading separately from the rest of the settings', () => {
    const content = render(resource(undefined));
    expect(content).toContain('Wczytywanie');
    expect(content).toContain('0.1.0');
    expect(content).not.toContain('Zarejestrowane źródła');
  });

  it('shows a failed register with a retry instead of an empty table', () => {
    const content = render(resource(undefined, failure));
    expect(content).toContain('Nie udało się wczytać rejestru źródeł.');
    expect(content).toContain('Spróbuj ponownie');
    expect(content).not.toContain('Zarejestrowane źródła');
    expect(content).toContain('weights.v1');
  });

  it('keeps cached sources but says the refresh failed', () => {
    const content = render(resource(sources, failure));
    expect(content).toContain('Nie udało się odświeżyć danych');
    expect(content).toContain('Spróbuj ponownie');
    expect(content).toContain('x_twitter');
  });
});
