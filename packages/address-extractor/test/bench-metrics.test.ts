import { describe, expect, it } from 'vitest';
import { checkBc, spiderfootScan } from '../bench/baselines/spiderfoot.ts';
import { Bootstrap, f1Of, macroF1, precisionOf, recallOf, Tally } from '../bench/metrics.ts';
import { Prng } from '../bench/prng.ts';
import { countLeaks, fillSecrets, secretFragments, secretValue } from '../bench/secrets.ts';
import { gen, hex, bytes } from './helpers.ts';

describe('metric maths', () => {
  it('computes precision, recall and F1 from toy confusion counts', () => {
    const c = { tp: 8, fp: 2, fn: 4 };
    expect(precisionOf(c)).toBeCloseTo(0.8);
    expect(recallOf(c)).toBeCloseTo(8 / 12);
    expect(f1Of(c)).toBeCloseTo((2 * 0.8 * (8 / 12)) / (0.8 + 8 / 12));
  });

  it('leaves undefined ratios as NaN instead of inventing 0 or 1', () => {
    expect(precisionOf({ tp: 0, fp: 0, fn: 3 })).toBeNaN();
    expect(recallOf({ tp: 0, fp: 2, fn: 0 })).toBeNaN();
    expect(f1Of({ tp: 0, fp: 0, fn: 0 })).toBeNaN();
    expect(f1Of({ tp: 0, fp: 1, fn: 1 })).toBe(0);
  });

  it('sums per-document tallies', () => {
    const t = new Tally();
    t.add(0, 'tp', 3);
    t.add(1, 'tp');
    t.add(1, 'fn', 2);
    t.add(2, 'fp');
    expect(t.total()).toEqual({ tp: 4, fp: 1, fn: 2 });
  });

  it('bootstraps over documents reproducibly and brackets the point estimate', () => {
    const t = new Tally();
    for (let d = 0; d < 40; d += 1) t.add(d, d % 5 === 0 ? 'fn' : 'tp');
    const a = new Bootstrap(40, 500, 'seed').metrics(t);
    const b = new Bootstrap(40, 500, 'seed').metrics(t);
    expect(a).toEqual(b);
    expect(a.recall).toBeCloseTo(32 / 40);
    expect(a.recallCi95[0]).toBeLessThanOrEqual(a.recall);
    expect(a.recallCi95[1]).toBeGreaterThanOrEqual(a.recall);
    expect(a.recallCi95[0]).toBeLessThan(a.recallCi95[1]);
    expect(a.precisionCi95).toEqual([1, 1]);
  });

  it('macro-F1 averages over the classes present in the truth', () => {
    const { macroF1: score, byClass } = macroF1([
      { truth: 'donation', predicted: 'donation' },
      { truth: 'donation', predicted: 'unclear' },
      { truth: 'warning', predicted: 'warning' },
    ]);
    expect(byClass['donation']).toMatchObject({ tp: 1, fp: 0, fn: 1 });
    expect(byClass['unclear']).toMatchObject({ tp: 0, fp: 1, fn: 0 });
    expect(score).toBeCloseTo((2 / 3 + 1) / 2);
  });
});

describe('seeded PRNG', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = new Prng('x');
    const b = new Prng('x');
    const values = Array.from({ length: 100 }, () => a.int(7));
    expect(values).toEqual(Array.from({ length: 100 }, () => b.int(7)));
    expect(values.every((v) => v >= 0 && v < 7)).toBe(true);
    expect(new Prng('x').uint32()).not.toBe(new Prng('y').uint32());
    expect(new Prng('x').fork('a').uint32()).toBe(new Prng('x/a').uint32());
  });
});

describe('in-memory secrets', () => {
  it('fills placeholders and maps stored offsets to the filled text', () => {
    const stored = 'A {{SECRET:wif:1}} B {{SECRET:seed_phrase:1}} C';
    const filled = fillSecrets(stored, 'doc-1', 'html', 'seed');
    const [wif, phrase] = filled.secrets;
    expect(filled.text.startsWith(`A ${wif?.value} B `)).toBe(true);
    expect(filled.text.slice(wif?.start, wif?.end)).toBe(wif?.value);
    expect(filled.text.slice(phrase?.start, phrase?.end)).toBe(phrase?.value);
    expect(filled.text[filled.mapOffset(stored.lastIndexOf('C'))]).toBe('C');
    expect(filled.mapOffset(stored.indexOf('B'))).toBe(filled.text.indexOf(' B ') + 1);
    expect(filled.mapOffset(stored.indexOf('{{SECRET:seed'))).toBe(phrase?.start);
    expect(fillSecrets(stored, 'doc-1', 'html', 'seed').text).toBe(filled.text);
  });

  it('derives every kind with the expected shape', () => {
    expect(secretValue('s', 'd', 'wif', 1, 'html')).toMatch(/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/);
    expect(secretValue('s', 'd', 'xprv', 1, 'html')).toMatch(/^xprv[1-9A-HJ-NP-Za-km-z]{107}$/);
    expect(secretValue('s', 'd', 'hex64_private_key_context', 1, 'html')).toMatch(/^(?:0x)?[0-9a-f]{64}$/);
    expect(secretValue('s', 'd', 'seed_phrase', 1, 'json').split(' ').length).toBeGreaterThanOrEqual(12);
  });

  it('counts leaked fragments', () => {
    const fragments = secretFragments(['abcdefghijklmnop']);
    expect(countLeaks('xx abcdefghijkl yy', fragments)).toBe(1);
    expect(countLeaks('abcdefghijk', fragments)).toBe(0);
  });

  it('finds a seed phrase in a JSON-serialised log, where separators are escaped', () => {
    const phrase = secretValue('s', 'd', 'seed_phrase', 1, 'txt');
    const multiline = phrase.includes('\n') ? phrase : phrase.replaceAll(' ', '\n');
    const fragments = secretFragments([multiline]);
    const logged = JSON.stringify({ phrase: multiline, note: 'x\ty' });
    expect(logged).toContain('\\n');
    expect(countLeaks(logged, fragments)).toBeGreaterThan(0);
    expect(countLeaks(JSON.stringify({ phrase: 'abandon ability able' }), fragments)).toBe(0);
  });
});

/** The same string with its last character changed (an invalid bech32 checksum). */
const corrupted = (value: string): string => `${value.slice(0, -1)}${value.endsWith('q') ? 'p' : 'q'}`;

describe('SpiderFoot baseline', () => {
  it('validates base58 1…/3… matches only and keeps unvalidated bech32', () => {
    const p2pkh = gen.p2pkh('sf-1');
    expect(checkBc(p2pkh)).toBe(true);
    expect(checkBc(`${p2pkh.slice(0, -1)}${p2pkh.endsWith('2') ? '3' : '2'}`)).toBe(false);
    const badBech32 = corrupted(gen.p2wpkh('sf-2'));
    const found = spiderfootScan(` ${p2pkh} ${badBech32} `).map((m) => m.value);
    expect(found).toEqual([p2pkh, badBech32]);
  });

  it('takes the first 40 hex digits of a 0x + 64 hex hash and misses addresses after quotes or slashes', () => {
    const tx = `0x${hex(bytes('sf-tx', 32))}`;
    const evm = gen.evm('sf-evm');
    const [match] = spiderfootScan(` ${tx}`);
    expect(match?.value).toBe(tx.slice(0, 42));
    expect(spiderfootScan(`"${evm}" /address/${evm}`)).toEqual([]);
    expect(spiderfootScan(`>${evm}<`).map((m) => m.start)).toEqual([1]);
  });
});
