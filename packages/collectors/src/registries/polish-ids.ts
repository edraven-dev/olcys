/**
 * Polish identifiers of the public registries: NIP, REGON, KRS number and NRB bank account (validators and
 * normalisers), the first/last name split CEIDG searches by, and the Warsaw calendar date the VAT white list asks for.
 */
import type { Clock, IsoDate } from '@olcys/core';

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const;
const REGON9_WEIGHTS = [8, 9, 2, 3, 4, 5, 6, 7] as const;
const REGON14_WEIGHTS = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8] as const;

function digitsOf(value: string): number[] {
  return [...value].map(Number);
}

function weightedSum(digits: readonly number[], weights: readonly number[]): number {
  return weights.reduce((sum, weight, i) => sum + weight * (digits[i] ?? 0), 0);
}

/** `0001234562`, `000-123-45-62` and `PL 0001234562` → the 10 digits; anything else is returned trimmed. */
export function normalizeNip(nip: string): string {
  return nip
    .trim()
    .replace(/^PL\s*/i, '')
    .replace(/[\s-]/g, '');
}

/** 10 digits, weights 6,5,7,2,3,4,5,6,7, checksum (sum mod 11) equal to the last digit and never 10. */
export function isValidNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const digits = digitsOf(nip);
  const sum = weightedSum(digits, NIP_WEIGHTS) % 11;
  return sum !== 10 && sum === digits[9];
}

function regonCheck(digits: readonly number[], weights: readonly number[]): boolean {
  const sum = weightedSum(digits, weights) % 11;
  return (sum === 10 ? 0 : sum) === digits[weights.length];
}

/** 9 digits (weights 8,9,2,3,4,5,6,7) or 14 digits (the first 9 form a valid REGON, then weights 2,4,8,5,0,9,7,3,6,1,2,4,8). */
export function isValidRegon(regon: string): boolean {
  if (/^\d{9}$/.test(regon)) return regonCheck(digitsOf(regon), REGON9_WEIGHTS);
  if (!/^\d{14}$/.test(regon)) return false;
  return isValidRegon(regon.slice(0, 9)) && regonCheck(digitsOf(regon), REGON14_WEIGHTS);
}

/** KRS number: digits only (up to 10), zero-padded to 10; undefined for anything else (or all zeros). */
export function normalizeKrs(krs: string): string | undefined {
  const text = krs.trim().replace(/^KRS\s*/i, '');
  if (!/^\d{1,10}$/.test(text) || /^0+$/.test(text)) return undefined;
  return text.padStart(10, '0');
}

/** `PL61 1090 …` and `61109…` → the 26 digits; anything else is returned trimmed. */
export function normalizeNrb(account: string): string {
  return account
    .trim()
    .replace(/^PL\s*/i, '')
    .replace(/[\s-]/g, '');
}

/** IBAN check digits (ISO 7064 mod 97-10) for `PL` and a 24-digit body (routing number and account number). */
export function nrbCheckDigits(body: string): string {
  if (!/^\d{24}$/.test(body)) throw new Error('an NRB body has 24 digits');
  // "PL" is 2521; the check digits themselves are "00" while computing.
  return String(98n - (BigInt(`${body}252100`) % 97n)).padStart(2, '0');
}

/** The 26-digit NRB of a 24-digit body (computes the check digits); used for synthetic accounts. */
export function buildNrb(body: string): string {
  return `${nrbCheckDigits(body)}${body}`;
}

/** 26 digits whose IBAN check (country PL) holds: the rearranged number mod 97 is 1. */
export function isValidNrb(account: string): boolean {
  const nrb = normalizeNrb(account);
  if (!/^\d{26}$/.test(nrb)) return false;
  return BigInt(`${nrb.slice(2)}2521${nrb.slice(0, 2)}`) % 97n === 1n;
}

/**
 * CEIDG searches by first and last name: the first token is `imie`, the last `nazwisko` (a hyphenated surname stays
 * whole, middle names are dropped). One token is not enough. Inflected forms are not normalised.
 */
export function splitPolishFullName(fullName: string): { imie: string; nazwisko: string } | undefined {
  const tokens = fullName.trim().split(/\s+/u).filter(Boolean);
  const imie = tokens[0];
  const nazwisko = tokens.at(-1);
  if (tokens.length < 2 || !imie || !nazwisko) return undefined;
  return { imie, nazwisko };
}

/** The calendar date in Europe/Warsaw at `clock` (the white list's `date` parameter is a Polish date). */
export function warsawDate(clock: Clock): IsoDate {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(clock.now());
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
