/**
 * Obfuscations applied to one rendered address occurrence. Each returns the rendered markup and the range of the
 * address characters inside it (the ground-truth `source` range).
 */
import type { Prng } from '../../../bench/prng.ts';
import type { Obfuscation } from '../../../bench/types.ts';
import type { Ctx } from './template.ts';

export interface Rendered {
  text: string;
  /** Range of the address characters within `text`. */
  start: number;
  end: number;
}

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD'];
const BIDI = [
  '\u200E',
  '\u200F',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
];
/** Longest chunk of a split address (the gap joiner joins chunks of up to 20 characters). */
export const SPLIT_CHUNK = 16;

/** Obfuscations that split an address into chunks (only safe for checksummed formats). */
export const SPLITTING: ReadonlySet<Obfuscation> = new Set(['spaces4', 'newline', 'br_split', 'td_split']);

/** Obfuscations eligible per placeholder context (address placeholders). */
export const ELIGIBLE: Readonly<Record<Ctx, readonly Obfuscation[]>> = {
  text: ['spaces4', 'zero_width', 'bidi', 'fullwidth', 'span_split', 'br_split', 'entities'],
  pre: ['spaces4', 'newline', 'zero_width'],
  td: ['td_split', 'spaces4', 'zero_width', 'entities'],
  attr: ['entities', 'zero_width'],
  href: [],
  jsonld: [],
  plain: ['spaces4', 'newline', 'zero_width', 'bidi', 'fullwidth'],
  json: [],
};

/** Fewest equal chunks of at most `SPLIT_CHUNK` characters. */
export function chunks(value: string, size = SPLIT_CHUNK): string[] {
  const parts = Math.ceil(value.length / size);
  const base = Math.floor(value.length / parts);
  const extra = value.length % parts;
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < parts; i += 1) {
    const length = base + (i < extra ? 1 : 0);
    out.push(value.slice(at, at + length));
    at += length;
  }
  return out;
}

function groups(value: string, size: number): string[] {
  return value.match(new RegExp(`.{1,${size}}`, 'g')) ?? [value];
}

/** Distinct interior positions (1 \u2026 length-1), ascending. */
function interior(prng: Prng, length: number, count: number): number[] {
  const all = Array.from({ length: Math.max(0, length - 1) }, (_, i) => i + 1);
  return prng
    .shuffle(all)
    .slice(0, count)
    .toSorted((a, b) => a - b);
}

function insertAt(value: string, positions: readonly number[], pick: () => string): string {
  let out = '';
  let last = 0;
  for (const p of positions) {
    out += value.slice(last, p) + pick();
    last = p;
  }
  return out + value.slice(last);
}

/** Replaces the characters at `positions` (ascending) with encoded forms. */
function encodeAt(value: string, positions: readonly number[], encode: (char: string) => string): string {
  const set = new Set(positions);
  return [...value].map((c, i) => (set.has(i) ? encode(c) : c)).join('');
}

function whole(text: string): Rendered {
  return { text, start: 0, end: text.length };
}

export function obfuscate(value: string, obfuscation: Obfuscation | undefined, prng: Prng): Rendered {
  switch (obfuscation) {
    case undefined:
      return whole(value);
    case 'spaces4':
      return whole(groups(value, 4).join(' '));
    case 'newline':
      return whole(chunks(value).join('\n'));
    case 'zero_width':
      return whole(insertAt(value, interior(prng, value.length, prng.range(1, 3)), () => prng.pick(ZERO_WIDTH)));
    case 'bidi':
      return whole(insertAt(value, interior(prng, value.length, prng.range(1, 2)), () => prng.pick(BIDI)));
    case 'fullwidth':
      return whole([...value].map((c) => String.fromCodePoint((c.codePointAt(0) ?? 0) + 0xfee0)).join(''));
    case 'span_split': {
      const cuts = interior(prng, value.length - 4, prng.range(1, 3)).map((p) => p + 2);
      const parts: string[] = [];
      let last = 0;
      for (const cut of cuts) {
        parts.push(value.slice(last, cut));
        last = cut;
      }
      parts.push(value.slice(last));
      const text = parts.map((p) => `<span>${p}</span>`).join('');
      return { text, start: '<span>'.length, end: text.length - '</span>'.length };
    }
    case 'br_split':
      return whole(chunks(value).join('<br>'));
    case 'td_split':
      return whole(chunks(value).join('</td><td>'));
    case 'entities':
      return whole(
        encodeAt(value, interior(prng, value.length, prng.range(2, 3)), (c) =>
          prng.chance(0.5) ? `&#x${(c.codePointAt(0) ?? 0).toString(16)};` : `&#${c.codePointAt(0) ?? 0};`,
        ),
      );
    case 'percent':
      return whole(
        encodeAt(
          value,
          interior(prng, value.length, prng.range(2, 3)),
          (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')}`,
        ),
      );
    default:
      throw new Error(`obfuscation ${obfuscation} is not applied to address text`);
  }
}

/** `https://host/path` \u2192 `hxxps://host[.]tld/path`. */
export function defangUrl(url: string): string {
  const match = /^https:\/\/([^/]+)(.*)$/.exec(url);
  if (!match) return url;
  return `hxxps://${(match[1] ?? '').replaceAll('.', '[.]')}${match[2] ?? ''}`;
}
