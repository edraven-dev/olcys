import { createHash } from 'node:crypto';
import { fromBaseUnits, type DecimalString } from '@olcys/core';
import { ChainProviderError } from './errors.ts';

/**
 * Integer base units (satoshi, wei, sun) → canonical whole units without floats: `('5000000', 8)` → `0.05`.
 * Throws `TypeError` for anything but a non-negative integer.
 */
export function baseUnitsToDecimal(raw: string | bigint | number, decimals: number): DecimalString {
  const text = typeof raw === 'number' ? (Number.isSafeInteger(raw) ? String(raw) : '') : String(raw);
  if (!/^\d+$/.test(text)) throw new TypeError(`not a non-negative integer amount: ${JSON.stringify(String(raw))}`);
  if (!supportedDecimals(decimals)) throw new TypeError(`bad decimals: ${decimals}`);
  return fromBaseUnits(text, decimals);
}

/** Largest token precision the converter supports (uint8 decimals beyond this never occur in real tokens). */
export const MAX_DECIMALS = 77;

export function supportedDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS;
}

export type SkipReason = 'unsupported_decimals' | 'invalid_amount';

/** Per-row conversion that never throws: a row it cannot represent is skipped with a reason. */
export function rowAmount(raw: unknown, decimals: number): { amount: DecimalString } | { skip: SkipReason } {
  if (!supportedDecimals(decimals)) return { skip: 'unsupported_decimals' };
  const text = typeof raw === 'number' ? (Number.isSafeInteger(raw) ? String(raw) : '') : String(raw ?? '');
  if (!/^\d+$/.test(text)) return { skip: 'invalid_amount' };
  return { amount: fromBaseUnits(text, decimals) };
}

/** Opaque provider-specific cursor: base64url JSON `{ v: 1, p: providerId, …state }`. */
export function encodeCursor(providerId: string, state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, p: providerId, ...state }), 'utf8').toString('base64url');
}

export function decodeCursor<T>(providerId: string, cursor: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new ChainProviderError('invalid_request', providerId, 'unreadable cursor', { cause: error });
  }
  const state = parsed as { v?: unknown; p?: unknown };
  if (state.v !== 1 || state.p !== providerId) {
    throw new ChainProviderError('invalid_request', providerId, 'cursor belongs to another provider');
  }
  return parsed as T;
}

/**
 * Index of a transfer row that carries no log/trace index of its own: a 48-bit hash of its content, so the same row
 * gets the same index on every page and in every address's listing (de-duplication stays exact). Identical rows of
 * one response are told apart by their occurrence number.
 */
export function contentIndex(parts: readonly (string | number)[]): number {
  return Number.parseInt(createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12), 16);
}

/** Counts identical content keys within one response (0 for the first occurrence). */
export function occurrences(): (key: string) => number {
  const seen = new Map<string, number>();
  return (key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  };
}

export const isoFromSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();
