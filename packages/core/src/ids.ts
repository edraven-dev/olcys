import type { Id } from './common.ts';

let lastMs = -1;
let sequence = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then a 12-bit counter (`rand_a`) that keeps ids generated within the
 * same millisecond strictly increasing, then 62 random bits. Uses Web Crypto, so it works in Node and in browsers.
 */
export function newId(nowMs: number = Date.now()): Id {
  if (nowMs > lastMs) {
    lastMs = nowMs;
    sequence = 0;
  } else {
    sequence += 1;
    if (sequence > 0xfff) {
      lastMs += 1;
      sequence = 0;
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = lastMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Current time as an ISO 8601 UTC string. */
export function nowIso(clock: { now(): Date } = { now: () => new Date() }): string {
  return clock.now().toISOString();
}
