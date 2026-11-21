/**
 * Key, address and message-signature helpers for the offline fixture generator. Synthetic keys only: they are created
 * in memory, used to derive addresses and sign the demo message, then zeroised. Never imported by `src/`.
 */
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base64, bech32, createBase58check, hex } from '@scure/base';

const base58check = createBase58check(sha256);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey33: Uint8Array;
  publicKey65: Uint8Array;
}

export function newKeyPair(): KeyPair {
  const secretKey = secp256k1.utils.randomSecretKey();
  return {
    secretKey,
    publicKey33: secp256k1.getPublicKey(secretKey, true),
    publicKey65: secp256k1.getPublicKey(secretKey, false),
  };
}

export function zeroise(key: KeyPair): void {
  key.secretKey.fill(0);
}

export const hash160 = (bytes: Uint8Array): Uint8Array => ripemd160(sha256(bytes));

export function p2wpkhAddress(publicKey33: Uint8Array): string {
  return bech32.encode('bc', [0, ...bech32.toWords(hash160(publicKey33))]);
}

export function p2pkhAddress(publicKey: Uint8Array): string {
  return base58check.encode(Uint8Array.of(0x00, ...hash160(publicKey)));
}

export function p2shP2wpkhAddress(publicKey33: Uint8Array): string {
  const redeemScript = Uint8Array.of(0x00, 0x14, ...hash160(publicKey33));
  return base58check.encode(Uint8Array.of(0x05, ...hash160(redeemScript)));
}

/** Witness program of a v0 bech32 address (20 bytes for P2WPKH). */
export function segwitProgram(address: string): Uint8Array {
  const decoded = bech32.decode(address as `${string}1${string}`);
  return Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
}

export function toChecksumAddress(lowerHex40: string): string {
  const digest = hex.encode(keccak_256(utf8(lowerHex40)));
  let out = '0x';
  for (let i = 0; i < lowerHex40.length; i += 1) {
    const ch = lowerHex40[i] ?? '';
    out += Number.parseInt(digest[i] ?? '0', 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

function evmBody(publicKey65: Uint8Array): Uint8Array {
  return keccak_256(publicKey65.subarray(1)).subarray(-20);
}

export function evmAddress(publicKey65: Uint8Array): string {
  return toChecksumAddress(hex.encode(evmBody(publicKey65)));
}

export function tronAddress(publicKey65: Uint8Array): string {
  return base58check.encode(Uint8Array.of(0x41, ...evmBody(publicKey65)));
}

/** Random EVM-style address without a key (counterparties, exchange listings). */
export function randomEvmAddress(): string {
  return toChecksumAddress(randomBytes(20).toString('hex'));
}

export function randomTronAddress(): string {
  return base58check.encode(Uint8Array.of(0x41, ...randomBytes(20)));
}

export function randomP2wpkhAddress(): string {
  return bech32.encode('bc', [0, ...bech32.toWords(randomBytes(20))]);
}

// --- BIP-137 -----------------------------------------------------------------------------------------------------

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** `sha256d(0x18 ‖ "Bitcoin Signed Message:\n" ‖ CompactSize(len) ‖ message)`. */
export function bip137Digest(message: string): Uint8Array {
  const body = utf8(message);
  return sha256(sha256(Uint8Array.of(...utf8('\x18Bitcoin Signed Message:\n'), ...compactSize(body.length), ...body)));
}

export type Bip137Kind = 'p2pkh_compressed' | 'p2sh_p2wpkh' | 'p2wpkh' | 'electrum';

const HEADER_BASE: Record<Bip137Kind, number> = { p2pkh_compressed: 31, electrum: 31, p2sh_p2wpkh: 35, p2wpkh: 39 };

/** BIP-137 signature: base64(header ‖ r ‖ s), low-S; Electrum uses the compressed-P2PKH header for every type. */
export function signBip137(secretKey: Uint8Array, message: string, kind: Bip137Kind): string {
  const recovered = secp256k1.sign(bip137Digest(message), secretKey, { prehash: false, format: 'recovered' });
  const recid = recovered[0] ?? 0;
  return base64.encode(Uint8Array.of(HEADER_BASE[kind] + recid, ...recovered.subarray(1)));
}

export type Bip137Result = 'valid' | 'invalid' | 'unsupported_format';

/**
 * Verifies a BIP-137 signature by public-key recovery and address re-derivation. Electrum-style headers (31–34) are
 * accepted for segwit addresses (compat mode). Used by the generator to self-check and by tests.
 */
export function verifyBip137(address: string, message: string, signature: string): Bip137Result {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(signature);
  } catch {
    return 'unsupported_format';
  }
  if (bytes.length !== 65) return 'unsupported_format';
  const header = bytes[0] ?? 0;
  if (header < 27 || header > 42) return 'unsupported_format';
  const recid = (header - 27) & 3;
  let publicKey33: Uint8Array;
  try {
    publicKey33 = secp256k1.recoverPublicKey(Uint8Array.of(recid, ...bytes.subarray(1)), bip137Digest(message), {
      prehash: false,
    });
  } catch {
    return 'invalid';
  }
  const candidates: string[] = [];
  if (header >= 27 && header <= 30) {
    candidates.push(p2pkhAddress(secp256k1.Point.fromBytes(publicKey33).toBytes(false)));
  } else if (header <= 34) {
    candidates.push(p2pkhAddress(publicKey33), p2wpkhAddress(publicKey33), p2shP2wpkhAddress(publicKey33));
  } else if (header <= 38) {
    candidates.push(p2shP2wpkhAddress(publicKey33));
  } else {
    candidates.push(p2wpkhAddress(publicKey33));
  }
  return candidates.includes(address) ? 'valid' : 'invalid';
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
