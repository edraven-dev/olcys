/**
 * Normalised copy of a view for matching, with an exact offset map back to the original view text.
 * Order: html_decode → url_decode (URI contexts only) → nfkc (per grapheme cluster) → zero-width / bidi removal →
 * defang reversal → homoglyph folding (long mixed tokens only). Pure and offline.
 */
import { NORMALISATION_TRANSFORMS, type NormalisationTransform, type TextSpan } from '@olcys/core';
import { decodeHTMLStrict } from 'entities/decode';
import type { NormalisedText, TransformRange, ViewText } from '../pipeline-types.ts';
import { HOMOGLYPHS } from './homoglyphs.ts';

const BIT = Object.fromEntries(NORMALISATION_TRANSFORMS.map((t, i) => [t, 1 << i])) as Record<
  NormalisationTransform,
  number
>;

interface Removal {
  pos: number;
  transform: NormalisationTransform;
}

interface Mapped {
  text: string;
  start: Uint32Array;
  end: Uint32Array;
  flags: Uint16Array;
  removals: Removal[];
}

interface Edit {
  index: number;
  length: number;
  replacement: string;
  transform: NormalisationTransform;
}

function identity(text: string): Mapped {
  const n = text.length;
  const start = new Uint32Array(n);
  const end = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    start[i] = i;
    end[i] = i + 1;
  }
  return { text, start, end, flags: new Uint16Array(n), removals: [] };
}

/** Applies sorted, non-overlapping edits; every replacement unit maps to the whole replaced original range. */
function applyEdits(m: Mapped, edits: readonly Edit[]): Mapped {
  if (edits.length === 0) return m;
  const n = m.text.length;
  let outLength = n;
  for (const e of edits) outLength += e.replacement.length - e.length;
  const start = new Uint32Array(outLength);
  const end = new Uint32Array(outLength);
  const flags = new Uint16Array(outLength);
  const posMap = new Uint32Array(n + 1);
  const parts: string[] = [];
  const added: Removal[] = [];
  let i = 0;
  let o = 0;

  const copyTo = (upTo: number): void => {
    if (upTo <= i) return;
    parts.push(m.text.slice(i, upTo));
    start.set(m.start.subarray(i, upTo), o);
    end.set(m.end.subarray(i, upTo), o);
    flags.set(m.flags.subarray(i, upTo), o);
    for (let k = i; k < upTo; k += 1) posMap[k] = o + (k - i);
    o += upTo - i;
    i = upTo;
  };

  for (const e of edits) {
    copyTo(e.index);
    const last = e.index + e.length - 1;
    const s = m.start[e.index] ?? 0;
    const en = m.end[last] ?? s + 1;
    let f = BIT[e.transform];
    for (let k = e.index; k <= last; k += 1) {
      f |= m.flags[k] ?? 0;
      posMap[k] = o;
    }
    if (e.replacement.length === 0) {
      added.push({ pos: o, transform: e.transform });
    } else {
      for (let k = 0; k < e.replacement.length; k += 1) {
        start[o + k] = s;
        end[o + k] = en;
        flags[o + k] = f;
      }
      parts.push(e.replacement);
      o += e.replacement.length;
    }
    i = e.index + e.length;
  }
  copyTo(n);
  posMap[n] = o;

  const removals = [...m.removals.map((r) => ({ pos: posMap[r.pos] ?? o, transform: r.transform })), ...added].toSorted(
    (a, b) => a.pos - b.pos,
  );
  return { text: parts.join(''), start, end, flags, removals };
}

// --- steps -------------------------------------------------------------------------------------------------------

const ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function htmlDecodeEdits(text: string): Edit[] {
  if (!text.includes('&')) return [];
  const edits: Edit[] = [];
  for (const match of text.matchAll(ENTITY)) {
    const decoded = decodeHTMLStrict(match[0]);
    if (decoded !== match[0] && decoded.length > 0) {
      edits.push({ index: match.index, length: match[0].length, replacement: decoded, transform: 'html_decode' });
    }
  }
  return edits;
}

const URI_ATTRIBUTES = new Set(['href', 'src', 'action', 'cite']);
const URI_TOKEN = /[^\s"'<>]+/g;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

function lowerBound(arr: Uint32Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0;
}

const UTF8_MIN = [0, 0, 0x80, 0x800, 0x10000];

/** Percent-decodes valid UTF-8 sequences in `[from, to)`; invalid sequences stay as they are. */
function decodePercentRuns(text: string, from: number, to: number, edits: Edit[]): void {
  PERCENT_RUN.lastIndex = from;
  for (let match = PERCENT_RUN.exec(text); match && match.index < to; match = PERCENT_RUN.exec(text)) {
    const runEnd = Math.min(match.index + match[0].length, to);
    const count = Math.floor((runEnd - match.index) / 3);
    const bytes: number[] = [];
    for (let k = 0; k < count; k += 1)
      bytes.push(Number.parseInt(text.slice(match.index + 3 * k + 1, match.index + 3 * k + 3), 16));
    let k = 0;
    while (k < bytes.length) {
      const lead = bytes[k] ?? 0;
      const len = utf8Length(lead);
      let cp = len === 1 ? lead : len === 2 ? lead & 0x1f : len === 3 ? lead & 0x0f : lead & 0x07;
      let ok = len > 0 && k + len <= bytes.length;
      for (let c = 1; ok && c < len; c += 1) {
        const cont = bytes[k + c] ?? 0;
        if ((cont & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (cont & 0x3f);
      }
      if (ok && (cp < (UTF8_MIN[len] ?? 0) || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff)) ok = false;
      if (!ok) {
        k += 1;
        continue;
      }
      edits.push({
        index: match.index + 3 * k,
        length: 3 * len,
        replacement: String.fromCodePoint(cp),
        transform: 'url_decode',
      });
      k += len;
    }
  }
}

function urlDecodeEdits(m: Mapped, view: ViewText): Edit[] {
  const text = m.text;
  if (!text.includes('%')) return [];
  const ranges: [number, number][] = [];
  for (const segment of view.segments) {
    if (!segment.attribute || !URI_ATTRIBUTES.has(segment.attribute)) continue;
    const from = lowerBound(m.start, segment.start);
    const to = lowerBound(m.start, segment.end);
    if (to > from) ranges.push([from, to]);
  }
  for (const token of text.matchAll(URI_TOKEN)) {
    if (token[0].includes('%') && URI_SCHEME.test(token[0])) ranges.push([token.index, token.index + token[0].length]);
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const edits: Edit[] = [];
  let [curFrom, curTo] = ranges[0] ?? [0, 0];
  for (const [from, to] of ranges.slice(1)) {
    if (from <= curTo) {
      curTo = Math.max(curTo, to);
      continue;
    }
    decodePercentRuns(text, curFrom, curTo, edits);
    curFrom = from;
    curTo = to;
  }
  decodePercentRuns(text, curFrom, curTo, edits);
  return edits;
}

/** A grapheme cluster that may change under NFKC: a non-ASCII base, or an ASCII base followed by marks. */
const CLUSTER = /[\u{0080}-\u{10FFFF}]\p{M}*|[\u{0020}-\u{007E}]\p{M}+/gu;
const NON_ASCII = /[\u{0080}-\u{10FFFF}]/u;

function nfkcEdits(text: string): Edit[] {
  if (!NON_ASCII.test(text)) return [];
  const edits: Edit[] = [];
  for (const match of text.matchAll(CLUSTER)) {
    const normalised = match[0].normalize('NFKC');
    if (normalised !== match[0]) {
      edits.push({ index: match.index, length: match[0].length, replacement: normalised, transform: 'nfkc' });
    }
  }
  return edits;
}

const INVISIBLE =
  /([\u{00AD}\u{180E}\u{200B}-\u{200D}\u{2060}-\u{2064}\u{FEFF}\u{E0000}-\u{E007F}])|([\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}])/gu;

function removalEdits(text: string): Edit[] {
  if (!NON_ASCII.test(text)) return [];
  const edits: Edit[] = [];
  for (const match of text.matchAll(INVISIBLE)) {
    edits.push({
      index: match.index,
      length: match[0].length,
      replacement: '',
      transform: match[1] ? 'zero_width_removed' : 'bidi_removed',
    });
  }
  return edits;
}

const DEFANG =
  /\[\.\]|\(\.\)|\[dot\]|\(dot\)|\{dot\}|\[kropka\]|\[at\]|\(at\)|\[@\]|\(@\)|\[ma\u{0142}pa\]|\(ma\u{0142}pa\)|\[:\]|\[\/\]|\bh(?:xx|__)p(?=s?(?::|\[:\]))/giu;

function defangReplacement(match: string): string {
  const lower = match.toLowerCase();
  if (lower.startsWith('h')) return 'http';
  if (lower.includes('.') || lower.includes('dot') || lower.includes('kropka')) return '.';
  if (lower === '[:]') return ':';
  if (lower === '[/]') return '/';
  return '@';
}

function defangEdits(text: string): Edit[] {
  const edits: Edit[] = [];
  for (const match of text.matchAll(DEFANG)) {
    edits.push({
      index: match.index,
      length: match[0].length,
      replacement: defangReplacement(match[0]),
      transform: 'defang_reversed',
    });
  }
  return edits;
}

const LONG_TOKEN = /[\p{L}\p{N}]{20,}/gu;

function homoglyphEdits(text: string): Edit[] {
  if (!NON_ASCII.test(text)) return [];
  const edits: Edit[] = [];
  for (const match of text.matchAll(LONG_TOKEN)) {
    const token = match[0];
    if (!/[A-Za-z0-9]/.test(token)) continue;
    for (let k = 0; k < token.length; k += 1) {
      const folded = HOMOGLYPHS.get(token[k] ?? '');
      if (folded) edits.push({ index: match.index + k, length: 1, replacement: folded, transform: 'homoglyph_folded' });
    }
  }
  return edits;
}

// --- result ------------------------------------------------------------------------------------------------------

function transformRanges(m: Mapped): TransformRange[] {
  const ranges: TransformRange[] = [];
  for (const transform of NORMALISATION_TRANSFORMS) {
    const bit = BIT[transform];
    let runStart = -1;
    for (let i = 0; i <= m.flags.length; i += 1) {
      const on = i < m.flags.length && ((m.flags[i] ?? 0) & bit) !== 0;
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        ranges.push({ transform, start: runStart, end: i });
        runStart = -1;
      }
    }
  }
  for (const r of m.removals) ranges.push({ transform: r.transform, start: r.pos, end: r.pos });
  return ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

/** Normalises one view for matching (pure; the original view text is never modified). */
export function normaliseView(view: ViewText): NormalisedText {
  let m = identity(view.text);
  m = applyEdits(m, htmlDecodeEdits(m.text));
  m = applyEdits(m, urlDecodeEdits(m, view));
  m = applyEdits(m, nfkcEdits(m.text));
  m = applyEdits(m, removalEdits(m.text));
  m = applyEdits(m, defangEdits(m.text));
  m = applyEdits(m, homoglyphEdits(m.text));
  return {
    view: view.view,
    text: m.text,
    origStart: m.start,
    origEnd: m.end,
    transforms: transformRanges(m),
    unitTransforms: m.flags,
    removals: m.removals,
  };
}

function bitsFromRanges(n: NormalisedText, s: number, e: number): number {
  let bits = 0;
  for (const r of n.transforms) {
    if (r.start === r.end) continue;
    if (r.start < e && r.end > s) bits |= BIT[r.transform];
  }
  return bits;
}

/** Maps a normalised range `[s, e)` to the original view text and lists the transforms that produced it. */
export function mapSpan(
  n: NormalisedText,
  s: number,
  e: number,
): { span: TextSpan; transforms: NormalisationTransform[] } {
  if (!(s >= 0 && e > s && e <= n.text.length)) throw new RangeError(`invalid normalised range [${s}, ${e})`);
  const span: TextSpan = { start: n.origStart[s] ?? 0, end: n.origEnd[e - 1] ?? 0 };
  let bits = 0;
  if (n.unitTransforms) {
    for (let i = s; i < e; i += 1) bits |= n.unitTransforms[i] ?? 0;
  } else {
    bits = bitsFromRanges(n, s, e);
  }
  const removals =
    n.removals ?? n.transforms.filter((r) => r.start === r.end).map((r) => ({ pos: r.start, transform: r.transform }));
  let lo = 0;
  let hi = removals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((removals[mid]?.pos ?? 0) <= s) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < removals.length; k += 1) {
    const r = removals[k];
    if (!r || r.pos >= e) break;
    bits |= BIT[r.transform];
  }
  return { span, transforms: NORMALISATION_TRANSFORMS.filter((t) => (bits & BIT[t]) !== 0) };
}

/** First normalised index whose original start is `>= orig` (maps an original offset into the normalised text). */
export function toNormalised(n: NormalisedText, orig: number): number {
  return lowerBound(n.origStart, orig);
}
