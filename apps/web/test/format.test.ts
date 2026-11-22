import { describe, expect, it } from 'vitest';
import { plural, t, lookup } from '../src/i18n/t.ts';
import { pl } from '../src/i18n/pl.ts';
import {
  formatBits,
  formatBytes,
  formatCrypto,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatLikelihoodRatio,
  formatPln,
  formatProbability,
  formatUtc,
  middleTruncate,
  sumDecimals,
} from '../src/lib/format.ts';

const NBSP = /[  ]/g;
const plain = (s: string) => s.replace(NBSP, ' ');

describe('pl-PL formatting of DecimalString amounts', () => {
  it('formats PLN exactly as Intl does, without float conversion', () => {
    expect(plain(formatPln('1520.37'))).toBe('1520,37 zł');
    expect(plain(formatPln('17520'))).toBe('17 520,00 zł');
    expect(plain(formatPln('-3.5'))).toBe('-3,50 zł');
  });

  it('keeps every digit of a crypto amount', () => {
    expect(plain(formatCrypto('0.123456789012345678', 'ETH'))).toBe('0,123456789012345678 ETH');
    expect(plain(formatDecimal('123456789012345678901234.5'))).toBe('123 456 789 012 345 678 901 234,5');
    expect(plain(formatCrypto('0.01', 'ETH'))).toBe('0,01 ETH');
  });

  it('returns malformed values verbatim', () => {
    expect(formatPln('n/a')).toBe('n/a');
    expect(formatDecimal('1e5')).toBe('1e5');
  });

  it('sums decimal strings exactly', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['17520', '0.01', '-0.005'])).toBe('17520.005');
    expect(sumDecimals(['-1', '0.25'])).toBe('-0.75');
    expect(sumDecimals([])).toBe('0');
  });

  it('formats bytes', () => {
    expect(plain(formatBytes(512))).toBe('512 B');
    expect(plain(formatBytes(12_345))).toBe('12,3 kB');
  });
});

describe('dates in Europe/Warsaw with UTC for tooltips', () => {
  it('formats winter and summer time', () => {
    expect(formatDateTime('2026-11-21T19:21:30Z')).toBe('21.11.2026, 20:21:30');
    expect(formatDateTime('2026-07-21T19:21:30Z')).toBe('21.07.2026, 21:21:30');
    expect(formatDate('2026-11-21T23:30:00Z')).toBe('22.11.2026');
    expect(formatUtc('2026-11-21T19:21:30.000Z')).toBe('2026-11-21 19:21:30 UTC');
  });

  it('handles missing or invalid values', () => {
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('wczoraj')).toBe('wczoraj');
    expect(plain(formatDuration('2026-11-21T10:00:00Z', '2026-11-21T10:01:05Z'))).toBe('1 min 05 s');
    expect(plain(formatDuration('2026-11-21T10:00:00Z', '2026-11-21T10:00:12Z'))).toBe('12 s');
  });
});

describe('score figures', () => {
  it('formats probabilities, bits and likelihood ratios', () => {
    expect(formatProbability(0.98984)).toBe('0,9898');
    expect(formatProbability(0.999999)).toBe('> 0,9999');
    expect(formatProbability(0)).toBe('< 0,0001');
    expect(formatBits(9.8919)).toBe('+9,89');
    expect(formatBits(-2)).toBe('−2,00');
    expect(formatBits(0.001)).toBe('0,00');
    expect(plain(formatLikelihoodRatio(24511))).toBe('≈ 24 500');
    expect(formatLikelihoodRatio(2.9)).toBe('≈ 2,9');
  });

  it('truncates long values in the middle', () => {
    expect(middleTruncate('bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2')).toBe('bc1qqeyyk5…h67m9mt2');
    expect(middleTruncate('short')).toBe('short');
  });
});

describe('catalogue helpers', () => {
  it('interpolates placeholders and keeps unknown ones visible', () => {
    expect(t('Wynik {score}/100', { score: 99 })).toBe('Wynik 99/100');
    expect(t('{a} {b}', { a: 1 })).toBe('1 {b}');
  });

  it('applies Polish plural rules', () => {
    const forms = { one: '{count} adres', few: '{count} adresy', many: '{count} adresów' };
    expect([1, 3, 5, 12, 22, 0].map((n) => plural(n, forms))).toEqual([
      '1 adres',
      '3 adresy',
      '5 adresów',
      '12 adresów',
      '22 adresy',
      '0 adresów',
    ]);
    expect(plural(2, pl.changes.count)).toBe('2 zmiany');
  });

  it('looks up engine keys without inventing labels', () => {
    expect(lookup(pl.icd203, 'almost certain')).toBe('niemal pewne');
    expect(lookup(pl.icd203, 'not assessed')).toBe('nie oceniono');
    expect(lookup(pl.features, 'toString')).toBeNull();
    expect(lookup(pl.features, undefined)).toBeNull();
  });
});
