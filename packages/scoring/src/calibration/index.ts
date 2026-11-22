export { canonicalJson, sha256OfText } from './canonical.ts';
export { reportMarkdown } from './markdown.ts';
export {
  binIndex,
  brier,
  DEFAULT_BINS,
  DEFAULT_BOOTSTRAP,
  ece,
  estimateMetrics,
  logLoss,
  reliabilityBins,
  type Estimate,
  type ReliabilityBin,
} from './metrics.ts';
export { parsePersonaSet, scorePersona, type PersonaCase, type PersonaResult } from './persona.ts';
export { PROPOSAL_VERSION, proposeWeights } from './propose.ts';
export { Rng } from './prng.ts';
export { expectedRelation, relationAccuracy, type RelationAccuracy, type RelationPair } from './relations.ts';
export {
  CALIBRATION_NOTICE,
  calibrate,
  empiricalLr,
  serialiseReport,
  type CalibrateOptions,
  type CalibrationReport,
  type CorpusProvenance,
  type FeatureStats,
} from './report.ts';
export {
  generateClaims,
  oracleScenarios,
  ORACLE_ANCHOR_SHARE,
  parseScenarios,
  type LabelledClaim,
  type ScenarioFeature,
  type ScenarioSpec,
} from './scenarios.ts';
export { reliabilitySvg } from './svg.ts';
