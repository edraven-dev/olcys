/**
 * Hard negatives (EIP-681 token contracts are created on demand by the URI renderer): corruptions of the positives (checksums must reject them), wrong-variant and testnet encodings,
 * homoglyph decoys, look-alike identifiers (hashes, CIDs, UUIDs, token-shaped strings) and public documentation
 * vectors. Token-shaped strings carry no vendor prefix, so repository secret scanners stay quiet.
 */
import { base32nopad, base58, base64urlnopad } from '@scure/base';
import type { Prng } from '../../../bench/prng.ts';
import type {
  AddressRecord,
  AddressSubtype,
  NegativeExpectation,
  NegativeKind,
  NegativeRecord,
} from '../../../bench/types.ts';
import type { RejectCode } from '../../../src/pipeline-types.ts';
import { isBech32Subtype } from './addresses.ts';
import {
  BASE58_ALPHABET,
  BECH32_CHARSET,
  HEX,
  base58checkEncode,
  concat,
  isAcceptedAddress,
  segwitEncode,
  segwitEncodeWith,
  toHex,
} from './codecs.ts';

interface PlanEntry {
  kind: NegativeKind;
  count: number;
  expected: NegativeExpectation;
  rejectCode?: RejectCode;
}

export const NEGATIVE_PLAN: readonly PlanEntry[] = [
  { kind: 'corrupt1', count: 200, expected: 'reject' },
  { kind: 'corrupt2', count: 100, expected: 'reject' },
  { kind: 'transpose', count: 100, expected: 'reject' },
  { kind: 'truncate', count: 80, expected: 'reject' },
  { kind: 'eip55_case_flip', count: 60, expected: 'reject', rejectCode: 'checksum_invalid' },
  { kind: 'bech32_mixed_case', count: 50, expected: 'reject', rejectCode: 'mixed_case' },
  { kind: 'v1_in_bech32', count: 40, expected: 'reject', rejectCode: 'bech32_variant_mismatch' },
  { kind: 'v0_in_bech32m', count: 40, expected: 'reject', rejectCode: 'bech32_variant_mismatch' },
  { kind: 'testnet_bech32', count: 30, expected: 'testnet' },
  { kind: 'testnet_base58', count: 30, expected: 'testnet' },
  { kind: 'homoglyph', count: 60, expected: 'reject', rejectCode: 'homoglyph_detected' },
  { kind: 'tx_hash', count: 80, expected: 'reject', rejectCode: 'tx_hash_like' },
  { kind: 'txid_hex64', count: 30, expected: 'reject', rejectCode: 'tx_hash_like' },
  { kind: 'md5', count: 30, expected: 'reject' },
  { kind: 'sha1', count: 30, expected: 'reject' },
  { kind: 'sha256', count: 30, expected: 'reject', rejectCode: 'tx_hash_like' },
  { kind: 'git_sha', count: 30, expected: 'reject' },
  { kind: 'uuid', count: 30, expected: 'reject' },
  { kind: 'ipfs_cid_v0', count: 25, expected: 'reject' },
  { kind: 'ipfs_cid_v1', count: 25, expected: 'reject' },
  { kind: 'jwt_like', count: 25, expected: 'reject' },
  { kind: 'token_generic', count: 25, expected: 'reject' },
  { kind: 'base58_random', count: 50, expected: 'reject' },
  { kind: 'base64url_48', count: 25, expected: 'reject' },
  { kind: 'email', count: 25, expected: 'reject' },
  { kind: 'eth_filename', count: 20, expected: 'reject' },
  { kind: 'example', count: 51, expected: 'example', rejectCode: 'documentation_example' },
  { kind: 'evm_single_case_corruption', count: 40, expected: 'unverifiable' },
  { kind: 'split_unchecksummed', count: 20, expected: 'unverifiable', rejectCode: 'gap_joined_weak_checksum' },
  { kind: 'hex40_prefixed', count: 20, expected: 'unverifiable' },
];

/**
 * Public specification vectors and documentation examples (BIP-173, BIP-350, EIP-55, Bitcoin Wiki). They are the
 * extraction-time entries of `config/rules/deny-list.v1.yaml`; listed here so the corpus does not change when the
 * deny list grows.
 */
export const DOCUMENTATION_VECTORS: readonly string[] = [
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
  'bc1sw50qgdz25j',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  '0xde709f2102306220921060314715629080e2fb77',
  '0x27b1fdb04752bbc536007a920d24acb045561c26',
  '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
];

/** Confusables for homoglyph decoys: Cyrillic look-alikes of Latin letters (escaped so review cannot misread them). */
const HOMOGLYPH_OF: Readonly<Record<string, string>> = {
  a: '\u0430',
  c: '\u0441',
  e: '\u0435',
  o: '\u043E',
  p: '\u0440',
  x: '\u0445',
  y: '\u0443',
  A: '\u0410',
  B: '\u0412',
  C: '\u0421',
  E: '\u0415',
  H: '\u041D',
  K: '\u041A',
  M: '\u041C',
  P: '\u0420',
  T: '\u0422',
  X: '\u0425',
};

const SYNTHETIC_NAMES = ['kacper', 'ola', 'marek', 'zosia', 'tomek', 'ewa', 'piotr', 'anka', 'jan', 'iga'];
const FILE_WORDS = ['portfel', 'kopia', 'notatki', 'faktura', 'zrzut', 'backup', 'umowa', 'raport'];

/** Index of the first character after the fixed prefix (`1`/`3`/`T`, `bc1` + version, `0x`). */
function prefixLength(subtype: AddressSubtype): number {
  if (isBech32Subtype(subtype)) return 4;
  if (subtype.startsWith('evm_')) return 2;
  return 1;
}

function alphabetFor(subtype: AddressSubtype, display: string): string {
  if (isBech32Subtype(subtype))
    return display === display.toUpperCase() ? BECH32_CHARSET.toUpperCase() : BECH32_CHARSET;
  if (subtype.startsWith('evm_')) return HEX + HEX.slice(10).toUpperCase();
  return BASE58_ALPHABET;
}

function replaceAt(value: string, index: number, char: string): string {
  return value.slice(0, index) + char + value.slice(index + 1);
}

/** Different character from the same alphabet; EVM letters keep their case so the result stays mixed-case. */
function substitute(prng: Prng, rec: AddressRecord, value: string, index: number): string {
  const current = value[index] ?? '';
  const alphabet = alphabetFor(rec.subtype, rec.display);
  for (;;) {
    let next = prng.pick([...alphabet]);
    if (rec.subtype.startsWith('evm_') && /[a-fA-F]/.test(current) && /[a-fA-F]/.test(next)) {
      next = current === current.toUpperCase() ? next.toUpperCase() : next.toLowerCase();
    }
    if (rec.subtype === 'evm_lower') next = next.toLowerCase();
    if (rec.subtype === 'evm_upper') next = next.toUpperCase();
    if (next !== current) return replaceAt(value, index, next);
  }
}

function corrupt(prng: Prng, rec: AddressRecord, kind: NegativeKind): string | undefined {
  const start = prefixLength(rec.subtype);
  const value = rec.display;
  const position = (): number => prng.range(start, value.length - 1);
  switch (kind) {
    case 'corrupt1':
    case 'evm_single_case_corruption':
      return substitute(prng, rec, value, position());
    case 'corrupt2': {
      const first = position();
      let second = position();
      while (second === first) second = position();
      return substitute(prng, rec, substitute(prng, rec, value, first), second);
    }
    case 'transpose': {
      const at = prng.range(start, value.length - 2);
      const a = value[at] ?? '';
      const b = value[at + 1] ?? '';
      if (a.toLowerCase() === b.toLowerCase()) return undefined;
      return value.slice(0, at) + b + a + value.slice(at + 2);
    }
    case 'truncate':
      return value.slice(0, value.length - prng.range(1, 3));
    case 'eip55_case_flip': {
      let out = value;
      const letters = [...value].map((c, i) => (i >= 2 && /[a-fA-F]/.test(c) ? i : -1)).filter((i) => i >= 0);
      for (const at of prng.shuffle(letters).slice(0, prng.range(1, 2))) {
        const c = out[at] ?? '';
        out = replaceAt(out, at, c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
      }
      const hex = out.slice(2);
      return hex !== hex.toLowerCase() && hex !== hex.toUpperCase() ? out : undefined;
    }
    case 'bech32_mixed_case': {
      const lower = value.toLowerCase();
      const letters = [...lower].map((c, i) => (/[a-z]/.test(c) ? i : -1)).filter((i) => i >= 0);
      const picked = new Set(prng.shuffle(letters).slice(0, prng.range(1, Math.max(1, letters.length - 1))));
      return [...lower].map((c, i) => (picked.has(i) ? c.toUpperCase() : c)).join('');
    }
    case 'homoglyph': {
      const candidates = [...value].map((c, i) => (i >= start && HOMOGLYPH_OF[c] ? i : -1)).filter((i) => i >= 0);
      if (candidates.length === 0) return undefined;
      const at = prng.pick(candidates);
      return replaceAt(value, at, HOMOGLYPH_OF[value[at] ?? ''] ?? '');
    }
    default:
      return undefined;
  }
}

function randomFrom(prng: Prng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[prng.int(alphabet.length)] ?? '';
  return out;
}

function standalone(prng: Prng, kind: NegativeKind): string {
  switch (kind) {
    case 'v1_in_bech32':
      return segwitEncodeWith('bech32', 1, prng.bytes(32));
    case 'v0_in_bech32m':
      return segwitEncodeWith('bech32m', 0, prng.bytes(prng.chance(0.5) ? 20 : 32));
    case 'testnet_bech32':
      return prng.chance(0.5) ? segwitEncode('tb', 0, prng.bytes(20)) : segwitEncode('tb', 1, prng.bytes(32));
    case 'testnet_base58':
      return base58checkEncode([prng.chance(0.5) ? 0x6f : 0xc4], prng.bytes(20));
    case 'tx_hash':
      return `0x${toHex(prng.bytes(32))}`;
    case 'txid_hex64':
    case 'sha256':
      return toHex(prng.bytes(32));
    case 'md5':
      return toHex(prng.bytes(16));
    case 'sha1':
    case 'git_sha':
      return toHex(prng.bytes(20));
    case 'uuid': {
      const h = toHex(prng.bytes(16));
      const variant = '89ab'[prng.int(4)] ?? '8';
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    case 'ipfs_cid_v0':
      return base58.encode(concat([0x12, 0x20], prng.bytes(32)));
    case 'ipfs_cid_v1':
      return `b${base32nopad.encode(concat([0x01, 0x70, 0x12, 0x20], prng.bytes(32))).toLowerCase()}`;
    case 'jwt_like': {
      for (;;) {
        const parts = [prng.range(15, 27), prng.range(30, 60), 32].map((n) => base64urlnopad.encode(prng.bytes(n)));
        if (!parts[0]?.startsWith('ey')) return parts.join('.');
      }
    }
    case 'token_generic':
      return `token_${base64urlnopad.encode(prng.bytes(24))}`;
    case 'base58_random':
      return randomFrom(prng, BASE58_ALPHABET, prng.range(32, 44));
    case 'base64url_48':
      return base64urlnopad.encode(prng.bytes(36));
    case 'email':
      return `fikcyjny.${prng.pick(SYNTHETIC_NAMES)}.${prng.range(10, 99)}@example.org`;
    case 'eth_filename': {
      const word = prng.pick(FILE_WORDS);
      return prng.pick([
        `${word}-${prng.pick(SYNTHETIC_NAMES)}.eth`,
        `${word}.eth.txt`,
        `${word}_${prng.range(1, 99)}.eth`,
      ]);
    }
    case 'split_unchecksummed':
    case 'hex40_prefixed':
      return `0x${toHex(prng.bytes(20))}`;
    default:
      throw new Error(`no standalone generator for ${kind}`);
  }
}

const DERIVED: ReadonlySet<NegativeKind> = new Set([
  'corrupt1',
  'corrupt2',
  'transpose',
  'truncate',
  'eip55_case_flip',
  'bech32_mixed_case',
  'homoglyph',
  'evm_single_case_corruption',
]);

function sourcesFor(kind: NegativeKind, positives: readonly AddressRecord[]): AddressRecord[] {
  switch (kind) {
    case 'eip55_case_flip':
      return positives.filter((p) => p.subtype === 'evm_eip55');
    case 'bech32_mixed_case':
      return positives.filter((p) => isBech32Subtype(p.subtype));
    case 'evm_single_case_corruption':
      return positives.filter((p) => p.subtype === 'evm_lower' || p.subtype === 'evm_upper');
    case 'homoglyph':
      return [...positives];
    default:
      return positives.filter((p) => p.hasChecksum);
  }
}

export function generateNegatives(prng: Prng, positives: readonly AddressRecord[]): NegativeRecord[] {
  const out: NegativeRecord[] = [];
  const seen = new Set(positives.map((p) => p.display));
  for (const entry of NEGATIVE_PLAN) {
    const stream = prng.fork(`negatives/${entry.kind}`);
    const sources = sourcesFor(entry.kind, positives);
    for (let i = 0; i < entry.count; i += 1) {
      let value: string | undefined;
      let derivedFrom: string | undefined;
      while (value === undefined) {
        if (entry.kind === 'example') {
          value = DOCUMENTATION_VECTORS[i % DOCUMENTATION_VECTORS.length] ?? '';
          break;
        }
        if (DERIVED.has(entry.kind)) {
          const rec = stream.pick(sources);
          const candidate = corrupt(stream, rec, entry.kind);
          const unverifiable = entry.kind === 'evm_single_case_corruption';
          if (!candidate || candidate === rec.display || seen.has(candidate)) continue;
          if (!unverifiable && isAcceptedAddress(candidate)) continue;
          value = candidate;
          derivedFrom = rec.id;
        } else {
          const candidate = standalone(stream, entry.kind);
          if (seen.has(candidate)) continue;
          if (entry.expected !== 'unverifiable' && isAcceptedAddress(candidate)) continue;
          value = candidate;
        }
      }
      if (entry.kind !== 'example') seen.add(value);
      out.push({
        id: `neg-${entry.kind.replaceAll('_', '-')}-${String(i + 1).padStart(4, '0')}`,
        kind: entry.kind,
        value,
        ...(derivedFrom ? { derivedFrom } : {}),
        expected: entry.expected,
        ...(entry.rejectCode ? { rejectCode: entry.rejectCode } : {}),
      });
    }
  }
  for (const vector of DOCUMENTATION_VECTORS) {
    if (!isAcceptedAddress(vector)) throw new Error(`documentation vector does not validate: ${vector}`);
  }
  return out;
}
