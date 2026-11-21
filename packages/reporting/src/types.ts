import type {
  ActivityIndicators,
  AddressCandidate,
  AddressLabel,
  AdmiraltyReliability,
  AnalysisRun,
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
  LinkAssessment,
  NormalizedTransfer,
  Observation,
  OnlineAccount,
  SourceId,
  SourceKind,
  TextView,
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
  sources: ReportSource[];
  captures: Capture[];
  /** Captures of earlier runs cited by change events (the "before" side of a wallet swap). */
  earlierCaptures: Capture[];
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
  labels: AddressLabel[];
  activity: ActivityIndicators[];
  cashOuts: CashOutEvent[];
  changes: ChangeEvent[];
}
