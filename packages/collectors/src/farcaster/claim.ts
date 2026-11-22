/**
 * Farcaster verification claims: the Ethereum address signs an EIP-712 `VerificationClaim` that names the account's
 * FID. The check recovers the signer locally (no network, no node call) and compares it with the claimed address.
 * Contract wallets (ERC-1271) and Solana keys cannot be checked offline and are reported as such, never as valid.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base64, base58, hex } from '@scure/base';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const FARCASTER_EPOCH_SECONDS = 1_609_459_200;
const DOMAIN_SALT = 'f2d857f4a3edcb9b78b4d503bfe733db1e3f6cdc2b7971ee739626c97e86a558';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,bytes32 salt)';
const CLAIM_TYPE = 'VerificationClaim(uint256 fid,address address,bytes32 blockHash,uint8 network)';

/** Farcaster time (seconds since 2021-01-01T00:00:00Z) → ISO 8601 UTC. */
export function farcasterTimeToIso(farcasterSeconds: number): string {
  return new Date((farcasterSeconds + FARCASTER_EPOCH_SECONDS) * 1000).toISOString();
}

/** Bytes of a hub field: `0x` hex or base64 (Snapchain read nodes answer either way). */
export function decodeHubBytes(value: string): Uint8Array {
  const text = value.trim();
  if (/^0x([0-9a-fA-F]{2})*$/.test(text)) return hex.decode(text.slice(2).toLowerCase());
  return base64.decode(text);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const leftPad = (bytes: Uint8Array): Uint8Array => concat(new Uint8Array(32 - bytes.length), bytes);

export interface EthClaim {
  fid: bigint;
  /** 20 bytes. */
  address: Uint8Array;
  /** 32 bytes. */
  blockHash: Uint8Array;
  network: number;
}

/** EIP-712 digest of the claim (domain `Farcaster Verify Ethereum Address` 2.0.0). */
export function claimDigest(claim: EthClaim): Uint8Array {
  const domain = keccak_256(
    concat(
      keccak_256(utf8(DOMAIN_TYPE)),
      keccak_256(utf8('Farcaster Verify Ethereum Address')),
      keccak_256(utf8('2.0.0')),
      hex.decode(DOMAIN_SALT),
    ),
  );
  const struct = keccak_256(
    concat(
      keccak_256(utf8(CLAIM_TYPE)),
      word(claim.fid),
      leftPad(claim.address),
      claim.blockHash,
      word(BigInt(claim.network)),
    ),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** True when `signature` (65 bytes r‖s‖v) over the claim recovers to the claimed address. Never throws. */
export function verifyEthClaim(claim: EthClaim, signature: Uint8Array): boolean {
  if (claim.address.length !== 20 || claim.blockHash.length !== 32 || signature.length !== 65) return false;
  const v = signature[64] ?? 0;
  const recid = v >= 27 ? v - 27 : v;
  if (recid > 1) return false;
  try {
    const compressed = secp256k1.recoverPublicKey(
      Uint8Array.of(recid, ...signature.subarray(0, 64)),
      claimDigest(claim),
      { prehash: false },
    );
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    const recovered = keccak_256(uncompressed.subarray(1)).subarray(-20);
    return hex.encode(recovered) === hex.encode(claim.address);
  } catch {
    return false;
  }
}

export const solanaAddress = (key: Uint8Array): string => base58.encode(key);
