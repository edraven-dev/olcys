/**
 * pl-PL formatting. Amounts are `DecimalString`s and are handed to `Intl.NumberFormat` as strings, which formats
 * them exactly (no conversion through JavaScript floats). Times are shown in Europe/Warsaw; the UTC value goes into
 * a tooltip. Malformed input is returned verbatim rather than guessed.
 */
import type { DecimalString } from '@olcys/core';

const LOCALE = 'pl-PL';
const TIME_ZONE = 'Europe/Warsaw';
const MINUS = '−';

type NumericString = `${number}`;

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL.test(value);
}

const decimalFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let format = decimalFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options);
    decimalFormats.set(key, format);
  }
  return format;
}

/** Exact decimal, every fractional digit kept: `'0.123456789012345678'` → `0,123456789012345678`. */
export function formatDecimal(value: DecimalString, minFraction = 0): string {
  if (!isDecimalString(value)) return value;
  return numberFormat(`d${minFraction}`, {
    minimumFractionDigits: minFraction,
    maximumFractionDigits: 100,
  }).format(value as NumericString);
}

/** `'1520.37'` → `1520,37 zł` (separators as produced by `Intl`). */
export function formatPln(value: DecimalString): string {
  if (!isDecimalString(value)) return value;
  return numberFormat('pln', { style: 'currency', currency: 'PLN' }).format(value as NumericString);
}

/** `('0.01', 'ETH')` → `0,01 ETH`; every digit of the decimal is kept. */
export function formatCrypto(value: DecimalString, asset: string): string {
  return `${formatDecimal(value)} ${asset}`;
}

export function formatInteger(value: number): string {
  return numberFormat('int', { maximumFractionDigits: 0 }).format(value);
}

/** Bytes as kB/MB with one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${formatInteger(bytes)} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${numberFormat('kb', { maximumFractionDigits: 1 }).format(kb)} kB`;
  return `${numberFormat('kb', { maximumFractionDigits: 1 }).format(kb / 1000)} MB`;
}

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function parseTime(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `2026-11-21T19:21:30Z` → `21.11.2026, 20:21:30` (Europe/Warsaw). */
export function formatDateTime(iso: string | undefined): string {
  const date = parseTime(iso);
  return date ? dateTime.format(date) : (iso ?? '');
}

export function formatDate(iso: string | undefined): string {
  const date = parseTime(iso);
  return date ? dateOnly.format(date) : (iso ?? '');
}

/** `2026-11-21 19:21:30 UTC` for tooltips. */
export function formatUtc(iso: string | undefined): string {
  const date = parseTime(iso);
  return date ? `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC` : (iso ?? '');
}

/** Duration between two timestamps: `1 min 05 s`, `12 s`. */
export function formatDuration(fromIso: string | undefined, toIso: string | undefined): string {
  const from = parseTime(fromIso);
  const to = parseTime(toIso);
  if (!from || !to) return '';
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Four decimals; the extremes say `> 0,9999` / `< 0,0001` instead of rounding to 1 or 0. */
export function formatProbability(p: number): string {
  const format = numberFormat('p4', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  if (p >= 0.99995) return `> ${format.format(0.9999)}`;
  if (p <= 0.00005) return `< ${format.format(0.0001)}`;
  return format.format(p);
}

/** Signed log-odds contribution with two decimals and a typographic minus: `+9,89`, `−2,00`. */
export function formatBits(bits: number): string {
  const value = Math.abs(bits) < 0.005 ? 0 : bits;
  return numberFormat('bits', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' })
    .format(value)
    .replace('-', MINUS);
}

/** Three significant digits: `≈ 24 500`, `≈ 2,9`. */
export function formatLikelihoodRatio(lr: number): string {
  return `≈ ${numberFormat('lr', { maximumSignificantDigits: 3 }).format(lr)}`;
}

/** Plain number with up to `digits` decimals (BF, ρ, κ). */
export function formatNumber(value: number, digits = 2): string {
  return numberFormat(`n${digits}`, { maximumFractionDigits: digits }).format(value);
}

/** Exact sum of decimal strings (BigInt arithmetic); malformed values are skipped. */
export function sumDecimals(values: readonly string[]): DecimalString {
  const valid = values.filter(isDecimalString);
  const scale = Math.max(0, ...valid.map((v) => (v.split('.')[1] ?? '').length));
  let total = 0n;
  for (const value of valid) {
    const negative = value.startsWith('-');
    const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
    const units = BigInt(int + frac.padEnd(scale, '0'));
    total += negative ? -units : units;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${int}${frac}`;
}

/** `bc1qqeyyk5qtdw97f384wus6nfy4muwa3qh67m9mt2` → `bc1qqeyyk5…qh67m9mt2`. */
export function middleTruncate(value: string, head = 10, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortHash(hex: string, length = 12): string {
  return hex.slice(0, length);
}
