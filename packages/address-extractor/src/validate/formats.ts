/**
 * Per-chain format validators: decode, verify checksum, version byte / human-readable prefix, length and witness
 * rules, and produce the canonical form. Pure and offline.
 */
import type { ChainId, ChecksumInfo } from '@olcys/core';
import { bech32, bech32m } from '@scure/base';
import { decodeBase58check, toEip55, toHex } from '../codecs.ts';
import type { PatternId, RejectCode, ValidatedCandidate } from '../pipeline-types.ts';

export interface FormatOk {
  canonical: string;
  format: string;
  checksum: ChecksumInfo;
  defaultChain: ChainId;
  possibleChains: ChainId[];
  extras: ValidatedCandidate['extras'];
}

export type FormatResult = { ok: true; value: FormatOk } | { ok: false; code: RejectCode; detail?: string };

const fail = (code: RejectCode, detail?: string): FormatResult => ({
  ok: false,
  code,
  ...(detail ? { detail } : {}),
});

const NO_CHECKSUM: ChecksumInfo = { scheme: 'none', present: false, valid: true, bits: 0 };
const BASE58CHECK: ChecksumInfo = { scheme: 'base58check', present: true, valid: true, bits: 32 };
const BECH32_LIMIT = 90;

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

/** Bitcoin legacy base58check (`1…` P2PKH, `3…` P2SH). */
export function validateBitcoinBase58(value: string): FormatResult {
  const payload = decodeBase58check(value);
  if (!payload) return fail('checksum_invalid', 'base58check');
  if (payload.length !== 21) return fail('length_invalid', `decoded ${payload.length} bytes`);
  const version = payload[0] ?? -1;
  if (version === 0x00) {
    return {
      ok: true,
      value: {
        canonical: value,
        format: 'p2pkh',
        checksum: BASE58CHECK,
        defaultChain: 'bitcoin',
        possibleChains: ['bitcoin', 'bitcoincash'],
        extras: {},
      },
    };
  }
  if (version === 0x05) {
    return {
      ok: true,
      value: {
        canonical: value,
        format: 'p2sh',
        checksum: BASE58CHECK,
        defaultChain: 'bitcoin',
        possibleChains: ['bitcoin', 'litecoin', 'bitcoincash'],
        extras: {},
      },
    };
  }
  return fail('prefix_unknown', `version ${hexByte(version)}`);
}

/** Bitcoin segwit (BIP-173 bech32 for v0, BIP-350 bech32m for v1–16). */
export function validateBitcoinSegwit(value: string): FormatResult {
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) return fail('mixed_case');
  const lower = value.toLowerCase();
  let encoding: 'bech32' | 'bech32m' = 'bech32';
  let decoded = bech32.decodeUnsafe(lower, BECH32_LIMIT);
  if (!decoded) {
    decoded = bech32m.decodeUnsafe(lower, BECH32_LIMIT);
    encoding = 'bech32m';
  }
  if (!decoded) return fail('checksum_invalid', 'bech32');
  if (decoded.prefix !== 'bc') return fail('prefix_unknown', `hrp ${decoded.prefix}`);
  const [version, ...data] = decoded.words;
  if (version === undefined || version > 16)
    return fail('witness_program_invalid', `witness version ${version ?? 'missing'}`);
  const program = bech32.fromWordsUnsafe(data);
  if (!program) return fail('witness_program_invalid', 'invalid padding');
  let format: string;
  if (version === 0) {
    if (encoding !== 'bech32') return fail('bech32_variant_mismatch', 'witness v0 requires bech32');
    if (program.length === 20) format = 'p2wpkh';
    else if (program.length === 32) format = 'p2wsh';
    else return fail('witness_program_invalid', `v0 program of ${program.length} bytes`);
  } else {
    if (encoding !== 'bech32m') return fail('bech32_variant_mismatch', `witness v${version} requires bech32m`);
    if (program.length < 2 || program.length > 40) {
      return fail('witness_program_invalid', `v${version} program of ${program.length} bytes`);
    }
    format = version === 1 && program.length === 32 ? 'p2tr' : `segwit_v${version}`;
  }
  return {
    ok: true,
    value: {
      canonical: lower,
      format,
      checksum: { scheme: encoding, present: true, valid: true, bits: 30 },
      defaultChain: 'bitcoin',
      possibleChains: ['bitcoin'],
      extras: {},
    },
  };
}

/** EVM: all-lower / all-upper are unchecksummed; mixed case must be valid EIP-55. */
export function validateEvm(value: string): FormatResult {
  const hex = value.slice(2);
  const canonical = `0x${hex.toLowerCase()}`;
  const eip55 = toEip55(hex);
  const base = { canonical, defaultChain: 'evm:unknown' as const, possibleChains: ['evm:unknown' as const] };
  if (hex === hex.toLowerCase()) {
    return { ok: true, value: { ...base, format: 'evm_lower', checksum: NO_CHECKSUM, extras: { eip55 } } };
  }
  if (hex === hex.toUpperCase()) {
    return { ok: true, value: { ...base, format: 'evm_upper', checksum: NO_CHECKSUM, extras: { eip55 } } };
  }
  if (eip55 !== `0x${hex}`) return fail('checksum_invalid', 'eip55');
  const letters = (hex.match(/[a-fA-F]/g) ?? []).length;
  return {
    ok: true,
    value: {
      ...base,
      format: 'evm_eip55',
      checksum: { scheme: 'eip55', present: true, valid: true, bits: letters },
      extras: { eip55 },
    },
  };
}

/** TRON base58check with version byte 0x41. */
export function validateTron(value: string): FormatResult {
  const payload = decodeBase58check(value);
  if (!payload) return fail('checksum_invalid', 'base58check');
  if (payload.length !== 21) return fail('length_invalid', `decoded ${payload.length} bytes`);
  const version = payload[0] ?? -1;
  if (version !== 0x41) return fail('prefix_unknown', `version ${hexByte(version)}`);
  return {
    ok: true,
    value: {
      canonical: value,
      format: 'tron_base58',
      checksum: BASE58CHECK,
      defaultChain: 'tron',
      possibleChains: ['tron'],
      extras: { tronHex: toHex(payload) },
    },
  };
}

export function validateFormat(patternId: PatternId, value: string): FormatResult {
  switch (patternId) {
    case 'btc_base58':
      return validateBitcoinBase58(value);
    case 'btc_bech32':
      return validateBitcoinSegwit(value);
    case 'evm_hex':
      return validateEvm(value);
    case 'tron_base58':
      return validateTron(value);
  }
}
