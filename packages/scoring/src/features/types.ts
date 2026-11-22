import type {
  AddressCluster,
  AddressRef,
  AdmiraltyReliability,
  Capture,
  EvidenceFeature,
  ExclusionDecision,
  ExtractionResult,
  Id,
  Identifier,
  Observation,
  OnlineAccount,
  ReviewDecision,
  RoleCue,
  SourceDescriptor,
  SourceId,
} from '@olcys/core';

/** A reliability grade set by an analyst for the items of one observation, candidate or source. */
export interface AnalystGrade {
  observationId?: Id;
  candidateId?: Id;
  sourceId?: SourceId;
  grade: AdmiraltyReliability;
  overrideId: Id;
  analyst: string;
}

/** An analyst's decision on a review-required (deobfuscated, gap-joined or OCR-repaired) candidate. */
export interface AnalystReview {
  candidateId: Id;
  decision: ReviewDecision;
  overrideId: Id;
  analyst: string;
}

/**
 * Evidence added by an analyst: one item on the identity hop of `accountId` or on the address hop of its path to
 * `address`. Its origin group is `analyst:<overrideId>`, so it never merges with collected items.
 */
export type AnalystEvidence = EvidenceFeature & { accountId?: Id; address?: AddressRef; overrideId: Id };

/** A role cue an analyst confirmed for a candidate (from an LLM suggestion); pending suggestions are never used. */
export interface AnalystCue {
  candidateId: Id;
  cue: RoleCue;
  suggestionId: Id;
}

/** Human inputs a rescore run applies (`applyOverrides`), kept apart from what the run collected. */
export interface AnalystInputs {
  grades: AnalystGrade[];
  reviews: AnalystReview[];
  evidence: AnalystEvidence[];
  cues: AnalystCue[];
}

/** Everything one run collected, as the scorer reads it. */
export interface FeatureExtractionInput {
  runId: Id;
  identifiers: Identifier[];
  accounts: OnlineAccount[];
  captures: Capture[];
  observations: Observation[];
  extractions: ExtractionResult[];
  /** Source register lookup: a source graded F makes all its items F (an analyst must grade it first). */
  sources: (id: SourceId) => SourceDescriptor | undefined;
  /** Exclusion decisions (labels, deposit, contract and deny-list rules); empty until that step has run. */
  exclusions: ExclusionDecision[];
  /**
   * Bitcoin co-spend clusters of the chain analysis (a heuristic): the members of a cluster seeded by an address the
   * subject claims become `CLUSTER_ASSOCIATED` claims, which carry no score (never an ownership claim).
   */
  clusters?: AddressCluster[];
  /** Count of unconfirmed LLM suggestions; they are never features, the count is only reported as a gate. */
  llmSuggestionsExcluded?: number;
  /** Analyst overrides applied by a rescore run (`applyOverrides`); absent in every other run. */
  analyst?: AnalystInputs;
}

/** Why some collected evidence did not become a feature (shown next to the links, never scored). */
export const FEATURE_NOTE_CODES = [
  'observation_address_invalid',
  'observation_address_unconfirmed',
  'signature_invalid',
  'signature_unsupported_format',
  'signed_message_incomplete',
  'signed_message_unbound',
  'verification_invalid',
  'claim_ignored',
  'unattributed_observation',
  'unattributed_mention',
  'no_identity_path',
  'feature_not_in_weights',
  'no_subject',
  'claim_not_scored',
  'analyst_rejected_candidate',
  'analyst_evidence_unmatched',
] as const;
export type FeatureNoteCode = (typeof FEATURE_NOTE_CODES)[number];

export interface FeatureNote {
  code: FeatureNoteCode;
  /** English, at most 200 characters, never secrets. */
  detail: string;
  captureId?: Id;
  observationId?: Id;
}
