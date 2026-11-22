/**
 * xoshiro128** (Blackman & Vigna, public domain) — a small seedable PRNG for the synthetic corpus and the bootstrap.
 * 32-bit integer arithmetic only, so every platform produces the same sequence for the same seed.
 */
import { sha256 } from '@noble/hashes/sha2.js';

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Prng {
  readonly seed: string;
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    this.seed = seed;
    const digest = sha256(new TextEncoder().encode(seed));
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    this.#a = view.getUint32(0, true);
    this.#b = view.getUint32(4, true);
    this.#c = view.getUint32(8, true);
    this.#d = view.getUint32(12, true);
    if ((this.#a | this.#b | this.#c | this.#d) === 0) this.#a = 1;
  }

  /** Independent stream for a named part (changing one part never shifts the others). */
  fork(label: string): Prng {
    return new Prng(`${this.seed}/${label}`);
  }

  uint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#b, 5), 7), 9) >>> 0;
    const t = this.#b << 9;
    this.#c ^= this.#a;
    this.#d ^= this.#b;
    this.#b ^= this.#c;
    this.#a ^= this.#d;
    this.#c ^= t;
    this.#d = rotl(this.#d, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.uint32() / 4294967296;
  }

  /** Uniform integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.float() * max);
  }

  /** Uniform integer in [min, max] (inclusive). */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Prng.pick: empty list');
    return items[this.int(items.length)] as T;
  }

  /** Picks by integer weights (`[[value, weight], …]`). */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.int(total);
    for (const [value, weight] of items) {
      if (roll < weight) return value;
      roll -= weight;
    }
    throw new Error('Prng.weighted: empty or zero-weight list');
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 4) {
      const word = this.uint32();
      for (let k = 0; k < 4 && i + k < length; k += 1) out[i + k] = (word >>> (8 * k)) & 0xff;
    }
    return out;
  }
}
