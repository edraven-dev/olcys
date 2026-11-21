import { Big } from 'big.js';
import type { DecimalString } from './common.ts';

/** Private big.js constructor so settings never leak into other users of the library. */
const Dec = Big();
Dec.DP = 40;
Dec.RM = 1; // half-up
Dec.NE = -60; // never switch to exponential notation in toString()
Dec.PE = 60;

function d(value: DecimalString | number): Big {
  return new Dec(value);
}

function out(value: Big): DecimalString {
  return value.toFixed();
}

export function dAdd(a: DecimalString, b: DecimalString): DecimalString {
  return out(d(a).plus(d(b)));
}

export function dSub(a: DecimalString, b: DecimalString): DecimalString {
  return out(d(a).minus(d(b)));
}

export function dMul(a: DecimalString, b: DecimalString): DecimalString {
  return out(d(a).times(d(b)));
}

/** Division rounded half-up to `scale` decimal places (default 18). */
export function dDiv(a: DecimalString, b: DecimalString, scale = 18): DecimalString {
  return out(d(a).div(d(b)).round(scale, 1));
}

export function dRound(a: DecimalString, scale: number): DecimalString {
  return d(a).round(scale, 1).toFixed(scale);
}

export function dCmp(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return d(a).cmp(d(b)) as -1 | 0 | 1;
}

export function dAbs(a: DecimalString): DecimalString {
  return out(d(a).abs());
}

export function dIsZero(a: DecimalString): boolean {
  return d(a).eq(0);
}

export function dSum(values: readonly DecimalString[]): DecimalString {
  return out(values.reduce((acc, v) => acc.plus(d(v)), d('0')));
}

/** Converts integer base units (satoshi, wei, sun) to whole units: `fromBaseUnits('150000000', 8) === '1.5'`. */
export function fromBaseUnits(baseUnits: string | bigint, decimals: number): DecimalString {
  return out(d(String(baseUnits)).div(d('1e' + decimals)));
}

/** Converts whole units to integer base units, rejecting values with more precision than `decimals`. */
export function toBaseUnits(amount: DecimalString, decimals: number): bigint {
  const scaled = d(amount).times(d('1e' + decimals));
  if (!scaled.eq(scaled.round(0, 0))) throw new RangeError(`${amount} has more than ${decimals} decimals`);
  return BigInt(scaled.toFixed(0));
}

export function isDecimalString(value: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value);
}
