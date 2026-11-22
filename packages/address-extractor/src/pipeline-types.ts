/**
 * Stage contracts shared by the extraction stages (views → normalisation → patterns → validation → attribution →
 * context). Internal to this package except for the types re-exported from `index.ts`.
 */
import type {
  ArtifactKind,
  ChainAttributionMethod,
  ChainFamily,
  ChainId,
  ChecksumInfo,
  Id,
  NormalisationTransform,
  SecretFinding,
  TextSpan,
  TextView,
} from '@olcys/core';

// --- input and views ---------------------------------------------------------------------------------------------

/** Stored bytes of one capture; `html`, `text` and `json` artifacts are read, others are ignored. */
export interface CaptureContent {
  captureId: Id;
  url: string;
  finalUrl: string;
  artifacts: { kind: ArtifactKind; mediaType: string; bytes: Uint8Array }[];
}

export interface ViewSegment {
  /** Range in `ViewText.text`. */
  start: number;
  end: number;
  /** Element name, or `#json`, `#meta`, `#text`. */
  tag: string;
  /** CSS-like element path, e.g. `body>main>div.post:nth-of-type(2)>span`. */
  path: string;
  /** Attribute view: the attribute name (`href`, `data-address`, …). */
  attribute?: string;
  /** JSON view: RFC 6901 pointer of the string value, e.g. `/recipient/address`. */
  jsonPointer?: string;
  inCode: boolean;
  quoted: boolean;
  hidden: boolean;
  blockIndex: number;
  /** Window boundary for later stages (post, message, table row, list item, JSON object, …). */
  container: number;
  /** Nearest data-post / item id / preceding a[name], e.g. `msg65000101`. */
  anchor?: string;
  /** `href` of the enclosing `<a>`, if any. */
  href?: string;
  /** UTF-16 range in the decoded artifact string. */
  source?: { start: number; end: number };
}

export interface ViewBlock {
  index: number;
  start: number;
  end: number;
  tag: string;
  container: number;
  headingPath: string[];
  /** Table first cell, column header, preceding `dt`, `label[for]` or meta name. */
  structuralLabel?: string;
}

export interface ViewText {
  captureId: Id;
  view: TextView;
  text: string;
  segments: ViewSegment[];
  blocks: ViewBlock[];
  lang?: string;
  warnings: string[];
  /** Index of the artifact in `CaptureContent.artifacts` the view was built from (source ranges refer to it). */
  artifactIndex?: number;
  /** Per character of `text`: UTF-16 offset in the decoded artifact, `-1` for separators inserted by the view. */
  sourceMap?: Int32Array;
}

/** A normalisation step applied to `[start, end)` of the normalised text; `start === end` for removals. */
export interface TransformRange {
  transform: NormalisationTransform;
  start: number;
  end: number;
}

/** Normalised copy of a view used for matching; every UTF-16 unit maps back to `[origStart, origEnd)` of the view. */
export interface NormalisedText {
  view: TextView;
  text: string;
  origStart: Uint32Array;
  origEnd: Uint32Array;
  transforms: TransformRange[];
  /** Per normalised unit: bit set of transforms that produced it (bit i = `NORMALISATION_TRANSFORMS[i]`). */
  unitTransforms?: Uint16Array;
  /** Removed characters: position in the normalised text (removed before that unit) and the transform. */
  removals?: { pos: number; transform: NormalisationTransform }[];
}

// --- patterns and secrets ----------------------------------------------------------------------------------------

/** Implemented candidate patterns (Bitcoin, EVM and TRON). */
export const PATTERN_IDS = ['btc_base58', 'btc_bech32', 'evm_hex', 'tron_base58'] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export interface RawCandidate {
  patternId: PatternId;
  family: ChainFamily;
  /** Normalised match; separators removed for gap-joined matches. */
  value: string;
  view: TextView;
  /** Range in the normalised text. */
  nStart: number;
  nEnd: number;
  /** Range in the original view text and `view.text.slice(span.start, span.end)`. */
  span: TextSpan;
  raw: string;
  transforms: NormalisationTransform[];
  joinedParts?: number;
}

/** A 64/128-hex string without private-key context: reported as `tx_hash_like`. */
export interface HashLike {
  value: string;
  view: TextView;
  span: TextSpan;
}

/** A secret with its range in the normalised text (kept in memory only). */
export interface SecretSpan {
  finding: SecretFinding;
  nStart: number;
  nEnd: number;
}

export interface ScanResult {
  candidates: RawCandidate[];
  secrets: SecretFinding[];
  hashes: HashLike[];
}

// --- validation --------------------------------------------------------------------------------------------------

/** Stable reasons for rejected matches (`reason` is `code` or `code: detail`). */
export const REJECT_CODES = [
  'checksum_invalid',
  'tx_hash_like',
  'homoglyph_detected',
  'length_invalid',
  'prefix_unknown',
  'bech32_variant_mismatch',
  'mixed_case',
  'testnet',
  'witness_program_invalid',
  'unsupported_format',
  'gap_joined_weak_checksum',
  'uri_token_contract',
  'uri_reference_key',
  'documentation_example',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export interface RejectedMatch {
  raw: string;
  /** `code` or `code: detail`. */
  reason: string;
  view: TextView;
  span: TextSpan;
  patternId?: PatternId;
}

export interface ValidatedCandidate extends RawCandidate {
  canonical: string;
  format: string;
  checksum: ChecksumInfo;
  defaultChain: ChainId;
  /** e.g. `['bitcoin', 'litecoin', 'bitcoincash']` for a `3…` address. */
  possibleChains: ChainId[];
  reviewRequired: boolean;
  extras: { eip55?: string; tronHex?: string };
}

// --- chain attribution -------------------------------------------------------------------------------------------

export interface PaymentContext {
  kind: 'uri' | 'explorer' | 'caip10' | 'eip3770';
  scheme?: string;
  host?: string;
  chainId?: ChainId;
  /**
   * `recipient` = payee of a payment; `token_contract` = contract called by the URI (EIP-681 with a function);
   * `argument` = address passed to a contract function other than a token transfer (never a payee).
   */
  role: 'recipient' | 'token_contract' | 'argument' | 'reference' | 'account';
  /** EIP-681 function name (`transfer`, `approve`, …) when the URI calls a contract. */
  function?: string;
  /** amount, label, message, memo, … (percent-decoded). */
  params: Record<string, string>;
  /** Whole URI / link in the normalised view. */
  range: { nStart: number; nEnd: number };
  /** The address this context describes, in the normalised view. */
  target?: { nStart: number; nEnd: number };
}

export interface AttributedCandidate extends ValidatedCandidate {
  chain: ChainId;
  chainAttribution: { method: ChainAttributionMethod; detail?: string };
  payment?: PaymentContext;
}
