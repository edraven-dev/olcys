/**
 * Encoders and reference validators for the corpus generator. Written against the primitives (@scure/base,
 * @noble/hashes) on purpose — not against the extractor — so the ground truth does not inherit extractor bugs.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bech32, bech32m, createBase58check } from '@scure/base';

const base58check = createBase58check(sha256);

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
export const HEX = '0123456789abcdef';

export function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + (HEX[b & 0x0f] ?? '');
  return out;
}

export function base58checkEncode(version: readonly number[], payload: Uint8Array): string {
  return base58check.encode(concat(version, payload));
}

export function base58checkDecode(value: string): Uint8Array | undefined {
  try {
    return base58check.decode(value);
  } catch {
    return undefined;
  }
}

export function segwitEncode(hrp: string, version: number, program: Uint8Array): string {
  const coder = version === 0 ? bech32 : bech32m;
  return coder.encode(hrp, [version, ...coder.toWords(program)]);
}

/** Encodes with an explicit variant, also the wrong one (BIP-350 mismatch vectors). */
export function segwitEncodeWith(variant: 'bech32' | 'bech32m', version: number, program: Uint8Array): string {
  const coder = variant === 'bech32' ? bech32 : bech32m;
  return coder.encode('bc', [version, ...coder.toWords(program)]);
}

/** EIP-55 mixed-case checksum encoding. */
export function eip55(address: string): string {
  const lower = address.replace(/^0x/i, '').toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i] ?? '';
    const nibble = ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/** True when `value` would be a valid mainnet Bitcoin, EVM or TRON address (any case rules applied). */
export function isAcceptedAddress(value: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const hex = value.slice(2);
    return hex === hex.toLowerCase() || hex === hex.toUpperCase() || eip55(value) === value;
  }
  if (/^bc1/i.test(value)) {
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) return false;
    const lower = value.toLowerCase();
    const plain = bech32.decodeUnsafe(lower, 90);
    const modern = plain ? undefined : bech32m.decodeUnsafe(lower, 90);
    const decoded = plain ?? modern;
    if (!decoded || decoded.prefix !== 'bc') return false;
    const [version, ...words] = decoded.words;
    if (version === undefined || version > 16) return false;
    if ((version === 0) !== Boolean(plain)) return false;
    const program = bech32.fromWordsUnsafe(words);
    if (!program) return false;
    return version === 0 ? program.length === 20 || program.length === 32 : program.length >= 2 && program.length <= 40;
  }
  const payload = base58checkDecode(value);
  if (!payload || payload.length !== 21) return false;
  const version = payload[0];
  if (value.startsWith('T')) return version === 0x41;
  return version === 0x00 || version === 0x05;
}
