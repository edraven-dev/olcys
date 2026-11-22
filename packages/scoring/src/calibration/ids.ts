import { Rng } from './prng.ts';

/** 2026-11-21T12:00:00Z in milliseconds: the fixed time base of generated ids. */
const EPOCH_MS = Date.UTC(2026, 10, 21, 12, 0, 0);

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, '0');

/**
 * Repeatable UUIDv7 factory: the timestamp field is a constant epoch plus a counter (so ids sort in creation order),
 * the remaining bits come from the seeded PRNG with the version and variant bits set. The same seed gives the same
 * sequence on every platform; different seeds give different ids.
 */
export function createIdFactory(seed: number): () => string {
  const rng = new Rng(seed ^ 0x7f4a7c15);
  let counter = 0;
  return () => {
    const ts = EPOCH_MS + counter;
    counter += 1;
    const a = rng.uint32();
    const b = rng.uint32();
    const c = rng.uint32();
    const tsHex = hex(ts, 12);
    return [
      tsHex.slice(0, 8),
      tsHex.slice(8, 12),
      `7${hex(a & 0xfff, 3)}`,
      hex(0x8000 | (b & 0x3fff), 4),
      `${hex(c, 8)}${hex(rng.uint32() & 0xffff, 4)}`,
    ].join('-');
  };
}
