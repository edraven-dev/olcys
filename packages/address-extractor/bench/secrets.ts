/**
 * Secret placeholders `{{SECRET:<kind>:<n>}}` of the corpus documents, filled in memory only: values are derived
 * from the corpus seed and never written to disk, logged or returned in a report (random payloads — no wallet
 * holds them). The fill keeps an offset map so ground-truth ranges follow the longer text.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import type { SecretKind } from './types.ts';

const base58check = createBase58check(sha256);
export const SECRET_PLACEHOLDER = /\{\{SECRET:(wif|xprv|seed_phrase|hex64_private_key_context):(\d+)\}\}/g;
/** Length of the fragments searched by the leak check. */
export const LEAK_WINDOW = 12;

function derive(seed: string, docId: string, kind: SecretKind, index: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let counter = 0, filled = 0; filled < length; counter += 1) {
    const block = sha256(new TextEncoder().encode(`${seed}|secret|${docId}|${kind}|${index}|${counter}`));
    out.set(block.subarray(0, Math.min(block.length, length - filled)), filled);
    filled += block.length;
  }
  return out;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Layouts of a seed phrase on a page (JSON strings only get the plain one: no raw newlines inside strings). */
function layoutPhrase(words: string[], variant: number, docType: string): string {
  if (docType === 'json') return words.join(' ');
  switch (variant % 4) {
    case 1:
      return words.map((w, i) => `${i + 1}. ${w}`).join(' ');
    case 2:
      return words.join(', ');
    case 3:
      return docType === 'txt' ? words.join('\n') : words.join(' ');
    default:
      return words.join(' ');
  }
}

/** The secret behind one placeholder of one document. */
export function secretValue(seed: string, docId: string, kind: SecretKind, index: number, docType: string): string {
  switch (kind) {
    case 'wif': {
      const b = derive(seed, docId, kind, index, 33);
      const compressed = ((b[32] ?? 0) & 1) === 1;
      return base58check.encode(concat([0x80], b.subarray(0, 32), compressed ? [0x01] : []));
    }
    case 'xprv': {
      const b = derive(seed, docId, kind, index, 64);
      // version ‖ depth ‖ parent fingerprint ‖ child number ‖ chain code ‖ 0x00 ‖ key (BIP-32 layout).
      return base58check.encode(
        concat([0x04, 0x88, 0xad, 0xe4, 0x00], [0, 0, 0, 0], [0, 0, 0, 0], b.subarray(0, 32), [0x00], b.subarray(32)),
      );
    }
    case 'seed_phrase': {
      const b = derive(seed, docId, kind, index, 34);
      const long = ((b[32] ?? 0) & 1) === 1;
      const words = entropyToMnemonic(b.subarray(0, long ? 32 : 16), english).split(' ');
      return layoutPhrase(words, b[33] ?? 0, docType);
    }
    case 'hex64_private_key_context': {
      const b = derive(seed, docId, kind, index, 33);
      return ((b[32] ?? 0) & 3) === 0 ? `0x${hex(b.subarray(0, 32))}` : hex(b.subarray(0, 32));
    }
  }
}

export interface FilledSecret {
  kind: SecretKind;
  index: number;
  value: string;
  /** Range in the filled text. */
  start: number;
  end: number;
}

export interface FilledDocument {
  text: string;
  secrets: FilledSecret[];
  /** Maps an offset of the stored document to the filled text (offsets inside a placeholder map to its start). */
  mapOffset: (offset: number) => number;
}

export function fillSecrets(text: string, docId: string, docType: string, seed: string): FilledDocument {
  const secrets: FilledSecret[] = [];
  /** Placeholder range in the stored text and the offset shift before / after it. */
  const shifts: { at: number; end: number; before: number; after: number }[] = [];
  let out = '';
  let last = 0;
  let delta = 0;
  for (const m of text.matchAll(SECRET_PLACEHOLDER)) {
    const kind = m[1] as SecretKind;
    const index = Number(m[2]);
    const value = secretValue(seed, docId, kind, index, docType);
    out += text.slice(last, m.index);
    secrets.push({ kind, index, value, start: out.length, end: out.length + value.length });
    out += value;
    last = m.index + m[0].length;
    const after = delta + value.length - m[0].length;
    shifts.push({ at: m.index, end: last, before: delta, after });
    delta = after;
  }
  out += text.slice(last);
  const mapOffset = (offset: number): number => {
    let shift = 0;
    for (const s of shifts) {
      if (offset < s.at) break;
      if (offset < s.end) return s.at + s.before;
      shift = s.after;
    }
    return offset + shift;
  };
  return { text: out, secrets, mapOffset };
}

/**
 * Fragments searched by the leak check: every `LEAK_WINDOW`-character window of each secret as written, and — for
 * seed phrases — of its words joined by single spaces, so a phrase still matches after its separators changed
 * (newlines, numbering, commas, JSON escapes).
 */
export interface LeakFragments {
  raw: ReadonlySet<string>;
  words: ReadonlySet<string>;
}

/** Letter runs joined by single spaces (`1. abandon\nability` → `abandon ability`). */
export function wordsOf(text: string): string {
  return (text.match(/\p{L}+/gu) ?? []).join(' ');
}

function windows(value: string, into: Set<string>): void {
  if (value.length < LEAK_WINDOW) into.add(value);
  for (let i = 0; i + LEAK_WINDOW <= value.length; i += 1) into.add(value.slice(i, i + LEAK_WINDOW));
}

export function secretFragments(values: readonly string[]): LeakFragments {
  const raw = new Set<string>();
  const words = new Set<string>();
  for (const value of values) {
    windows(value, raw);
    if (/[\s,]/.test(value)) windows(wordsOf(value), words);
  }
  return { raw, words };
}

/** Merges fragment sets (e.g. of every document of a run). */
export function mergeFragments(into: { raw: Set<string>; words: Set<string> }, add: LeakFragments): void {
  for (const f of add.raw) into.raw.add(f);
  for (const f of add.words) into.words.add(f);
}

function countWindows(text: string, fragments: ReadonlySet<string>): number {
  if (fragments.size === 0) return 0;
  let leaks = 0;
  for (let i = 0; i + LEAK_WINDOW <= text.length; i += 1) if (fragments.has(text.slice(i, i + LEAK_WINDOW))) leaks += 1;
  return leaks;
}

/** Positions in `text` where a secret fragment starts (as written, or as a word sequence). */
export function countLeaks(text: string, fragments: LeakFragments): number {
  return (
    countWindows(text, fragments.raw) + (fragments.words.size > 0 ? countWindows(wordsOf(text), fragments.words) : 0)
  );
}

/**
 * Leak count over every string inside a value, walked recursively and never through an escaping serialisation:
 * object keys and own property values (getters are not invoked), arrays, `Map`/`Set` entries, `Error` messages,
 * stacks and causes, and UTF-8 byte arrays. Cycles are visited once.
 */
export function countLeaksIn(value: unknown, fragments: LeakFragments, seen: WeakSet<object> = new WeakSet()): number {
  if (typeof value === 'string') return countLeaks(value, fragments);
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Uint8Array) return countLeaks(new TextDecoder().decode(value), fragments);
  if (ArrayBuffer.isView(value)) return 0;
  let n = 0;
  if (value instanceof Map) {
    for (const [k, v] of value) n += countLeaksIn(k, fragments, seen) + countLeaksIn(v, fragments, seen);
    return n;
  }
  if (value instanceof Set) {
    for (const v of value) n += countLeaksIn(v, fragments, seen);
    return n;
  }
  if (value instanceof Error) {
    n += countLeaks(value.message, fragments) + countLeaks(value.stack ?? '', fragments);
    n += countLeaksIn(value.cause, fragments, seen);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') n += countLeaks(key, fragments);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) n += countLeaksIn(descriptor.value, fragments, seen);
  }
  return n;
}
