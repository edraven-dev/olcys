import type { AddressRef } from './chains.ts';
import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { AdmiraltyReliability } from './sources.ts';

/**
 * Kind of evidence binding an address to an account.
 * E1 cryptographic binding · E2 account-authenticated self-assertion · E3 contextual mention ·
 * E4 third-party attribution (corroborates only) · AUTH official list (drives exclusion, not identity).
 */
export const EVIDENCE_TIERS = ['E1', 'E2', 'E3', 'E4', 'AUTH'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** What an identity↔address link asserts. Assigned by versioned rules. */
export const RELATIONS = [
  'SELF_DECLARED',
  'PAYMENT_ENDPOINT',
  'THIRD_PARTY_ATTRIBUTION',
  'MENTION_UNCLEAR',
  'TX_COUNTERPARTY',
  'CLUSTER_ASSOCIATED',
  'CUSTODIAL_EXCHANGE',
] as const;
export type Relation = (typeof RELATIONS)[number];

/** identity hop: does the account belong to the subject? address hop: does the account control the address? */
export const HOPS = ['identity', 'address'] as const;
export type Hop = (typeof HOPS)[number];

/** One piece of evidence, before weighting. `feature` is a key of config/scoring/weights.v1.yaml. */
export interface EvidenceFeature {
  hop: Hop;
  feature: string;
  reliability: AdmiraltyReliability;
  /** Same author account / domain / repost chain / capture: only the strongest item per feature family counts. */
  originGroup: string;
  evidence: { captureId?: Id; observationId?: Id; candidateId?: Id; fetchIds?: Id[] };
  detail?: string;
}

/**
 * Why a contribution is not counted: `ungraded` (grade F, an analyst must grade the source first) or
 * `same_origin_repeat` (a stronger item of the same family exists in the same origin group — repeats within one
 * account or service never add up).
 */
export const UNCOUNTED_REASONS = ['ungraded', 'same_origin_repeat'] as const;
export type UncountedReason = (typeof UNCOUNTED_REASONS)[number];

export interface FeatureContribution extends EvidenceFeature {
  bayesFactor: number;
  /** Reliability weight ρ from the Admiralty grade. */
  rho: number;
  /** BF' = ρ·BF + (1 − ρ) */
  discountedBayesFactor: number;
  /** log2(BF') — the bar length in the waterfall chart. */
  bits: number;
  /** False when superseded by a stronger item of the same family in the same origin group. */
  counted: boolean;
  /** Set when `counted` is false. */
  uncountedReason?: UncountedReason;
}

export interface HopResult {
  hop: Hop;
  priorBits: number;
  contributions: FeatureContribution[];
  /** priorBits + Σ counted bits */
  totalBits: number;
  /** 2^W / (1 + 2^W) */
  probability: number;
  /** 2^(Σ counted bits), the evidence-only likelihood ratio. */
  likelihoodRatio: number;
  /** ENFSI verbal equivalent of `likelihoodRatio`. */
  enfsiVerbal: string;
}

export const ANALYTIC_CONFIDENCE = ['High', 'Moderate', 'Low'] as const;
export type AnalyticConfidence = (typeof ANALYTIC_CONFIDENCE)[number];

/** One independent route from the subject to the address: P(path) = P(identity hop) × P(address hop). */
export interface LinkPath {
  accountId?: Id;
  identityHop: HopResult;
  addressHop: HopResult;
  probability: number;
  /** True when the identity hop is the investigator-supplied anchor (P fixed by assumption, no contributions). */
  anchor?: boolean;
  /** Service (platform) of the account, e.g. `wykop`. Paths of one service are not independent sources. */
  service?: string;
  /** Origin group of the account, e.g. `acct:wykop:fikcyjny_kacper`. */
  originGroup?: string;
  /** False when a stronger path of the same service exists: it is shown but does not enter the noisy-OR. */
  counted?: boolean;
}

/**
 * Score bands of the challenge's Confidence Score cheat sheet: 80–100 very high, 60–79 probable, 40–59 medium,
 * 10–39 low/noise, 0 exclusion. ASCII identifiers; Polish labels live in the UI and report catalogues.
 * `WYKLUCZENIE` marks a link rejected by a hard gate (exclusion rule or a relation other than ownership); its score is
 * 0. A link that is not rejected but scores below 10 is `NISKIE` (noise).
 */
export const SCORE_BANDS = ['BARDZO_WYSOKIE', 'PRAWDOPODOBNE', 'SREDNIE', 'NISKIE', 'WYKLUCZENIE'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/**
 * Trace synergy: independent sources add up (noisy-OR over the strongest path per service), repeats within one
 * service or origin group do not.
 */
export interface TraceSynergy {
  /** Services whose strongest path entered the noisy-OR, sorted. Two or more = synergy. */
  independentSources: string[];
  /** Score of the strongest single path. */
  bestSingleScore: number;
  /** Points added by the other independent sources: round(100 · combined P) − `bestSingleScore` (before gates). */
  bonusPoints: number;
  /** Paths not counted because a stronger path of the same service exists. */
  repeatedPaths: number;
  /** Evidence items not counted because a stronger item of the same family exists in the same origin group. */
  repeatedItems: number;
}

export interface LinkGate {
  gate: string;
  passed: boolean;
  detail?: string;
}

/** The scored claim (identity, address, relation). Never describes the person, only the link. */
export interface LinkAssessment {
  id: Id;
  runId: Id;
  identityId: Id;
  address: AddressRef;
  relation: Relation;
  tier: EvidenceTier;
  paths: LinkPath[];
  /** 1 − Π(1 − P(path)) over independent paths. */
  probability: number;
  /** round(100 · probability), usable directly as a STIX 2.1 confidence value. */
  score: number;
  /** ICD 203 likelihood term for `probability`. */
  icd203: string;
  /** Kept separate from likelihood, as ICD 203 requires. */
  analyticConfidence: AnalyticConfidence;
  gates: LinkGate[];
  /** Cheat-sheet band of `score`; `WYKLUCZENIE` when a hard gate failed. */
  band?: ScoreBand;
  /**
   * The arithmetic result before a failing hard gate forced `probability` and `score` to 0 — e.g. the strength of
   * the evidence behind an exchange deposit address (a KYC lead, never a holding). Absent when no gate failed.
   */
  ungated?: { probability: number; score: number; icd203: string };
  /** How independent sources combined; absent for links without ownership paths. */
  synergy?: TraceSynergy;
  algorithmVersion: string;
  weightsVersion: string;
  weightsSha256: Sha256Hex;
  rulesVersion: string;
  computedAt: IsoDateTime;
}

/** Analyst decision recorded next to (never instead of) the computed score. */
export interface AnalystJudgement {
  id: Id;
  linkAssessmentId: Id;
  judgement: 'same' | 'not_same' | 'unsure';
  justification: string;
  analyst: string;
  at: IsoDateTime;
}
