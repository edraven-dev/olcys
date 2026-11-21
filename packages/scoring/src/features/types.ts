import type {
  Capture,
  ExclusionDecision,
  ExtractionResult,
  Id,
  Identifier,
  Observation,
  OnlineAccount,
  SourceDescriptor,
  SourceId,
} from '@olcys/core';

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
  /** Count of unconfirmed LLM suggestions; they are never features, the count is only reported as a gate. */
  llmSuggestionsExcluded?: number;
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
] as const;
export type FeatureNoteCode = (typeof FEATURE_NOTE_CODES)[number];

export interface FeatureNote {
  code: FeatureNoteCode;
  /** English, at most 200 characters, never secrets. */
  detail: string;
  captureId?: Id;
  observationId?: Id;
}
