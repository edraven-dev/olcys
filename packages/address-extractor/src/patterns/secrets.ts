/**
 * Secret detection (private keys, extended private keys, seed phrases, hex keys with key context). Secrets are only
 * located so they can be redacted: the strings themselves are never returned, logged or stored.
 */
import type { SecretFinding } from '@olcys/core';
import { wordlist as czech } from '@scure/bip39/wordlists/czech.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { wordlist as french } from '@scure/bip39/wordlists/french.js';
import { wordlist as italian } from '@scure/bip39/wordlists/italian.js';
import { wordlist as portuguese } from '@scure/bip39/wordlists/portuguese.js';
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js';
import { decodeBase58check } from '../codecs.ts';
import { mapSpan, toNormalised } from '../normalise/normalise.ts';
import type { NormalisedText, SecretSpan, ViewText } from '../pipeline-types.ts';
import { foldText, foldWord } from '../text/fold.ts';
import { blockOf, containerRange, segmentAt } from '../views/segments.ts';
import { B58, LEFT, RIGHT } from './patterns.ts';

const WIF = new RegExp(`${LEFT}(?:5[HJK]${B58}{49}|[KLc9]${B58}{51})${RIGHT}`, 'g');
const BASE58_RUN = new RegExp(`${LEFT}${B58}{51,52}${RIGHT}`, 'g');
const WIF_VERSIONS = new Set([0x80, 0xef, 0xb0, 0x9e]);
const XPRV = new RegExp(`${LEFT}[xyztuvYZUV]prv${B58}{107}${RIGHT}`, 'g');
/** 64 or 128 hex digits: a transaction/block hash or a raw private key — only context tells them apart. */
const HEX_KEY = /(?<![0-9A-Za-z])(?:0x)?(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64})(?![0-9A-Za-z])/g;
const KEY_CONTEXT =
  /klucz\w*\s+prywatn\w*|prywatn\w*\s+klucz\w*|sekret\w*|fraz\w*\s+(?:odzyskiwania|seed)|ziarn\w*|\bseed\b|private[\s_-]?key|priv[\s_-]?key|secret[\s_-]?key|mnemonic|keystore/i;
const KEY_CONTEXT_CHARS = 100;

const MIN_SEED_WORDS = 12;
const WORD = /\p{L}+/gu;
const WORD_GAP = /^[\s,;.|\u{00B7}\u{2022}-]*(?:\d{1,2}[.)][\s,;.|\u{00B7}\u{2022}-]*)?$/u;
const MAX_WORD_GAP = 12;

let wordSets: Set<string>[] | undefined;
function seedWordSets(): Set<string>[] {
  wordSets ??= [english, spanish, french, italian, czech, portuguese].map(
    (list) => new Set(list.map((word) => foldWord(word))),
  );
  return wordSets;
}

export interface Range {
  nStart: number;
  nEnd: number;
}

function seedPhraseRanges(text: string): Range[] {
  const sets = seedWordSets();
  const words: { start: number; end: number; folded: string }[] = [];
  for (const match of text.matchAll(WORD)) {
    words.push({ start: match.index, end: match.index + match[0].length, folded: foldWord(match[0]) });
  }
  const ranges: Range[] = [];
  const runStart = sets.map(() => -1);
  const runLength = sets.map(() => 0);
  const close = (lang: number, lastWord: number): void => {
    const first = runStart[lang] ?? -1;
    if ((runLength[lang] ?? 0) >= MIN_SEED_WORDS && first >= 0) {
      ranges.push({ nStart: words[first]?.start ?? 0, nEnd: words[lastWord]?.end ?? 0 });
    }
    runStart[lang] = -1;
    runLength[lang] = 0;
  };
  words.forEach((word, index) => {
    const previous = words[index - 1];
    const gap = previous ? text.slice(previous.end, word.start) : '';
    const linked = previous !== undefined && gap.length > 0 && gap.length <= MAX_WORD_GAP && WORD_GAP.test(gap);
    sets.forEach((set, lang) => {
      if (!linked && (runLength[lang] ?? 0) > 0) close(lang, index - 1);
      if (set.has(word.folded)) {
        if ((runLength[lang] ?? 0) === 0) runStart[lang] = index;
        runLength[lang] = (runLength[lang] ?? 0) + 1;
      } else if ((runLength[lang] ?? 0) > 0) {
        close(lang, index - 1);
      }
    });
  });
  sets.forEach((_, lang) => close(lang, words.length - 1));
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.toSorted((a, b) => a.nStart - b.nStart);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.nStart <= last.nEnd) last.nEnd = Math.max(last.nEnd, r.nEnd);
    else out.push({ ...r });
  }
  return out;
}

/** True when private-key vocabulary appears within ±100 chars in the same container, or in the segment's key/label. */
function hasKeyContext(view: ViewText, norm: NormalisedText, nStart: number, nEnd: number): boolean {
  const origStart = norm.origStart[nStart] ?? 0;
  const container = containerRange(view, origStart);
  const from = Math.max(toNormalised(norm, container.start), nStart - KEY_CONTEXT_CHARS);
  const to = Math.min(toNormalised(norm, container.end), nEnd + KEY_CONTEXT_CHARS);
  if (KEY_CONTEXT.test(foldText(norm.text.slice(Math.max(0, from), Math.max(from, to))))) return true;
  const segment = segmentAt(view, origStart);
  const labels = [segment?.jsonPointer, segment?.attribute, blockOf(view, segment)?.structuralLabel];
  return labels.some(
    (label) => label !== undefined && KEY_CONTEXT.test(foldText(label.replace(/([a-z])([A-Z])/g, '$1 $2'))),
  );
}

export interface SecretAnalysis {
  secrets: SecretSpan[];
  /** 64/128-hex strings without key context (reported as `tx_hash_like`). */
  hashes: Range[];
}

/** Finds secrets and hash-like hex strings in one normalised view. */
export function analyseSecrets(view: ViewText, norm: NormalisedText): SecretAnalysis {
  const text = norm.text;
  const found: { kind: SecretFinding['kind']; range: Range }[] = [];
  const add = (kind: SecretFinding['kind'], nStart: number, nEnd: number): void => {
    found.push({ kind, range: { nStart, nEnd } });
  };

  for (const match of text.matchAll(WIF)) add('wif', match.index, match.index + match[0].length);
  for (const match of text.matchAll(BASE58_RUN)) {
    const payload = decodeBase58check(match[0]);
    if (payload && (payload.length === 33 || payload.length === 34) && WIF_VERSIONS.has(payload[0] ?? -1)) {
      add('wif', match.index, match.index + match[0].length);
    }
  }
  for (const match of text.matchAll(XPRV)) add('xprv', match.index, match.index + match[0].length);
  for (const range of seedPhraseRanges(text)) add('seed_phrase', range.nStart, range.nEnd);

  const hashes: Range[] = [];
  for (const match of text.matchAll(HEX_KEY)) {
    const nStart = match.index;
    const nEnd = match.index + match[0].length;
    if (hasKeyContext(view, norm, nStart, nEnd)) add('hex64_private_key_context', nStart, nEnd);
    else hashes.push({ nStart, nEnd });
  }

  // One finding per (kind, overlapping range).
  found.sort((a, b) => a.range.nStart - b.range.nStart || b.range.nEnd - a.range.nEnd);
  const secrets: SecretSpan[] = [];
  for (const item of found) {
    const duplicate = secrets.some(
      (s) => s.finding.kind === item.kind && item.range.nStart < s.nEnd && item.range.nEnd > s.nStart,
    );
    if (duplicate) continue;
    const { span } = mapSpan(norm, item.range.nStart, item.range.nEnd);
    secrets.push({ finding: { kind: item.kind, view: view.view, span }, ...item.range });
  }
  return { secrets, hashes };
}

/** Secret findings of one normalised view (kind, view and original span only). */
export function detectSecrets(view: ViewText, norm: NormalisedText): SecretFinding[] {
  return analyseSecrets(view, norm).secrets.map((s) => s.finding);
}
