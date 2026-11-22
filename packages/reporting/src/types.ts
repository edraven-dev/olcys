import type {
  ActivityIndicators,
  AddressCandidate,
  AddressLabel,
  AddressCluster,
  AddressTypeClassification,
  AdmiraltyReliability,
  AnalysisRun,
  AnalystJudgement,
  AnalystOverride,
  Capture,
  CaseWithIdentifiers,
  CashOutEvent,
  ChangeEvent,
  ComplianceStatus,
  EgressLogEntry,
  ExclusionDecision,
  FlowEdge,
  Id,
  IsoDateTime,
  LlmSuggestion,
  LinkAssessment,
  NormalizedTransfer,
  Observation,
  OnlineAccount,
  PartialReason,
  SourceId,
  SourceKind,
  TextView,
  TimestampRequestOutcome,
} from '@olcys/core';

export const REPORT_TEMPLATE_VERSION = 'report-html.v1';

/** Source register entry as shown in the report. */
export interface ReportSource {
  id: SourceId;
  /** Polish display name when the register has one. */
  name: string;
  kind: SourceKind;
  compliance: ComplianceStatus;
  reliability: AdmiraltyReliability;
  sendsIdentifiersExternally: boolean;
}

/** A pattern match that failed address validation (homoglyph, documentation example, bad checksum, ...). */
export interface RejectedCandidate {
  captureId: Id;
  raw: string;
  /** `code` or `code: detail`. */
  reason: string;
  view: TextView;
}

/**
 * Everything the report shows, as stored by the run: source facts (captures, observations, candidates, transfers,
 * labels), computed results (links, exclusions, activity, cash-out events, changes) and the run configuration.
 * The renderer derives every sentence from this object, so the same data always yields the same document.
 */
export interface ReportData {
  reportId: Id;
  generatedAt: IsoDateTime;
  templateVersion: string;
  case: CaseWithIdentifiers;
  run: AnalysisRun;
  previousRun?: AnalysisRun;
  /** Calibration status of the weights file (`uncalibrated` until calibrated on reference data). */
  weightsStatus?: string;
  /** Why the run is incomplete (`progress.partial`, recorded by stages via `markPartial`), when it is. */
  partialReasons?: string[];
  /** The coded reasons among `partialReasons` (stable code and parameters), rendered in Polish by the report. */
  partialCodes?: PartialReason[];
  sources: ReportSource[];
  captures: Capture[];
  /** Captures of earlier runs cited by change events (the "before" side of a wallet swap). */
  earlierCaptures: Capture[];
  /** Latest time-stamp request of each own capture that has no token yet (absent when there was none or the store has none). */
  timestampRequests?: Record<Id, { outcome: TimestampRequestOutcome; reason?: string }>;
  accounts: OnlineAccount[];
  observations: Observation[];
  candidates: AddressCandidate[];
  rejectedCandidates: RejectedCandidate[];
  /** Number of private keys / seed phrases found and redacted (values are never stored). */
  secretFindings: number;
  egress: EgressLogEntry[];
  transfers: NormalizedTransfer[];
  flows: FlowEdge[];
  links: LinkAssessment[];
  exclusions: ExclusionDecision[];
  /** Address types of the chain analysis (computed, "as of the recorded chain tip"), when the store keeps them. */
  addressTypes?: AddressTypeClassification[];
  /** Bitcoin co-spend clusters of the chain analysis (a heuristic result), when the store keeps them. */
  clusters?: AddressCluster[];
  labels: AddressLabel[];
  activity: ActivityIndicators[];
  cashOuts: CashOutEvent[];
  changes: ChangeEvent[];
  /**
   * Analyst judgements on this run's links recorded until the report was generated (oldest first): statements next
   * to the computed results, never part of them.
   */
  judgements?: AnalystJudgement[];
  /**
   * Model suggestions of the run (address-mention roles) with their status, for the inferences section: unverified
   * AI hypotheses with zero score weight, never facts. Rejected ones are listed as rejected.
   */
  suggestions?: LlmSuggestion[];
  /** Analyst overrides this run applied (rescore runs: those recorded until it was queued), oldest first. */
  overrides?: AnalystOverride[];
}
