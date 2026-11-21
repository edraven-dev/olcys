import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, bech32, createBase58check } from '@scure/base';

export type Bip137Result = 'valid' | 'invalid' | 'unsupported_format';

const base58check = createBase58check(sha256);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hash160 = (bytes: Uint8Array): Uint8Array => ripemd160(sha256(bytes));

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** `sha256d(0x18 ‖ "Bitcoin Signed Message:\n" ‖ CompactSize(len) ‖ message)`. */
function messageDigest(message: string): Uint8Array {
  const body = utf8(message);
  const prefix = utf8('\x18Bitcoin Signed Message:\n');
  const size = compactSize(body.length);
  const data = new Uint8Array(prefix.length + size.length + body.length);
  data.set(prefix, 0);
  data.set(size, prefix.length);
  data.set(body, prefix.length + size.length);
  return sha256(sha256(data));
}

type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh';

/** Mainnet address kinds a BIP-137 signature can prove (by prefix only; the comparison below is exact). */
function addressKind(address: string): AddressKind | undefined {
  if (/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return 'p2pkh';
  if (/^3[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return 'p2sh';
  if (/^bc1q[02-9ac-hj-np-z]{38}$/i.test(address)) return 'p2wpkh';
  return undefined;
}

const p2pkh = (publicKey: Uint8Array): string => base58check.encode(Uint8Array.of(0x00, ...hash160(publicKey)));
const p2wpkh = (publicKey33: Uint8Array): string => bech32.encode('bc', [0, ...bech32.toWords(hash160(publicKey33))]);
const p2shP2wpkh = (publicKey33: Uint8Array): string =>
  base58check.encode(Uint8Array.of(0x05, ...hash160(Uint8Array.of(0x00, 0x14, ...hash160(publicKey33)))));

/** Addresses the recovered key may sign for, by header: 27–30 P2PKH (uncompressed), 31–34 P2PKH (compressed; Electrum also uses it for segwit), 35–38 P2SH-P2WPKH, 39–42 P2WPKH. */
function addressesFor(header: number, publicKey33: Uint8Array): string[] {
  if (header <= 30) return [p2pkh(secp256k1.Point.fromBytes(publicKey33).toBytes(false))];
  if (header <= 34) return [p2pkh(publicKey33), p2wpkh(publicKey33), p2shP2wpkh(publicKey33)];
  if (header <= 38) return [p2shP2wpkh(publicKey33)];
  return [p2wpkh(publicKey33)];
}

function verifyExact(address: string, message: string, signature: Uint8Array): boolean {
  const header = signature[0] ?? 0;
  let publicKey33: Uint8Array;
  try {
    publicKey33 = secp256k1.recoverPublicKey(
      Uint8Array.of((header - 27) & 3, ...signature.subarray(1)),
      messageDigest(message),
      {
        prehash: false,
      },
    );
  } catch {
    return false; // not a point on the curve / r or s out of range: the signature does not verify
  }
  return addressesFor(header, publicKey33).includes(address);
}

/**
 * Verifies a Bitcoin signed message (BIP-137, Electrum-compatible) by public-key recovery and address re-derivation.
 * `unsupported_format` for anything that is not a 65-byte base64 signature with a BIP-137 header, or an address kind
 * BIP-137 cannot prove (e.g. Taproot, which needs BIP-322). A message pasted with CRLF line endings is also checked
 * with LF endings (forums and browsers rewrite line breaks).
 */
export function verifyBip137(address: string, message: string, signature: string): Bip137Result {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(signature.trim());
  } catch {
    return 'unsupported_format';
  }
  const header = bytes[0] ?? 0;
  if (bytes.length !== 65 || header < 27 || header > 42) return 'unsupported_format';
  const kind = addressKind(address.trim());
  if (!kind) return 'unsupported_format';
  const target = kind === 'p2wpkh' ? address.trim().toLowerCase() : address.trim();
  if (verifyExact(target, message, bytes)) return 'valid';
  if (message.includes('\r\n') && verifyExact(target, message.replaceAll('\r\n', '\n'), bytes)) return 'valid';
  return 'invalid';
}
