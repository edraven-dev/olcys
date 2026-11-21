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
