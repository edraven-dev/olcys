/**
 * Candidate patterns: recall first, hard-bounded so they never match inside a longer token. Checksums decide later.
 */
import type { ChainFamily } from '@olcys/core';
import type { PatternId } from '../pipeline-types.ts';

export const PATTERNS_VERSION = 'patterns.v2';

/** Bitcoin base58 alphabet (no 0 O I l). */
export const B58 = '[1-9A-HJ-NP-Za-km-z]';
/** bech32 data charset (no 1 b i o); bech32 patterns use the `i` flag, case rules are checked by the validator. */
export const BC = '[02-9ac-hj-np-z]';
export const LEFT = '(?<![A-Za-z0-9])';
export const RIGHT = '(?![A-Za-z0-9])';

export interface PatternDef {
  id: PatternId;
  family: ChainFamily;
  /** Global, bounded matcher for scanning. */
  scan: RegExp;
  /** Anchored matcher for gap-joined strings. */
  full: RegExp;
}

function pattern(id: PatternId, family: ChainFamily, body: string, flags = ''): PatternDef {
  return {
    id,
    family,
    scan: new RegExp(`${LEFT}${body}${RIGHT}`, `g${flags}`),
    full: new RegExp(`^(?:${body})$`, flags),
  };
}

/** In pattern order (used as the last overlap tie-break). */
export const PATTERNS: readonly PatternDef[] = [
  pattern('btc_bech32', 'bitcoin', `bc1${BC}{6,87}`, 'i'),
  pattern('btc_base58', 'bitcoin', `[13]${B58}{25,34}`),
  pattern('evm_hex', 'evm', '0x[0-9a-fA-F]{40}'),
  pattern('tron_base58', 'tron', `T${B58}{33}`),
];

/** First chunks a gap-joined address may start with. */
export const GAP_ANCHORS = /^(?:[bB][cC]1|0x|T|1|3)/;
