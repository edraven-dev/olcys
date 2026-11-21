import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertSelfContainedHtml, pl, renderReport, reportDataJson } from '../src/index.ts';
import { A, emptyData, MALICIOUS_SNIPPET, MALICIOUS_VALUE, personaData } from './fixtures.ts';

const NBSP = '\u00A0';
const report = renderReport(personaData());

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  expect(start, `section ${id}`).toBeGreaterThan(-1);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

/** Inner HTML of every `block()` (div) and `statement()` (p) of one statement class. */
function statements(html: string, id: string): string[] {
  const out: string[] = [];
  const divOpen = `<div class="blk blk-${id}" data-statement="${id}">`;
  for (let i = html.indexOf(divOpen); i !== -1; i = html.indexOf(divOpen, i + 1)) {
    let depth = 0;
    let j = i;
    do {
      const open = html.indexOf('<div', j + 1);
      const close = html.indexOf('</div>', j + 1);
      if (open !== -1 && open < close) {
        depth += 1;
        j = open;
      } else {
        depth -= 1;
        j = close;
      }
    } while (depth >= 0);
    out.push(html.slice(i, j + '</div>'.length));
  }
  const pOpen = `<p class="st st-${id}" data-statement="${id}">`;
  for (let i = html.indexOf(pOpen); i !== -1; i = html.indexOf(pOpen, i + 1))
    out.push(html.slice(i, html.indexOf('</p>', i) + 4));
  return out;
}

function without(html: string, parts: string[]): string {
  return parts.reduce((rest, part) => rest.replace(part, ''), html);
}

describe('renderReport', () => {
  it('renders every chapter in order, in Polish', () => {
    expect(report.startsWith('<!doctype html>\n<html lang="pl">')).toBe(true);
    expect(report).toContain('<title>Raport z analizy OSINT: Kacper Fikcyjny (dane syntetyczne)</title>');
    const titles = Object.values(pl.sections);
    const positions = titles.map((title) => report.indexOf(`<h2>${title}</h2>`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    for (const label of ['Fakty źródłowe', 'Wyniki obliczeń', 'Wnioski do weryfikacji', 'Wskaźnik Pewności'])
      expect(report).toContain(label);
  });

  it('is self-contained: no scripts, stylesheets, frames or remote URLs', () => {
    expect(() => assertSelfContainedHtml(report)).not.toThrow();
    expect(report).not.toMatch(/<(script|link|iframe|img|object|embed)\b/i);
    expect(report).not.toMatch(/\s(src|href)\s*=\s*["']?https?:/i);
    expect(report).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(report).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    );
    // Captured URLs are evidence shown as text, never links.
    expect(report).toContain('<span class="url">http://127.0.0.1:4100/github/fikcyjny-kacper</span>');
  });

  it('escapes untrusted scraped content', () => {
    expect(report).not.toContain(MALICIOUS_VALUE);
    expect(report).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(report).not.toContain(MALICIOUS_SNIPPET);
    expect(report).toContain('&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(report.match(/<\/style>/g)).toHaveLength(1);
    const hidden = renderReport({ ...personaData(), case: { ...personaData().case, title: 'abc\u202Edef' } });
    expect(hidden).toContain('abc⟦U+202E⟧def');
  });

  it('keeps facts, computed results and inferences in separate labelled blocks', () => {
    const facts = statements(report, 'fakty');
    const computed = statements(report, 'obliczenia');
    const inferences = statements(report, 'wnioski');
    expect(facts.length).toBeGreaterThan(5);
    expect(computed.length).toBeGreaterThan(5);
    expect(inferences.length).toBeGreaterThan(5);
    for (const b of facts)
      expect(b).toMatch(/^<(div|p)[^>]*><(p class="blk-label"|span class="st-label")>Fakty źródłowe/);
    for (const b of computed)
      expect(b).toMatch(/^<(div|p)[^>]*><(p class="blk-label"|span class="st-label")>Wyniki obliczeń/);
    for (const b of inferences)
      expect(b).toMatch(/^<(div|p)[^>]*><(p class="blk-label"|span class="st-label")>Wnioski do weryfikacji/);

    // Each kind of statement appears only in its own class.
    expect(without(report, facts)).not.toMatch(/Zebrano \d{4}-\d\d-\d\d [\d:]+ UTC · /);
    expect(without(report, facts)).not.toContain('bitcointalk:fikcyjny_kacper: pole profilu „Bitcoin address” — ');
    expect(without(report, computed)).not.toContain('round(100 × P) = 99');
    expect(without(report, computed)).not.toContain('Wynik reguły:');
    expect(without(report, inferences)).not.toContain('Możliwe wyjście do walut tradycyjnych');
    expect(without(report, inferences)).not.toContain('Hipoteza:');
    for (const b of facts) expect(b).not.toMatch(/Hipoteza|Wynik reguły|round\(100/);
    for (const b of inferences) expect(b).not.toContain('SHA-256 manifestu');
  });

  it('shows the score with its band, ICD 203 term, contributions and trace synergy', () => {
    const links = sectionOf(report, 'powiazania');
    expect(links.indexOf(A.BTC1)).toBeLessThan(links.indexOf(A.TRON1));
    expect(links.indexOf(A.TRON1)).toBeLessThan(links.indexOf(A.ETH2));
    expect(links).not.toContain(A.ETH1);
    expect(links).not.toContain(A.TRON2);
    expect(links).toContain(
      '<span class="score">99/100</span> <span class="band band-very_high">BARDZO WYSOKIE</span>',
    );
    expect(links).toContain('<span class="band band-probable">PRAWDOPODOBNE</span>');
    expect(links).toContain('<span class="band band-low">NISKIE / SZUM</span>');
    expect(links).toContain('niemal pewne');
    expect(links).toContain('mało prawdopodobne');
    expect(links).toContain('E1: wiązanie kryptograficzne (np. podpisany wpis)');
    expect(links).toContain('nie — silniejsza przesłanka tej samej rodziny');
    expect(links).toContain('Kotwica: P = 0,99');
    expect(links).toContain('podpis poprawny');
    expect(links).toMatch(
      /TAK — adres wystąpił w 2 niezależnych źródłach różnego pochodzenia: Ogłoszenia P2P \(1 wystąpienie\), Wykop/,
    );
    expect(links).toMatch(/NIE — adres wystąpił tylko w jednym źródle: Bitcointalk \(forum\) \(2 wystąpienia\)/);
    expect(links).toContain(
      'Silny dowód kontroli adresu przez konto github / fikcyjny-kacper nie przenosi się na osobę',
    );
    expect(links).toContain('Pewność analityczna (podawana osobno od prawdopodobieństwa)');
  });

  it('lists rejected attributions with the rule and the reason', () => {
    const rejected = sectionOf(report, 'odrzucone');
    expect(rejected).toContain('Reguła A4: Adres depozytowy giełdy');
    expect(rejected).toContain('przeklasyfikowany');
    expect(rejected).toContain('Nowa relacja: adres powierniczy giełdy');
    expect(rejected).toContain('κ (dopasowanie przekazania środków dalej)');
    expect(rejected).toContain('Reguła A1: Adres oznaczony jako usługa');
    expect(rejected).toContain('Reguła A2: Smart kontrakt');
    expect(rejected).toContain('<span class="band band-excluded">WYKLUCZENIE</span>');
    expect(rejected).toContain('Trop KYC');
    expect(rejected).toContain('Interakcja odnotowana, nie przypisana osobie');
    expect(rejected).toContain('oznacza adres jako: Giełda Testowa (SYNTHETIC) — giełda');
    expect(rejected).toContain(
      `oznacza adres <code class="addr">${A.HOT1}</code>, na który trafiają środki z tego adresu`,
    );
    expect(rejected).toContain('Uwaga! Oszust podaje adres');
    expect(rejected).toContain('przypisany przez stronę trzecią');
    expect(rejected).toContain('przykład z dokumentacji lub oficjalny wektor testowy');
    expect(rejected.split(A.D2)).toHaveLength(2);
    expect(rejected).toContain('homoglify');
    expect(rejected).toContain('Znaki spoza ASCII: U+0430 (а)');
    expect(rejected).toContain('ciąg wygląda jak skrót transakcji');
    expect(rejected).toContain('inny powód');
  });

  it('values cash-out indicators in PLN with the NBP rate used', () => {
    const activity = sectionOf(report, 'aktywnosc');
    expect(activity).toContain(`1520,37${NBSP}zł`);
    expect(activity).toContain(`1${NBSP}234${NBSP}567,50${NBSP}zł`);
    expect(activity).toContain('kurs średni NBP, tabela 224/A/NBP/2026 z dnia 2026-10-13: 1 USD = 3,6512 zł');
    expect(activity).toContain('reguła B1 — Wpłata na giełdę');
    expect(activity).toContain('reguła B5 — Wymiana P2P');
    expect(activity).toContain('Interakcje z usługami (odnotowane, nie przypisane osobie)');
    expect(activity).toContain(`wymiana 1000${NBSP}TRX na 120${NBSP}USDT w DEX Testowy — zamiana na stablecoin`);
    expect(activity).toContain(`Konwersja na stablecoiny</dt><dd>438,14${NBSP}zł`);
  });

  it('narrates the flow of funds in chronological order', () => {
    const flow = sectionOf(report, 'przeplywy');
    const times = [...flow.matchAll(/<time datetime="([^"]+)">/g)].map((m) => m[1] ?? '');
    expect(times).toHaveLength(5);
    expect(times).toEqual(times.toSorted());
    expect(flow.indexOf(`0,5${NBSP}BTC przesłano z adresu`)).toBeLessThan(flow.indexOf(`0,01${NBSP}ETH przesłano`));
    expect(flow).toContain('1 września 2026 r., 07:00:00 UTC');
    expect(flow).toContain(`Wartość: <strong>1535,73${NBSP}zł</strong> (kurs średni NBP`);
    expect(flow).toContain('Reguła B1 — Wpłata na giełdę (adres depozytowy lub portfel gorący): silna przesłanka.');
    expect(flow).toContain(
      `Możliwe wyjście do walut tradycyjnych — odbiorca: <code class="addr">${A.HOT1}</code> <span class="role">(giełda „Giełda Testowa (SYNTHETIC)”)</span>`,
    );
    expect(flow).toContain('(giełda „Giełda Testowa (SYNTHETIC)”, A1)');
    expect(flow).toContain('(adres depozytowy giełdy — reguła A4)');
    // The B5 event values 4800 USDT; each 2400 USDT transfer is not given the event's total value.
    expect(flow).not.toContain(`Wartość: <strong>1${NBSP}234${NBSP}567,50`);
    expect(flow).toContain('(powiązany z „fikcyjny_kacper”, 99/100)');
    expect(flow).toMatch(
      /Łączna wartość przepływów ocenionych jako przesłanki wyjścia do walut tradycyjnych: 1\u00A0236\u00A0087,87\u00A0zł/,
    );
  });

  it('reports the wallet swap against the previous run with both captures', () => {
    const changes = sectionOf(report, 'zmiany');
    expect(changes).toContain('Alert: podmiana adresu portfela w profilu');
    expect(changes).toContain(A.BTC2);
    expect(changes).toContain(A.BTC1);
    expect(changes).toContain('href="#zab-8">zabezpieczenie nr 8');
    expect(changes).toContain('href="#zab-1">zabezpieczenie nr 1');
    expect(changes).toContain('50 → 66 (przyczyna: zmiana danych)');
    expect(changes).toContain('zmiana oceny');
  });

  it('registers every capture with URL, time, status and SHA-256, plus the egress log', () => {
    const register = sectionOf(report, 'rejestr');
    for (const capture of [...personaData().captures, ...personaData().earlierCaptures]) {
      expect(register).toContain(capture.url);
      expect(register).toContain(capture.manifestSha256);
    }
    expect(register).toContain('<tr id="zab-7">');
    expect(register).toContain('blokada dostępu — treści nie pobrano (HTTP 403)');
    expect(register).toContain('z poprzedniego uruchomienia');
    expect(register).toContain('2026-11-21 10:01:00');
    expect(register).toContain(
      'Łącznie 3 zapytania do 3 hostów; odrzucone przez listę dozwolonych hostów: 1; z identyfikatorem sprawy: 2; błędy transmisji: 0.',
    );
  });

  it('records the reproducibility parameters', () => {
    const data = personaData();
    const meta = sectionOf(report, 'metryka');
    const sha = createHash('sha256').update(reportDataJson(data)).digest('hex');
    for (const value of [sha, data.run.config.sourcesConfigSha256, data.run.config.weightsSha256, 'abc1234', 'lr.v1'])
      expect(meta).toContain(value);
    expect(meta).toContain('cashout: cashout.v1, exclusion: exclusion.v1');
    expect(meta).toContain('offline — bez dostępu do Internetu');
    expect(meta).toContain('nieużywany');
    expect(meta).toContain('nieskalibrowane (wartości początkowe)');
    expect(meta).toContain('uzasadnienie włączenia: Forum wskazane w materiałach sprawy');
  });

  it('is deterministic', () => {
    expect(renderReport(personaData())).toBe(report);
    expect(renderReport({ ...personaData(), generatedAt: '2026-11-22T08:00:00.000Z' })).not.toBe(report);
  });

  it('renders a first run without findings', () => {
    const html = renderReport(emptyData());
    expect(() => assertSelfContainedHtml(html)).not.toThrow();
    for (const text of [
      pl.changes.firstRun,
      pl.links.none,
      pl.activity.none,
      pl.flow.none,
      pl.evidence.none,
      pl.evidence.egressNone,
      pl.rejected.rulesNone,
      pl.summary.noInferences,
    ])
      expect(html).toContain(text);
  });
});
