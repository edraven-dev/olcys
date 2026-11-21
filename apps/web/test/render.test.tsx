/** Cheap component checks: static server rendering (no DOM library), asserting on the produced markup. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CaptureCard } from '../src/components/evidence.tsx';
import { KindBlock } from '../src/components/ui.tsx';
import { CaseForm } from '../src/features/cases/NewCase.tsx';
import { LinkCard } from '../src/features/links/LinksTab.tsx';
import { Waterfall } from '../src/features/links/Waterfall.tsx';
import type { SourceItem } from '../src/lib/domain.ts';
import { accounts, btcAddressHop, btcLink, capture, identity, tronLink } from './fixtures/persona.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const ctx = {
  identities: new Map([[identity.id, identity]]),
  accounts: new Map(accounts.map((a) => [a.id, a])),
  captures: new Map([[capture.id, capture]]),
  observations: new Map(),
  candidates: new Map(),
  sourceNames: new Map([['fixture_site', 'Strona testowa']]),
};

describe('links', () => {
  it('shows the score, band, ICD 203 term and separate statement classes', () => {
    const html = renderToStaticMarkup(<LinkCard link={btcLink} ctx={ctx} excluded={new Set()} />);
    const content = text(html);
    expect(content).toContain('99 /100');
    expect(content).toContain('BARDZO WYSOKIE');
    expect(content).toContain('niemal pewne');
    expect(content).toContain('Wniosek do weryfikacji');
    expect(content).toContain('Wynik obliczeń');
    expect(content).toContain('Fakt źródłowy');
    expect(content).toContain('Pewność analityczna: wysoka');
    expect(content).toContain('P = 0,99 — założenie przyjęte przez analityka');
    expect(content).toContain('Ścieżka 1: bitcointalk / fikcyjny_kacper');
    expect(html).toContain('href="/api/blobs/' + 'a'.repeat(64) + '"');
    expect(html).not.toMatch(/href="https?:/);
  });

  it('makes trace synergy visible', () => {
    const content = text(renderToStaticMarkup(<LinkCard link={tronLink} ctx={ctx} excluded={new Set()} />));
    expect(content).toContain('2 niezależne źródła: tablica, wykop');
    expect(content).toContain('wynik wyższy o 18 pkt');
  });

  it('renders the waterfall with signed values and the superseded item', () => {
    const content = text(renderToStaticMarkup(<Waterfall hop={btcAddressHop} title="t" caption="c" />));
    expect(content).toContain('Szanse a priori −2,00');
    expect(content).toContain('E1: wiązanie kryptograficzne (np. podpisany wpis) +9,89');
    expect(content).toContain('nieuwzględniona');
    expect(content).toContain('Suma (W) +12,58');
  });
});

describe('evidence', () => {
  it('offers captured files only as downloads from the own API and URLs as text', () => {
    const html = renderToStaticMarkup(
      <ul>
        <CaptureCard capture={{ ...capture, url: 'http://127.0.0.1:4100/<script>alert(1)</script>' }} />
      </ul>,
    );
    expect(html).toContain('download=');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img');
  });

  it('labels statement classes with text, not colour alone', () => {
    const content = text(renderToStaticMarkup(<KindBlock kind="inference">{null}</KindBlock>));
    expect(content).toContain('Wniosek do weryfikacji');
  });
});

describe('new-case form', () => {
  const sources: SourceItem[] = [
    {
      id: 'fixture_site',
      name: 'Strona testowa',
      kind: 'fixture',
      compliance: 'GREEN',
      complianceNote: 'Dane syntetyczne.',
      enabledByDefault: true,
      sendsIdentifiersExternally: false,
    },
    {
      id: 'bitcointalk',
      name: 'Bitcointalk',
      kind: 'forum',
      compliance: 'AMBER',
      complianceNote: 'Polite bots only.',
      enabledByDefault: false,
      sendsIdentifiersExternally: true,
    },
    {
      id: 'x_twitter',
      name: 'X / Twitter',
      kind: 'social',
      compliance: 'RED',
      complianceNote: 'Terms forbid scraping.',
      enabledByDefault: false,
      sendsIdentifiersExternally: true,
    },
  ];

  it('locks RED sources, pre-checks GREEN defaults and labels every control', () => {
    const html = renderToStaticMarkup(<CaseForm sources={sources} />);
    const red = /<input[^>]*id="[^"]*-src-x_twitter"[^>]*>/.exec(html)?.[0] ?? '';
    expect(red).toContain('disabled');
    expect(red).not.toContain('checked');
    expect(/<input[^>]*id="[^"]*-src-fixture_site"[^>]*>/.exec(html)?.[0]).toContain('checked');
    expect(text(html)).toContain('Zablokowane: Terms forbid scraping.');
    expect(text(html)).toContain('Zapytanie ujawnia identyfikator podmiotowi zewnętrznemu');
    for (const id of html.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)) {
      expect(html, `label for ${id[1]}`).toContain(`for="${id[1]}"`);
    }
  });
});
