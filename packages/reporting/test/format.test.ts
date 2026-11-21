import { describe, expect, it } from 'vitest';
import {
  BAND_IDS,
  escapeHtml,
  formatAmount,
  formatDecimal,
  formatLongDate,
  formatPln,
  formatUtc,
  pl,
  plural,
  scoreBand,
  t,
} from '../src/index.ts';

const NBSP = '\u00A0';

describe('formatting', () => {
  it('formats PLN from decimal strings without floats', () => {
    expect(formatPln('1520.37')).toBe(`1520,37${NBSP}zł`);
    expect(formatPln('1234567.5')).toBe(`1${NBSP}234${NBSP}567,50${NBSP}zł`);
    expect(formatPln('0.005')).toBe(`0,01${NBSP}zł`);
    expect(formatPln('-12345.678')).toBe(`−12${NBSP}345,68${NBSP}zł`);
    expect(formatPln('99999999999999999999.995')).toBe(
      `100${NBSP}000${NBSP}000${NBSP}000${NBSP}000${NBSP}000${NBSP}000,00${NBSP}zł`,
    );
  });

  it('formats amounts exactly as recorded', () => {
    expect(formatAmount('0.0099', 'ETH')).toBe(`0,0099${NBSP}ETH`);
    expect(formatAmount('0.000000000000000001', 'ETH')).toBe(`0,000000000000000001${NBSP}ETH`);
    expect(formatDecimal('12345')).toBe(`12${NBSP}345`);
    expect(formatDecimal('1234')).toBe('1234');
    expect(formatDecimal('not-a-number')).toBe('not-a-number');
  });

  it('formats times in UTC', () => {
    expect(formatUtc('2026-11-21T13:41:00.000Z')).toBe('2026-11-21 13:41:00 UTC');
    expect(formatUtc('2026-11-21T14:41:00+01:00')).toBe('2026-11-21 13:41:00 UTC');
    expect(formatUtc('wczoraj')).toBe('wczoraj');
    expect(formatLongDate('2026-10-14T09:12:05Z')).toBe('14 października 2026 r., 09:12:05 UTC');
  });

  it('uses Polish plural forms', () => {
    const forms = pl.counts.addresses;
    expect([1, 2, 5, 12, 22, 25].map((n) => plural(n, forms))).toEqual([
      '1 adres',
      '2 adresy',
      '5 adresów',
      '12 adresów',
      '22 adresy',
      '25 adresów',
    ]);
  });

  it('maps scores to the bands of the brief', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 10, 0].map((s) => scoreBand(s))).toEqual([
      'very_high',
      'very_high',
      'probable',
      'probable',
      'medium',
      'medium',
      'low',
      'low',
      'low',
    ]);
    expect(scoreBand(0, true)).toBe('excluded');
    expect(BAND_IDS.map((id) => pl.bands[id].label)).toEqual([
      'BARDZO WYSOKIE',
      'PRAWDOPODOBNE',
      'ŚREDNIE',
      'NISKIE / SZUM',
      'WYKLUCZENIE',
    ]);
  });

  it('escapes markup and reveals invisible characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml('a\u200Bb\u202Ec')).toBe('a⟦U+200B⟧b⟦U+202E⟧c');
    expect(t('Wynik {score}/100 dla {who}', { score: 99, who: '<b>' }).value).toBe('Wynik 99/100 dla &lt;b&gt;');
    expect(() => t('Brak {wartosci}')).toThrow(/placeholder/);
  });
});
