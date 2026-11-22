/**
 * Encoding helpers (pure): base58check over double SHA-256, Keccak-256 for EIP-55.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createBase58check } from '@scure/base';

const base58check = createBase58check(sha256);

/** Payload of a base58check string, or undefined when the checksum or alphabet is invalid. */
export function decodeBase58check(value: string): Uint8Array | undefined {
  try {
    return base58check.decode(value);
  } catch {
    return undefined;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** EIP-55 mixed-case checksum encoding of a 40-hex-digit address (with or without `0x`). */
export function toEip55(address: string): string {
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
