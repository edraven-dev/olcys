import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { Sha256Hex } from '@olcys/core';

/** JSON with object keys sorted at every depth: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function sha256OfText(text: string): Sha256Hex {
  return hex.encode(sha256(new TextEncoder().encode(text)));
}
