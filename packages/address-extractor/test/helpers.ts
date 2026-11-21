/**
 * Test helpers: deterministic synthetic addresses and secrets generated at test time (never committed), and small
 * builders for captures and views. No real addresses, keys or persons.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base32nopad, base58, bech32, bech32m, createBase58check } from '@scure/base';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { toEip55 } from '../src/codecs.ts';
import { normaliseView } from '../src/normalise/normalise.ts';
import type { CaptureContent, NormalisedText, ViewText } from '../src/pipeline-types.ts';
import { buildViews } from '../src/views/build.ts';

const base58check = createBase58check(sha256);

/** Deterministic pseudo-random bytes (SHA-256 counter mode over a label). */
export function bytes(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let filled = 0;
  for (let counter = 0; filled < length; counter += 1) {
    const block = sha256(new TextEncoder().encode(`${label}#${counter}`));
    out.set(block.subarray(0, Math.min(block.length, length - filled)), filled);
    filled += block.length;
  }
  return out;
}

const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const gen = {
  p2wpkh: (label: string): string => bech32.encode('bc', [0, ...bech32.toWords(bytes(label, 20))]),
  p2wsh: (label: string): string => bech32.encode('bc', [0, ...bech32.toWords(bytes(label, 32))]),
  p2tr: (label: string): string => bech32m.encode('bc', [1, ...bech32m.toWords(bytes(label, 32))]),
  p2pkh: (label: string): string => base58check.encode(concat([0x00], bytes(label, 20))),
  p2sh: (label: string): string => base58check.encode(concat([0x05], bytes(label, 20))),
  /** EIP-55 checksummed EVM address. */
  evm: (label: string): string => toEip55(hex(bytes(label, 20))),
  evmLower: (label: string): string => `0x${hex(bytes(label, 20))}`,
  tron: (label: string): string => base58check.encode(concat([0x41], bytes(label, 20))),
  /** 0x + 64 hex: looks like a transaction hash. */
  txHash: (label: string): string => `0x${hex(bytes(label, 32))}`,
  hex64: (label: string): string => hex(bytes(label, 32)),
  /** IPFS CIDv0 (`Qm…`, base58 multihash) and CIDv1 (`bafy…`, base32 dag-pb). */
  cidV0: (label: string): string => base58.encode(concat([0x12, 0x20], bytes(label, 32))),
  cidV1: (label: string): string =>
    `b${base32nopad.encode(concat([0x01, 0x70, 0x12, 0x20], bytes(label, 32))).toLowerCase()}`,
  // --- secrets (generated in memory at test time only) ---
  wif: (label: string): string => base58check.encode(concat([0x80], bytes(label, 32), [0x01])),
  xprv: (label: string): string => base58check.encode(concat([0x04, 0x88, 0xad, 0xe4], bytes(label, 74))),
  mnemonic12: (label: string): string => entropyToMnemonic(bytes(label, 16), english),
  mnemonic24: (label: string): string => entropyToMnemonic(bytes(label, 32), english),
};

/** A bech32 address with the first data `a` replaced by Cyrillic U+0430 (a homoglyph decoy). */
export function homoglyphOf(label: string): { clean: string; tampered: string } {
  for (let i = 0; i < 100; i += 1) {
    const clean = gen.p2wpkh(`${label}-${i}`);
    const at = clean.indexOf('a', 3);
    if (at > 0) return { clean, tampered: `${clean.slice(0, at)}\u{0430}${clean.slice(at + 1)}` };
  }
  throw new Error('no address with an `a` found');
}

export function htmlCapture(html: string, mediaType = 'text/html; charset=utf-8'): CaptureContent {
  return {
    captureId: '00000000-0000-7000-8000-000000000001',
    url: 'https://example.org/page',
    finalUrl: 'https://example.org/page',
    artifacts: [{ kind: 'html', mediaType, bytes: new TextEncoder().encode(html) }],
  };
}

export function jsonCapture(json: string): CaptureContent {
  return {
    captureId: '00000000-0000-7000-8000-000000000002',
    url: 'https://example.org/api',
    finalUrl: 'https://example.org/api',
    artifacts: [{ kind: 'json', mediaType: 'application/json', bytes: new TextEncoder().encode(json) }],
  };
}

export function textCapture(text: string): CaptureContent {
  return {
    captureId: '00000000-0000-7000-8000-000000000003',
    url: 'https://example.org/note.txt',
    finalUrl: 'https://example.org/note.txt',
    artifacts: [{ kind: 'text', mediaType: 'text/plain; charset=utf-8', bytes: new TextEncoder().encode(text) }],
  };
}

/** Views of an HTML snippet keyed by view name (first of each kind). */
export function viewsOf(html: string): Partial<Record<ViewText['view'], ViewText>> {
  const out: Partial<Record<ViewText['view'], ViewText>> = {};
  for (const v of buildViews(htmlCapture(html))) out[v.view] ??= v;
  return out;
}

/** A single visible_text-like view over plain text (one segment, one container). */
export function plainView(text: string): ViewText {
  return {
    captureId: 'test',
    view: 'visible_text',
    text,
    segments: [
      {
        start: 0,
        end: text.length,
        tag: 'p',
        path: 'body>p',
        inCode: false,
        quoted: false,
        hidden: false,
        blockIndex: 0,
        container: 0,
      },
    ],
    blocks: [{ index: 0, start: 0, end: text.length, tag: 'p', container: 0, headingPath: [] }],
    warnings: [],
  };
}

export function normalised(view: ViewText): { view: ViewText; norm: NormalisedText } {
  return { view, norm: normaliseView(view) };
}

/** Every substring of `secret` of length `n` (for "no fragment leaked" assertions). */
export function fragments(secret: string, n = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= secret.length; i += 1) out.push(secret.slice(i, i + n));
  return out;
}
