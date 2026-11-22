/**
 * Contracts of the synthetic extraction corpus (`fixtures/corpus/`) and of the precision/recall benchmark.
 * Shared by the corpus generator (`scripts/corpus/`) and the benchmark runner (`bench/run.ts`).
 */
import type { ChainId, IsoDateTime, RoleCue, SecretFinding } from '@olcys/core';
import type { RejectCode } from '../src/pipeline-types.ts';

export const CORPUS_SCHEMA = 'olcys.extraction-corpus.v1';

/** Chain families the extractor supports today; only these are generated and measured. */
export const CORPUS_FAMILIES = ['bitcoin', 'evm', 'tron'] as const;
export type CorpusFamily = (typeof CORPUS_FAMILIES)[number];

/** Address subtypes; the names equal the extractor's `format` values. */
export const ADDRESS_SUBTYPES = [
  'p2pkh',
  'p2sh',
  'p2wpkh',
  'p2wsh',
  'p2tr',
  'evm_eip55',
  'evm_lower',
  'evm_upper',
  'tron_base58',
] as const;
export type AddressSubtype = (typeof ADDRESS_SUBTYPES)[number];

/** Subtypes whose encoding carries a checksum (EIP-55 only in mixed case). */
export const CHECKSUMMED_SUBTYPES: readonly AddressSubtype[] = [
  'p2pkh',
  'p2sh',
  'p2wpkh',
  'p2wsh',
  'p2tr',
  'evm_eip55',
  'tron_base58',
];

/** One positive address of `addresses/<chain>.jsonl` (random payload: nobody holds a key for it). */
export interface AddressRecord {
  id: string;
  chain: CorpusFamily;
  subtype: AddressSubtype;
  /** Canonical form (EVM and bech32 lower-case, base58 as encoded). */
  canonical: string;
  /** Form shown in the documents (EIP-55, upper-case bech32, …). */
  display: string;
  hasChecksum: boolean;
  network: 'mainnet';
}

export const NEGATIVE_EXPECTATIONS = ['reject', 'unverifiable', 'testnet', 'example'] as const;
export type NegativeExpectation = (typeof NEGATIVE_EXPECTATIONS)[number];

export const NEGATIVE_KINDS = [
  'corrupt1',
  'corrupt2',
  'transpose',
  'truncate',
  'eip55_case_flip',
  'bech32_mixed_case',
  'v1_in_bech32',
  'v0_in_bech32m',
  'testnet_bech32',
  'testnet_base58',
  'homoglyph',
  'uri_token_contract',
  'tx_hash',
  'txid_hex64',
  'md5',
  'sha1',
  'sha256',
  'git_sha',
  'uuid',
  'ipfs_cid_v0',
  'ipfs_cid_v1',
  'jwt_like',
  'token_generic',
  'base58_random',
  'base64url_48',
  'email',
  'eth_filename',
  'example',
  'evm_single_case_corruption',
  'split_unchecksummed',
  'hex40_prefixed',
] as const;
export type NegativeKind = (typeof NEGATIVE_KINDS)[number];

/** One row of `negatives/hard-negatives.jsonl`. */
export interface NegativeRecord {
  id: string;
  kind: NegativeKind;
  value: string;
  /** Id of the positive address the value was derived from (corruptions, homoglyphs). */
  derivedFrom?: string;
  expected: NegativeExpectation;
  /** Rejection reason the extractor must give when the value is matched by a pattern. */
  rejectCode?: RejectCode;
}

export const CHANNELS = ['text', 'attr', 'uri', 'explorer', 'json_ld', 'qr', 'ocr'] as const;
export type Channel = (typeof CHANNELS)[number];

export const OBFUSCATIONS = [
  'spaces4',
  'newline',
  'zero_width',
  'bidi',
  'homoglyph',
  'fullwidth',
  'span_split',
  'br_split',
  'td_split',
  'defang',
  'entities',
  'percent',
  'attr_only',
  'json_ld_only',
  'qr',
  'ocr',
] as const;
export type Obfuscation = (typeof OBFUSCATIONS)[number];

export type SecretKind = SecretFinding['kind'];
export const SECRET_KINDS: readonly SecretKind[] = ['wif', 'xprv', 'seed_phrase', 'hex64_private_key_context'];

/** What the extractor is expected to do with a labelled occurrence. */
export type TruthExpectation = 'positive' | NegativeExpectation | 'secret';

/** One labelled occurrence in a rendered document (`ground-truth.jsonl`). */
export interface TruthRow {
  docId: string;
  /** 0-based, in document order. */
  occurrence: number;
  channel: Channel;
  /** UTF-16 range in the document as stored on disk (secret placeholders unfilled). */
  source?: { start: number; end: number };
  canonical?: string;
  /** Every chain the bytes are valid on (the chosen chain is scored separately). */
  chainSet: ChainId[];
  subtype?: string;
  isValid: boolean;
  hasChecksum: boolean;
  obfuscation: Obfuscation[];
  role: RoleCue | 'none';
  isSecret: boolean;
  secretKind?: SecretKind;
  negativeKind?: NegativeKind;
  expected: TruthExpectation;
  /** Expected chain attribution (positives), from the explicit markers and keywords of the template. */
  chain?: ChainId;
  /** Address or negative id. */
  ref?: string;
  /** Required rejection reason (hard negatives that a pattern matches). */
  rejectCode?: RejectCode;
  /** Number of the secret placeholder `{{SECRET:<kind>:<n>}}`. */
  secretIndex?: number;
}

export interface CorpusManifest {
  schema: typeof CORPUS_SCHEMA;
  corpusVersion: string;
  generator: { name: string; version: string };
  seed: string;
  counts: {
    positives: Record<string, number>;
    positivesBySubtype: Record<string, number>;
    upperCaseBech32: number;
    negatives: Record<string, number>;
    negativesByExpectation: Record<string, number>;
    templates: Record<string, number>;
    documents: Record<string, number>;
    truthRows: number;
    secrets: Record<string, number>;
    obfuscations: Record<string, number>;
    channels: Record<string, number>;
  };
  /** Chain families of the corpus design that the extractor does not support yet (not generated, not measured). */
  unsupported: { family: string; formats: string; planned: number }[];
  /** Every corpus file except this manifest, with its SHA-256. */
  files: Record<string, string>;
}

export interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  /** `NaN` (JSON `null`) when undefined (no predictions or no positives). */
  precision: number;
  recall: number;
  f1: number;
  precisionCi95: [number, number];
  recallCi95: [number, number];
}

export interface Accuracy {
  total: number;
  correct: number;
  accuracy: number;
}

export interface BaselineResult {
  version: string;
  /** Chains the baseline detects at all. */
  chains: string[];
  overall: Metrics;
  byChain: Record<string, Metrics>;
}

export interface GateResult {
  id: string;
  /** Polish description (report). */
  label: string;
  metric: 'precision' | 'recall' | 'value';
  value: number;
  threshold: number;
  comparison: '>=' | '==' | '<';
  passed: boolean;
  detail?: string;
}

export interface BenchReport {
  corpusVersion: string;
  extractorVersion: string;
  generatedAt: IsoDateTime;
  overall: Metrics;
  byChain: Record<string, Metrics>;
  bySubtype: Record<string, Metrics>;
  byObfuscation: Record<string, Metrics | 'not_run'>;
  byChannel: Record<string, Metrics | 'not_run'>;
  chainAttributionAccuracy: number;
  roleMacroF1: number;
  secrets: {
    total: number;
    redacted: number;
    recall: number;
    leaks: number;
    byKind: Record<string, { total: number; redacted: number }>;
  };
  throughput: { docsPerSecond: number; mbPerSecond: number };
  baselines: Record<'spiderfoot' | 'iocsearcher', BaselineResult | 'not_run'>;
  // --- details beyond the summary contract ---
  corpus: {
    seed: string;
    documents: number;
    bytes: number;
    truthRows: number;
    positives: number;
    negatives: number;
    unverifiable: number;
    templates: Record<string, number>;
  };
  gates: GateResult[];
  /** Metric groups behind the gates: clean checksummed formats per chain, obfuscated, corroborated unchecksummed. */
  gateMetrics: { cleanMetrics: Record<string, Metrics>; obfuscated: Metrics; corroborated: Metrics };
  attribution: Record<string, Accuracy>;
  roles: {
    macroF1: number;
    byRole: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }>;
  };
  /** Per hard-negative kind: how often each tool accepted it, and how often we rejected it with the expected code. */
  negatives: Record<
    string,
    {
      expected: string;
      total: number;
      accepted: number;
      rejectedAsExpected: number;
      spiderfootAccepted: number;
      rejectCode?: string;
    }
  >;
  hardNegativeDocuments: { documents: number; ours: Metrics; spiderfoot: Metrics };
  comparisonChains: { chains: string[]; ours: Metrics; spiderfoot: Metrics };
  unsupported: { family: string; formats: string; planned: number }[];
  failures: {
    falseNegatives: { docId: string; occurrence: number; ref?: string; channel: Channel; obfuscation: Obfuscation[] }[];
    falsePositives: { docId: string; address: string; format: string; reason: string }[];
    attributionErrors: { docId: string; occurrence: number; expected: string; actual: string; method: string }[];
    gateFailures: string[];
  };
}
