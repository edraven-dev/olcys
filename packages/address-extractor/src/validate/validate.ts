/**
 * "Checksums, not regexes, decide what counts as an address": validation gates, deny list and overlap resolution.
 */
import type { ChecksumInfo, ChecksumScheme, NormalisationTransform } from '@olcys/core';
import { EXTRACTION_DENY_KINDS, type DenyList } from '../deny-list.ts';
import {
  PATTERN_IDS,
  type RawCandidate,
  type RejectCode,
  type RejectedMatch,
  type ValidatedCandidate,
} from '../pipeline-types.ts';
import { validateFormat } from './formats.ts';

/** Error-detection strength per scheme; EIP-55 is per address (one bit per hex letter). */
export const CHECKSUM_BITS: Record<ChecksumScheme, number> = {
  base58check: 32,
  bech32: 30,
  bech32m: 30,
  eip55: 0,
  cashaddr: 40,
  monero_keccak: 32,
  ton_crc16: 16,
  ripple_base58check: 32,
  bolt11: 30,
  none: 0,
};

/** Transforms that change what the page showed: matches produced by them need analyst review. */
export const DEOBFUSCATION_TRANSFORMS: readonly NormalisationTransform[] = [
  'zero_width_removed',
  'bidi_removed',
  'defang_reversed',
  'homoglyph_folded',
  'gap_joined',
  'ocr_repaired',
];

const STRONG_SCHEMES = new Set<ChecksumScheme>([
  'base58check',
  'bech32',
  'bech32m',
  'cashaddr',
  'monero_keccak',
  'ton_crc16',
]);

function isStrong(checksum: ChecksumInfo): boolean {
  return STRONG_SCHEMES.has(checksum.scheme) || (checksum.scheme === 'eip55' && checksum.present);
}

export interface ValidateOptions {
  denyList?: DenyList;
}

export type ValidationResult = { ok: true; value: ValidatedCandidate } | { ok: false; rejected: RejectedMatch };

function rejection(c: RawCandidate, code: RejectCode, detail?: string): ValidationResult {
  return {
    ok: false,
    rejected: {
      raw: c.raw,
      reason: detail ? `${code}: ${detail}` : code,
      view: c.view,
      span: c.span,
      patternId: c.patternId,
    },
  };
}

/** Decodes and verifies one raw candidate; everything that fails gets a stable reason code. */
export function validateCandidate(c: RawCandidate, options: ValidateOptions = {}): ValidationResult {
  const result = validateFormat(c.patternId, c.value);
  const folded = c.transforms.includes('homoglyph_folded');
  if (!result.ok) return folded ? rejection(c, 'homoglyph_detected') : rejection(c, result.code, result.detail);
  const value = result.value;
  if (folded) return rejection(c, 'homoglyph_detected', `folds to ${value.canonical}`);
  if (c.transforms.includes('gap_joined') && !isStrong(value.checksum)) return rejection(c, 'gap_joined_weak_checksum');
  const denied = options.denyList?.find(value.canonical, value.possibleChains);
  if (denied && EXTRACTION_DENY_KINDS.includes(denied.kind)) return rejection(c, 'documentation_example', denied.name);
  return {
    ok: true,
    value: {
      ...c,
      ...value,
      reviewRequired: c.transforms.some((t) => DEOBFUSCATION_TRANSFORMS.includes(t)),
    },
  };
}

function patternRank(c: ValidatedCandidate): number {
  return PATTERN_IDS.indexOf(c.patternId);
}

/** Better candidate first: stronger checksum, then longer, then pattern order. */
function compare(a: ValidatedCandidate, b: ValidatedCandidate): number {
  return (
    b.checksum.bits - a.checksum.bits ||
    b.nEnd - b.nStart - (a.nEnd - a.nStart) ||
    patternRank(a) - patternRank(b) ||
    a.nStart - b.nStart
  );
}

/**
 * Overlapping valid candidates (same view): keep the strongest checksum, then the longest, then pattern order.
 * Rejections overlapping a kept candidate are dropped (a failed alternative reading is not a rejection).
 */
export function resolveOverlaps(
  valid: ValidatedCandidate[],
  rejected: RejectedMatch[],
): { valid: ValidatedCandidate[]; rejected: RejectedMatch[] } {
  const kept: ValidatedCandidate[] = [];
  for (const c of valid.toSorted(compare)) {
    const clash = kept.some((k) => k.view === c.view && c.nStart < k.nEnd && c.nEnd > k.nStart);
    if (!clash) kept.push(c);
  }
  kept.sort((a, b) => a.nStart - b.nStart);
  const survivors = rejected.filter(
    (r) => !kept.some((k) => k.view === r.view && r.span.start < k.span.end && r.span.end > k.span.start),
  );
  return { valid: kept, rejected: survivors };
}
