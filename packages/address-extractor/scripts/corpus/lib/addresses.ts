/**
 * Positive addresses from random payloads (hash160, witness programs, 20-byte EVM/TRON accounts): no private key
 * exists for any of them. Counts per chain and subtype are part of the corpus contract.
 */
import { KNOWN_CHAINS, type ChainId } from '@olcys/core';
import type { Prng } from '../../../bench/prng.ts';
import type { AddressRecord, AddressSubtype, CorpusFamily } from '../../../bench/types.ts';
import { base58checkEncode, eip55, isAcceptedAddress, segwitEncode, toHex } from './codecs.ts';

/** Positives per subtype (corpus design; chains the extractor does not support are listed in the manifest). */
export const POSITIVE_COUNTS: Readonly<Record<AddressSubtype, number>> = {
  p2pkh: 100,
  p2sh: 100,
  p2wpkh: 100,
  p2wsh: 100,
  p2tr: 100,
  evm_eip55: 200,
  evm_lower: 150,
  evm_upper: 50,
  tron_base58: 300,
};

/** A quarter of every bech32 subtype is shown in upper case (BIP-173 allows either case, never both). */
export const UPPER_CASE_BECH32_SHARE = 4;

export const SUBTYPE_FAMILY: Readonly<Record<AddressSubtype, CorpusFamily>> = {
  p2pkh: 'bitcoin',
  p2sh: 'bitcoin',
  p2wpkh: 'bitcoin',
  p2wsh: 'bitcoin',
  p2tr: 'bitcoin',
  evm_eip55: 'evm',
  evm_lower: 'evm',
  evm_upper: 'evm',
  tron_base58: 'tron',
};

const ID_PREFIX: Readonly<Record<AddressSubtype, string>> = {
  p2pkh: 'btc-p2pkh',
  p2sh: 'btc-p2sh',
  p2wpkh: 'btc-p2wpkh',
  p2wsh: 'btc-p2wsh',
  p2tr: 'btc-p2tr',
  evm_eip55: 'evm-eip55',
  evm_lower: 'evm-lower',
  evm_upper: 'evm-upper',
  tron_base58: 'tron',
};

const EVM_CHAINS: ChainId[] = KNOWN_CHAINS.filter((c) => c.family === 'evm').map((c) => c.id);

/** Every chain the bytes of a subtype are valid on (legacy `1…`/`3…` version bytes are shared). */
export function chainSetOf(subtype: AddressSubtype): ChainId[] {
  switch (subtype) {
    case 'p2pkh':
      return ['bitcoin', 'bitcoincash'];
    case 'p2sh':
      return ['bitcoin', 'litecoin', 'bitcoincash'];
    case 'p2wpkh':
    case 'p2wsh':
    case 'p2tr':
      return ['bitcoin'];
    case 'tron_base58':
      return ['tron'];
    default:
      return [...EVM_CHAINS];
  }
}

export function isBech32Subtype(subtype: AddressSubtype): boolean {
  return subtype === 'p2wpkh' || subtype === 'p2wsh' || subtype === 'p2tr';
}

function encode(subtype: AddressSubtype, prng: Prng): { canonical: string; display: string } {
  switch (subtype) {
    case 'p2pkh': {
      const value = base58checkEncode([0x00], prng.bytes(20));
      return { canonical: value, display: value };
    }
    case 'p2sh': {
      const value = base58checkEncode([0x05], prng.bytes(20));
      return { canonical: value, display: value };
    }
    case 'p2wpkh': {
      const value = segwitEncode('bc', 0, prng.bytes(20));
      return { canonical: value, display: value };
    }
    case 'p2wsh': {
      const value = segwitEncode('bc', 0, prng.bytes(32));
      return { canonical: value, display: value };
    }
    case 'p2tr': {
      const value = segwitEncode('bc', 1, prng.bytes(32));
      return { canonical: value, display: value };
    }
    case 'tron_base58': {
      const value = base58checkEncode([0x41], prng.bytes(20));
      return { canonical: value, display: value };
    }
    case 'evm_eip55':
    case 'evm_lower':
    case 'evm_upper': {
      const canonical = `0x${toHex(prng.bytes(20))}`;
      if (subtype === 'evm_lower') return { canonical, display: canonical };
      if (subtype === 'evm_upper') return { canonical, display: `0x${canonical.slice(2).toUpperCase()}` };
      return { canonical, display: eip55(canonical) };
    }
  }
}

/** Single-case forms only qualify as `evm_lower`/`evm_upper` when they contain a letter; EIP-55 needs both cases. */
function fitsSubtype(subtype: AddressSubtype, display: string): boolean {
  const hex = display.slice(2);
  if (subtype === 'evm_eip55') return /[a-f]/.test(hex) && /[A-F]/.test(hex);
  if (subtype === 'evm_lower' || subtype === 'evm_upper') return /[a-fA-F]/.test(hex);
  return true;
}

export function generateAddresses(prng: Prng): AddressRecord[] {
  const out: AddressRecord[] = [];
  const seen = new Set<string>();
  for (const [subtype, count] of Object.entries(POSITIVE_COUNTS) as [AddressSubtype, number][]) {
    const stream = prng.fork(`addresses/${subtype}`);
    const upper = new Set(
      isBech32Subtype(subtype)
        ? stream
            .shuffle(Array.from({ length: count }, (_, i) => i))
            .slice(0, Math.floor(count / UPPER_CASE_BECH32_SHARE))
        : [],
    );
    for (let i = 0; i < count; i += 1) {
      let encoded = encode(subtype, stream);
      while (!fitsSubtype(subtype, encoded.display) || seen.has(encoded.canonical)) encoded = encode(subtype, stream);
      seen.add(encoded.canonical);
      const display = upper.has(i) ? encoded.display.toUpperCase() : encoded.display;
      if (!isAcceptedAddress(display)) throw new Error(`generator bug: invalid ${subtype} address`);
      out.push({
        id: `${ID_PREFIX[subtype]}-${String(i + 1).padStart(4, '0')}`,
        chain: SUBTYPE_FAMILY[subtype],
        subtype,
        canonical: encoded.canonical,
        display,
        hasChecksum: subtype !== 'evm_lower' && subtype !== 'evm_upper',
        network: 'mainnet',
      });
    }
  }
  return out;
}
