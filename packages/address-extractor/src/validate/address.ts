/**
 * Validation of one address string (e.g. a `crypto_address` identifier typed by an analyst).
 */
import { chainFamily, type AddressRef, type ChainId, type ChecksumInfo } from '@olcys/core';
import { PATTERNS } from '../patterns/patterns.ts';
import { validateFormat } from './formats.ts';

export type AddressValidation =
  | {
      ok: true;
      /** Canonical address on the requested chain, or on the format's default chain. */
      address: AddressRef;
      format: string;
      checksum: ChecksumInfo;
      possibleChains: ChainId[];
      /** EVM only: EIP-55 display form. */
      eip55?: string;
    }
  | { ok: false; reason: string };

/** Checks format and checksum of a single Bitcoin, EVM or TRON address; `chain` (optional) must be compatible. */
export function validateAddress(value: string, chain?: ChainId): AddressValidation {
  const candidate = value.trim();
  const def = PATTERNS.find((p) => p.full.test(candidate));
  if (!def) return { ok: false, reason: 'unsupported_format' };
  const result = validateFormat(def.id, candidate);
  if (!result.ok) return { ok: false, reason: result.detail ? `${result.code}: ${result.detail}` : result.code };
  const v = result.value;
  let resolved = v.defaultChain;
  if (chain) {
    const evm = chainFamily(chain) === 'evm';
    const fits = evm ? v.possibleChains.some((c) => chainFamily(c) === 'evm') : v.possibleChains.includes(chain);
    if (!fits) return { ok: false, reason: `unsupported_format: not a ${chain} address` };
    resolved = chain;
  }
  return {
    ok: true,
    address: { chain: resolved, address: v.canonical },
    format: v.format,
    checksum: v.checksum,
    possibleChains: v.possibleChains,
    ...(v.extras.eip55 ? { eip55: v.extras.eip55 } : {}),
  };
}
