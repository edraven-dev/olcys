/** Validators and helpers of the Polish registry identifiers (synthetic values only). */
import { describe, expect, it } from 'vitest';
import {
  buildNrb,
  isValidNip,
  isValidNrb,
  isValidRegon,
  normalizeKrs,
  normalizeNip,
  normalizeNrb,
  splitPolishFullName,
  warsawDate,
} from '../src/index.ts';

/** Routing number 00000000 (never assigned) and a synthetic 16-digit account; check digits computed here. */
export const syntheticNrb = (account = '0000000000010001'): string => buildNrb(`00000000${account}`);

describe('Polish identifiers', () => {
  it('validates NIP checksums', () => {
    expect(isValidNip('0001234562')).toBe(true);
    expect(isValidNip('0001234563')).toBe(false);
    expect(isValidNip('000123456')).toBe(false);
    expect(isValidNip('00012345a2')).toBe(false);
    expect(normalizeNip('PL 000-123-45-62')).toBe('0001234562');
  });

  it('validates REGON checksums (9 and 14 digits)', () => {
    expect(isValidRegon('001234562')).toBe(true);
    expect(isValidRegon('001234563')).toBe(false);
    expect(isValidRegon('12345678')).toBe(false);
    // 14 digits: a valid 9-digit REGON plus a local-unit part with its own check digit (weights 2,4,8,5,0,9,7,3,6,1,2,4,8).
    const base = '0012345620000';
    const sum = [...base].reduce((n, d, i) => n + Number(d) * ([2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8][i] ?? 0), 0);
    const check = (sum % 11) % 10;
    expect(isValidRegon(`${base}${check}`)).toBe(true);
    expect(isValidRegon(`${base}${(check + 1) % 10}`)).toBe(false);
  });

  it('pads KRS numbers to ten digits and rejects other input', () => {
    expect(normalizeKrs('9999901')).toBe('0009999901');
    expect(normalizeKrs('KRS 0009999901')).toBe('0009999901');
    expect(normalizeKrs('12345678901')).toBeUndefined();
    expect(normalizeKrs('abc')).toBeUndefined();
    expect(normalizeKrs('0000000000')).toBeUndefined();
  });

  it('validates NRB accounts with the IBAN check and rejects a changed digit', () => {
    const nrb = syntheticNrb();
    expect(nrb).toMatch(/^\d{26}$/);
    expect(isValidNrb(nrb)).toBe(true);
    expect(isValidNrb(`PL ${nrb}`)).toBe(true);
    expect(normalizeNrb(`PL${nrb.slice(0, 2)} ${nrb.slice(2)}`)).toBe(nrb);
    const changed = `${nrb.slice(0, 25)}${(Number(nrb[25]) + 1) % 10}`;
    expect(isValidNrb(changed)).toBe(false);
    expect(isValidNrb(nrb.slice(1))).toBe(false);
  });

  it('splits a full name into first name and surname', () => {
    expect(splitPolishFullName('Anna Maria Nowak-Kowalska')).toEqual({ imie: 'Anna', nazwisko: 'Nowak-Kowalska' });
    expect(splitPolishFullName('  Kacper   Fikcyjny ')).toEqual({ imie: 'Kacper', nazwisko: 'Fikcyjny' });
    expect(splitPolishFullName('Kacper')).toBeUndefined();
    expect(splitPolishFullName('')).toBeUndefined();
  });

  it('gives the Warsaw calendar date (winter and summer time)', () => {
    expect(warsawDate({ now: () => new Date('2026-11-21T23:30:00Z') })).toBe('2026-11-22');
    expect(warsawDate({ now: () => new Date('2026-11-21T22:30:00Z') })).toBe('2026-11-21');
    expect(warsawDate({ now: () => new Date('2026-07-01T22:30:00Z') })).toBe('2026-07-02');
  });
});
