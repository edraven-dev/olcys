/**
 * ENS name handling that needs no library: a conservative normaliser and decoders of non-EVM coin addresses.
 * The normaliser accepts only what is unambiguous (ASCII letters, digits, `-`, `_`), lower-cased; everything else
 * (emoji, other scripts, invisible or format characters such as U+200B, mixed-script confusables) is refused instead
 * of being guessed, because a look-alike name must never be resolved. It is a strict subset of ENSIP-15.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';

const base58check = createBase58check(sha256);

export type NormaliseResult = { ok: true; name: string } | { ok: false; reason: string };

export function normaliseEnsName(raw: string): NormaliseResult {
  const text = raw.trim().normalize('NFC');
  if (!text) return { ok: false, reason: 'empty name' };
  if (/[^\x20-\x7e]/.test(text))
    return { ok: false, reason: 'not ASCII: invisible, look-alike or non-Latin characters' };
  const name = text.toLowerCase();
  const labels = name.split('.');
  if (labels.length < 2) return { ok: false, reason: 'a name needs at least two labels' };
  for (const label of labels) {
    if (!/^[a-z0-9_-]{1,63}$/.test(label)) return { ok: false, reason: `invalid label "${label.slice(0, 20)}"` };
    if (label.startsWith('-') || label.endsWith('-'))
      return { ok: false, reason: 'label starts or ends with a hyphen' };
    if (label.slice(2, 4) === '--') return { ok: false, reason: 'hyphens at positions 3 and 4' };
    if (label.replace(/^_+/, '').includes('_')) return { ok: false, reason: 'underscore inside a label' };
  }
  if (name.length > 253) return { ok: false, reason: 'name too long' };
  return { ok: true, name };
}

/** ENSIP-9 coin types read besides Ethereum (60). */
export const ENS_COIN_TYPES = [
  { coinType: 0, chain: 'bitcoin', symbol: 'btc' },
  { coinType: 195, chain: 'tron', symbol: 'trx' },
] as const;

const hexOf = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Decodes the raw bytes of an ENSIP-9 coin address; undefined when the form is not a plain address. */
export function decodeCoinAddress(coinType: number, bytes: Uint8Array): string | undefined {
  const h = hexOf(bytes);
  if (coinType === 0) {
    if (/^76a914[0-9a-f]{40}88ac$/.test(h)) return base58check.encode(Uint8Array.of(0x00, ...bytes.subarray(3, 23)));
    if (/^a914[0-9a-f]{40}87$/.test(h)) return base58check.encode(Uint8Array.of(0x05, ...bytes.subarray(2, 22)));
    if (/^0014[0-9a-f]{40}$/.test(h)) return bech32.encode('bc', [0, ...bech32.toWords(bytes.subarray(2))]);
    if (/^0020[0-9a-f]{64}$/.test(h)) return bech32.encode('bc', [0, ...bech32.toWords(bytes.subarray(2))]);
    if (/^5120[0-9a-f]{64}$/.test(h)) return bech32m.encode('bc', [1, ...bech32m.toWords(bytes.subarray(2))]);
    return undefined;
  }
  if (coinType === 195) return bytes.length === 21 && bytes[0] === 0x41 ? base58check.encode(bytes) : undefined;
  return undefined;
}

/** Value of an attacker-controlled record: control characters removed, at most 2 KB. */
export function cleanRecord(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 2048);
}
