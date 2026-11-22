import type { Valuation } from './analytics.ts';
import type { ChangeEvent } from './changes.ts';
import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { TimestampToken } from './evidence.ts';
import type { FetchMode } from './provenance.ts';
import type { AnalyticConfidence } from './scoring.ts';

/**
 * Case report. The three statement classes are never mixed:
 *   A. facts      — exactly what a source showed, with capture reference
 *   B. computed   — deterministic results (validation, scores, heuristics, valuations)
 *   C. inferences — hypotheses needing verification (analyst or AI-suggested, always labelled)
 */
export interface ReportModel {
  reportId: Id;
  caseId: Id;
  runId: Id;
  language: 'pl' | 'en';
  generatedAt: IsoDateTime;
  reproducibility: {
    toolVersion: string;
    gitCommit?: string;
    algorithmVersion: string;
    weightsVersion: string;
    weightsSha256: Sha256Hex;
    rulesVersions: Record<string, string>;
    modelDigests?: Record<string, string>;
    mode: FetchMode;
    /** Calibration status of the weights (`uncalibrated` until calibrated on reference data). */
    weightsStatus?: string;
    /** SHA-256 of the source register file the run used. */
    sourcesConfigSha256?: Sha256Hex;
    /** SHA-256 of the canonical report data (the input of the HTML renderer). */
    dataSha256?: Sha256Hex;
  };
  summary: { headline: string; likelihoodStatements: string[]; analyticConfidence: AnalyticConfidence };
  /**
   * Set when the analysis is incomplete (a source blocked, a login wall, a CAPTCHA, a fetch error, or a stage that
   * reported missing data): which pages and why. Absent for a complete run.
   */
  coverage?: ReportCoverage;
  facts: ReportFact[];
  computed: ReportComputed[];
  inferences: ReportInference[];
  /** Chronological description of fund flows. */
  fundFlow: { at: IsoDateTime; description: string; txHashes: string[]; valuation?: Valuation }[];
  changesSincePrevious: ChangeEvent[];
  evidenceRegister: {
    captureId: Id;
    url: string;
    collectedAt: IsoDateTime;
    manifestSha256: Sha256Hex;
    timestamp?: TimestampToken;
    /** Display name of the source (the register's Polish name when it has one). */
    sourceName?: string;
  }[];
}

export interface ReportCoverage {
  /** Polish sentences of the reasons the stages reported (`partialReasons` / `partialCodes`). */
  reasons: string[];
  /** Pages whose content could not be read; a block, login wall, CAPTCHA or error is not "page does not exist". */
  unavailable: { sourceName: string; url: string; status: string }[];
}

export interface ReportFact {
  id: Id;
  statement: string;
  captureId: Id;
  url: string;
  collectedAt: IsoDateTime;
  quote?: string;
}

export interface ReportComputed {
  id: Id;
  kind: 'validation' | 'score' | 'exclusion' | 'cash_out' | 'activity' | 'heuristic' | 'valuation';
  statement: string;
  /** Machine-readable payload (e.g. the LinkAssessment), embedded in the JSON manifest. */
  data: unknown;
  basedOn: Id[];
}

export interface ReportInference {
  id: Id;
  statement: string;
  basedOn: Id[];
  alternatives: string[];
  origin: 'analyst' | 'ai_suggestion' | 'rule';
  requiresVerification: true;
  /** Steps that would confirm or refute the hypothesis (AI-assisted drafts; rule inferences have none). */
  verificationSteps?: string[];
  /** Set on an inference drafted by the model and confirmed by an analyst (never on a pending or rejected draft). */
  ai?: ReportInferenceAi;
}

/** Provenance of an AI-assisted inference: what the model produced and which analyst approved it, and when. */
export interface ReportInferenceAi {
  /** `confirmed` as drafted, or `edited`: the analyst changed the text (the statement is the analyst's text). */
  review: 'confirmed' | 'edited';
  analyst: string;
  decidedAt: IsoDateTime;
  model: string;
  promptVersion: string;
  /** The draft as the model wrote it, kept when the analyst edited it. */
  draftStatement?: string;
}
