/**
 * @olcys/scoring — Two-hop likelihood-ratio Confidence Score with explainable per-feature contributions.
 *
 * Pure and deterministic (no network, no clock or ids of its own). Contracts come from @olcys/core.
 */
export { verifyBip137, type Bip137Result } from './bip137.ts';
export { buildClaims, scoreRun } from './features/claims.ts';
export { normaliseHandle } from './features/normalise.ts';
export {
  FEATURE_NOTE_CODES,
  type AnalystCue,
  type AnalystEvidence,
  type AnalystGrade,
  type AnalystInputs,
  type AnalystReview,
  type FeatureExtractionInput,
  type FeatureNote,
  type FeatureNoteCode,
} from './features/types.ts';
export { discount, probabilityFromBits, scoreHop } from './hop.ts';
export {
  analyticConfidence,
  combinePaths,
  scoreLink,
  type ClaimInput,
  type PathInput,
  type ScoreResult,
} from './link.ts';
export { ANALYST_EVIDENCE, applyOverrides, latestJudgement, overridesAt, overridesVersion } from './overrides.ts';
export { enfsiTerm, icd203Term, SCORE_BAND_FLOORS, scoreBand } from './scales.ts';
export { ALGORITHM_VERSION, RELATION_RULES_VERSION } from './version.ts';
export {
  DEFAULT_WEIGHTS_FILE,
  featureFamily,
  loadWeights,
  parseWeights,
  weightsPath,
  type EnfsiRow,
  type FeatureWeight,
  type Icd203Row,
  type ScoringWeights,
} from './weights.ts';
export * from './calibration/index.ts';
