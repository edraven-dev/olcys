import { fromBaseUnits, type DecimalString } from '@olcys/core';
import { ChainProviderError } from './errors.ts';

/**
 * Integer base units (satoshi, wei, sun) → canonical whole units without floats: `('5000000', 8)` → `0.05`.
 * Throws `TypeError` for anything but a non-negative integer.
 */
export function baseUnitsToDecimal(raw: string | bigint | number, decimals: number): DecimalString {
  const text = typeof raw === 'number' ? (Number.isSafeInteger(raw) ? String(raw) : '') : String(raw);
  if (!/^\d+$/.test(text)) throw new TypeError(`not a non-negative integer amount: ${JSON.stringify(String(raw))}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new TypeError(`bad decimals: ${decimals}`);
  return fromBaseUnits(text, decimals);
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

export const isoFromSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();
