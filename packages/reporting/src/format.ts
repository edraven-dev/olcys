/**
 * Polish formatting for the report. Amounts are `DecimalString`s formatted by string operations (rounding uses the
 * exact decimal helpers from core, never JS floats). Times are UTC.
 */
import type { DecimalString } from '@olcys/core';
import { dRound, isDecimalString } from '@olcys/core';
import { fill } from './html.ts';
import { pl, type PluralForms } from './i18n/pl.ts';

const NBSP = '\u00A0';

/** Polish typography: digit groups separated by non-breaking spaces from 5 integer digits on (1520, 12 345). */
function groupInteger(digits: string): string {
  if (digits.length < 5) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** `1234567.5` → `1 234 567,5`; with `fractionDigits` the value is rounded half-up first. Non-decimals pass through. */
export function formatDecimal(value: DecimalString, fractionDigits?: number): string {
  if (!isDecimalString(value)) return value;
  const rounded = fractionDigits === undefined ? value : dRound(value, fractionDigits);
  const negative = rounded.startsWith('-');
  const [integer = '0', fraction] = (negative ? rounded.slice(1) : rounded).split('.');
  const body = groupInteger(integer) + (fraction ? `,${fraction}` : '');
  return negative && /[1-9]/.test(body) ? `−${body}` : body;
}

/** `1520.37` → `1520,37 zł`, `1234567.5` → `1 234 567,50 zł`. */
export function formatPln(value: DecimalString): string {
  return fill(pl.units.pln, { amount: formatDecimal(value, 2) }).replace(' ', NBSP);
}

/** `0.0099` + `ETH` → `0,0099 ETH` (exact, as recorded). */
export function formatAmount(value: DecimalString, asset: string): string {
  return fill(pl.units.amount, { amount: formatDecimal(value), asset }).replace(' ', NBSP);
}

/** `2026-11-21T13:41:00.000Z` → `2026-11-21 13:41:00 UTC`. Unparseable input is returned unchanged. */
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = new Date(ms).toISOString();
  return fill(pl.units.utc, { date: s.slice(0, 10), time: s.slice(11, 19) });
}

/** `2026-10-14T09:12:05Z` → `14 października 2026 r., 09:12:05 UTC` (for the narrative). */
export function formatLongDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return fill(pl.units.longDate, {
    day: d.getUTCDate(),
    month: pl.units.months[d.getUTCMonth()] ?? '',
    year: d.getUTCFullYear(),
    time: d.toISOString().slice(11, 19),
  });
}

/** Probability with 4 decimals (`0,9898`); extremes shown as `> 0,9999` / `< 0,0001`. */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p >= 0.99995 && p < 1) return '> 0,9999';
  if (p > 0 && p <= 0.00005) return '< 0,0001';
  return p.toFixed(4).replace('.', ',');
}

/** Signed bits with 2 decimals: `+9,89`, `−2,00`. */
export function formatBits(bits: number): string {
  if (!Number.isFinite(bits)) return '—';
  const sign = bits < 0 ? '−' : '+';
  return sign + Math.abs(bits).toFixed(2).replace('.', ',');
}

/** Factor or ratio with up to 2 decimals and Polish grouping: `950,05`, `24 511`, `0,25`. */
export function formatFactor(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '—';
  const fixed = value.toFixed(2).replace(/\.?0+$/, '');
  const negative = fixed.startsWith('-');
  const [integer = '0', fraction] = (negative ? fixed.slice(1) : fixed).split('.');
  const body = groupInteger(integer) + (fraction ? `,${fraction}` : '');
  return negative ? `−${body}` : body;
}

export function shortHash(sha: string, length = 12): string {
  return sha.length > length ? `${sha.slice(0, length)}…` : sha;
}

/** Polish plural form: 1 adres, 2–4 adresy (except 12–14), 5+ adresów. */
export function plural(count: number, forms: PluralForms): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  let form = forms.many;
  if (count === 1) form = forms.one;
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) form = forms.few;
  return fill(form, { count });
}
