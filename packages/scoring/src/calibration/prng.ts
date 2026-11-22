/**
 * xoshiro128** (Blackman & Vigna, public domain), seeded from one integer through splitmix32. 32-bit integer
 * arithmetic only, so every platform produces the same sequence for the same seed.
 */
function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.#a = next();
    this.#b = next();
    this.#c = next();
    this.#d = next();
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

  chance(p: number): boolean {
    return this.float() < p;
  }
}
