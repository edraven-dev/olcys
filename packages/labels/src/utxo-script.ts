/**
 * Script type of a Bitcoin address, from its encoding alone (no network): bech32 witness v0 with a 20- or 32-byte
 * program is P2WPKH / P2WSH, witness v1 with a 32-byte program (bech32m) is P2TR, base58check version 0x00 is P2PKH
 * and 0x05 is P2SH. Anything else — another network, a broken checksum, another witness version — is `unknown`.
 */
import { createHash } from 'node:crypto';
import type { UtxoScriptType } from '@olcys/core';
import { bech32, bech32m, createBase58check } from '@scure/base';

const base58check = createBase58check(
  (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest()),
);
const BECH32_LIMIT = 90;

function segwit(address: string): UtxoScriptType {
  // BIP-173: one case only.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return 'unknown';
  const lower = address.toLowerCase();
  const v0 = bech32.decodeUnsafe(lower, BECH32_LIMIT);
  const decoded = v0 ?? bech32m.decodeUnsafe(lower, BECH32_LIMIT);
  if (!decoded || decoded.prefix !== 'bc') return 'unknown';
  const [version, ...words] = decoded.words;
  const program = bech32.fromWordsUnsafe(words);
  if (!program) return 'unknown';
  // BIP-350: witness v0 uses bech32, every later version bech32m.
  if (version === 0 && v0) {
    if (program.length === 20) return 'p2wpkh';
    if (program.length === 32) return 'p2wsh';
    return 'unknown';
  }
  if (version === 1 && !v0 && program.length === 32) return 'p2tr';
  return 'unknown';
}

function legacy(address: string): UtxoScriptType {
  let payload: Uint8Array;
  try {
    payload = base58check.decode(address);
  } catch {
    return 'unknown';
  }
  if (payload.length !== 21) return 'unknown';
  if (payload[0] === 0x00) return 'p2pkh';
  if (payload[0] === 0x05) return 'p2sh';
  return 'unknown';
}

/** Bitcoin mainnet script type of `address` (pure). */
export function utxoScriptType(address: string): UtxoScriptType {
  return /^bc1/i.test(address) ? segwit(address) : legacy(address);
}
