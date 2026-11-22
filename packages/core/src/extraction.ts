import type { AddressRef } from './chains.ts';
import type { Id } from './common.ts';

/** The rendering of a capture that a candidate was found in (multi-view extraction). */
export const TEXT_VIEWS = [
  'visible_text',
  'inline_joined',
  'attribute',
  'json_ld',
  'meta',
  'code',
  'qr',
  'ocr',
] as const;
export type TextView = (typeof TEXT_VIEWS)[number];

export const NORMALISATION_TRANSFORMS = [
  'html_decode',
  'url_decode',
  'nfkc',
  'zero_width_removed',
  'bidi_removed',
  'defang_reversed',
  'homoglyph_folded',
  'gap_joined',
  'ocr_repaired',
] as const;
export type NormalisationTransform = (typeof NORMALISATION_TRANSFORMS)[number];

/** Cues from the surrounding text about who the address belongs to. */
export const ROLE_CUES = [
  'first_person_owner',
  'payment_request',
  'donation',
  'scam_report',
  'warning',
  'quote',
  'exchange_deposit',
  'listing',
  'unclear',
] as const;
export type RoleCue = (typeof ROLE_CUES)[number];

/** How the chain of an address was decided (chain-attribution cascade). */
export const CHAIN_ATTRIBUTION_METHODS = [
  'format_unique',
  'uri_chain_id',
  'caip10',
  'eip3770',
  'explorer_domain',
  'keyword',
  'page_chain',
  'unknown',
] as const;
export type ChainAttributionMethod = (typeof CHAIN_ATTRIBUTION_METHODS)[number];

export const CHECKSUM_SCHEMES = [
  'base58check',
  'bech32',
  'bech32m',
  'eip55',
  'cashaddr',
  'monero_keccak',
  'ton_crc16',
  'ripple_base58check',
  'bolt11',
  'none',
] as const;
export type ChecksumScheme = (typeof CHECKSUM_SCHEMES)[number];

export interface ChecksumInfo {
  scheme: ChecksumScheme;
  /** False for formats without a checksum (Solana, all-lower-case EVM, raw TON, Lightning address). */
  present: boolean;
  valid: boolean;
  /** Approximate error-detection strength in bits (base58check 32, EIP-55 ~15, none 0). */
  bits: number;
}

export interface TextSpan {
  /** Offsets into the ORIGINAL artifact text of the view, not the normalised copy. */
  start: number;
  end: number;
}

export interface AddressCandidate {
  id: Id;
  captureId: Id;
  /** Exactly as it appeared (after redaction of adjacent secrets). */
  raw: string;
  address: AddressRef;
  /** e.g. `p2pkh`, `p2sh`, `p2wpkh`, `p2wsh`, `p2tr`, `evm_eip55`, `evm_lower`, `tron_base58`, `xpub`. */
  format: string;
  checksum: ChecksumInfo;
  chainAttribution: { method: ChainAttributionMethod; detail?: string };
  view: TextView;
  span: TextSpan;
  transforms: NormalisationTransform[];
  context: {
    /** ±200 characters around the match, with secrets redacted. */
    snippet: string;
    label?: string;
    heading?: string;
    inCode: boolean;
    roleCues: RoleCue[];
    /** Number of distinct addresses on the page; listing pages (> 50) are penalised. */
    pageAddressDensity: number;
    occurrencesInCapture: number;
    /** DOM anchor of the enclosing authored item (data-post value, item id or preceding a[name]), e.g. `msg65000101`. */
    anchor?: string;
  };
  /** Set for deobfuscated, gap-joined or OCR-repaired matches: needs analyst confirmation. */
  reviewRequired: boolean;
}

/** A private key / seed phrase was seen. The secret itself is never stored, logged or sent anywhere. */
export interface SecretFinding {
  kind: 'wif' | 'xprv' | 'hex64_private_key_context' | 'seed_phrase';
  view: TextView;
  span: TextSpan;
}

export interface ExtractionResult {
  captureId: Id;
  candidates: AddressCandidate[];
  /** Pattern matches that failed validation, kept for transparency and benchmark analysis. */
  rejected: { raw: string; reason: string; view: TextView; span: TextSpan }[];
  secrets: SecretFinding[];
  extractorVersion: string;
}
