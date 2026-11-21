import { describe, expect, it } from 'vitest';
import { mapSpan, normaliseView } from '../src/normalise/normalise.ts';
import { bytes, gen, plainView, viewsOf } from './helpers.ts';

/** Fullwidth form of an ASCII string (U+FF01…U+FF5E). */
const fullwidth = (s: string): string =>
  [...s].map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c)).join('');

const ZWSP = '\u{200B}';

describe('normaliseView', () => {
  it('folds fullwidth characters with NFKC and maps back to the fullwidth range', () => {
    const address = gen.p2wpkh('nfkc');
    const text = `Adres: ${fullwidth(address.slice(0, 4))}${address.slice(4)} koniec`;
    const norm = normaliseView(plainView(text));
    const at = norm.text.indexOf(address);
    expect(at).toBe(7);
    const { span, transforms } = mapSpan(norm, at, at + address.length);
    expect(text.slice(span.start, span.end)).toBe(`${fullwidth(address.slice(0, 4))}${address.slice(4)}`);
    expect(transforms).toEqual(['nfkc']);
  });

  it('removes zero-width characters; spans include them only when inside the match', () => {
    const address = gen.p2wpkh('zw');
    const inside = `${address.slice(0, 10)}${ZWSP}${address.slice(10)}`;
    const text = `x ${ZWSP}${inside} y`;
    const norm = normaliseView(plainView(text));
    expect(norm.text).not.toContain(ZWSP);
    const at = norm.text.indexOf(address);
    const { span, transforms } = mapSpan(norm, at, at + address.length);
    expect(text.slice(span.start, span.end)).toBe(inside);
    expect(transforms).toEqual(['zero_width_removed']);

    const clean = `x ${ZWSP}${address} y`;
    const n2 = normaliseView(plainView(clean));
    const at2 = n2.text.indexOf(address);
    const mapped = mapSpan(n2, at2, at2 + address.length);
    expect(clean.slice(mapped.span.start, mapped.span.end)).toBe(address);
    expect(mapped.transforms).toEqual([]);
  });

  it('removes bidi controls and the tag block', () => {
    const text = `a\u{202E}b\u{E0041}c`;
    const norm = normaliseView(plainView(text));
    expect(norm.text).toBe('abc');
    expect(mapSpan(norm, 0, 3).transforms).toEqual(['zero_width_removed', 'bidi_removed']);
  });

  it('reverses defanging', () => {
    const cases: [string, string][] = [
      ['kacper.fikcyjny[at]example[.]org', 'kacper.fikcyjny@example.org'],
      ['hxxps://example[.]org/x', 'https://example.org/x'],
      ['kontakt (małpa) example (dot) org', 'kontakt @ example . org'],
      ['h__p://example{dot}org[/]a', 'http://example.org/a'],
    ];
    for (const [input, expected] of cases) {
      const norm = normaliseView(plainView(input));
      expect(norm.text).toBe(expected);
      expect(mapSpan(norm, 0, norm.text.length).transforms).toContain('defang_reversed');
    }
  });

  it('decodes residual HTML entities (double encoding)', () => {
    const norm = normaliseView(plainView('bc1&#113;x &amp;amp; &#x62;'));
    expect(norm.text).toBe('bc1qx &amp; b');
    expect(mapSpan(norm, 0, 5).transforms).toEqual(['html_decode']);
  });

  it('URL-decodes URI attributes but not visible text', () => {
    const address = gen.p2wpkh('uri');
    const views = viewsOf(`<a href="bitcoin%3A${address}%3Famount%3D0.1">wpłać 100%25</a>`);
    const attribute = views.attribute;
    const visible = views.visible_text;
    if (!attribute || !visible) throw new Error('missing views');
    const norm = normaliseView(attribute);
    expect(norm.text).toBe(`bitcoin:${address}?amount=0.1`);
    expect(mapSpan(norm, 0, norm.text.length).transforms).toEqual(['url_decode']);
    expect(normaliseView(visible).text).toBe('wpłać 100%25');
  });

  it('URL-decodes scheme-like tokens in text, keeping invalid sequences', () => {
    const norm = normaliseView(plainView('ethereum:pay-0xabc%40%ZZ%E2%82 oraz 50%25'));
    expect(norm.text).toBe('ethereum:pay-0xabc@%ZZ%E2%82 oraz 50%25');
  });

  it('folds homoglyphs only inside long mixed tokens, never Polish letters or Cyrillic words', () => {
    const address = gen.p2wpkh('hg');
    const at = address.indexOf('a', 3);
    expect(at).toBeGreaterThan(0);
    const tampered = `${address.slice(0, at)}\u{0430}${address.slice(at + 1)}`;
    const norm = normaliseView(plainView(`adres ${tampered} koniec`));
    expect(norm.text).toBe(`adres ${address} koniec`);
    const start = norm.text.indexOf(address);
    expect(mapSpan(norm, start, start + address.length).transforms).toEqual(['homoglyph_folded']);

    for (const text of ['Zażółć gęślą jaźń', 'привет', 'приветприветприветпривет']) {
      expect(normaliseView(plainView(text)).text).toBe(text);
    }
  });

  it('keeps an exact offset map (property test)', () => {
    const pieces = [
      'a',
      'B',
      '1',
      ' ',
      '&amp;',
      '&#98;',
      ZWSP,
      '\u{FF42}',
      '\u{1F600}',
      '[.]',
      '(at)',
      'e\u{0301}',
      'ł',
      '%41',
    ];
    let seed = 0;
    const next = (): number => {
      seed = (seed + 1) | 0;
      return bytes(`prop-${seed}`, 1)[0] ?? 0;
    };
    for (let round = 0; round < 1000; round += 1) {
      const length = next() % 24;
      let text = '';
      for (let i = 0; i < length; i += 1) text += pieces[next() % pieces.length];
      const norm = normaliseView(plainView(text));
      let previous = 0;
      for (let i = 0; i < norm.text.length; i += 1) {
        const start = norm.origStart[i] ?? -1;
        const end = norm.origEnd[i] ?? -1;
        expect(start).toBeGreaterThanOrEqual(previous);
        expect(start).toBeLessThan(end);
        expect(end).toBeLessThanOrEqual(text.length);
        previous = start;
      }
    }
    const ascii = 'plain ASCII text without entities 123';
    const norm = normaliseView(plainView(ascii));
    expect(norm.text).toBe(ascii);
    expect([...norm.origStart]).toEqual([...ascii].map((_, i) => i));
    expect(norm.transforms).toEqual([]);
  });
});
