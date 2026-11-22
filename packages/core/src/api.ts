import type { Sha256Hex } from './common.ts';
import type { FetchMode } from './provenance.ts';
import type { ReportModel } from './report.ts';

/** Cursor-paginated list returned by the API. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Error body returned by the API. `code` is stable English; the UI maps it to Polish text. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/** Optional capabilities of an API instance; the console hides what is switched off. */
export interface ApiFeatures {
  /** Analyst judgements on links and analyst overrides of a case. */
  judgements: boolean;
  suggestions: boolean;
  schedules: boolean;
  reportPdf: boolean;
  exports: boolean;
  auth: boolean;
}

/** `GET /api/meta`: what this API instance runs and supports (read-only, no secrets). */
export interface ApiMeta {
  toolVersion: string;
  /** `CORE_CONTRACTS_VERSION` of the server. */
  contracts: string;
  mode: FetchMode;
  features: ApiFeatures;
  /** Weights and rule versions that new runs are configured with. */
  scoring?: {
    weightsVersion: string;
    weightsSha256: Sha256Hex;
    rulesVersions: Record<string, string>;
    /** Calibration status of the weights (`uncalibrated` until calibrated on reference data). */
    weightsStatus?: string;
  };
  /** Version of the address extractor (patterns, lexicon and URI rules). */
  extractorVersion?: string;
  /**
   * The swappable OpenAI-compatible model. Only the host of the base URL is exposed (never credentials, path or query)
   * and never an API key.
   */
  llm?: { enabled: boolean; baseUrlHost: string; model: string; modelDigest?: string };
  /** Telemetry opt-out variables that apply, and whether each is set in the API's environment (names only). */
  telemetryOptOuts?: { name: string; set: boolean }[];
}

export const REPORT_FILE_KINDS = [
  'html',
  'pdf',
  'pdf_timestamp',
  'manifest',
  'timestamp',
  'stix',
  'misp',
  'csv_links',
  'csv_evidence',
  'csv_cash_out',
  'csv_changes',
] as const;
export type ReportFileKind = (typeof REPORT_FILE_KINDS)[number];

/** One downloadable file of a run's report. `path` is the API route that serves it (same origin). */
export interface ReportFile {
  kind: ReportFileKind;
  fileName: string;
  mediaType: string;
  available: boolean;
  path: string;
  /** Absent for an unavailable file. */
  bytes?: number;
  sha256?: Sha256Hex;
  /** `timestamp` files: the capture whose manifest the RFC 3161 token stamps. */
  captureId?: string;
  /** The `pdf` file: how it is signed. The certificate is always a self-signed demo one (never qualified). */
  pdf?: ReportPdfInfo;
}

/** Signature and PDF/A status of the report PDF of one version. */
export interface ReportPdfInfo {
  /** `signed_timestamped`: PAdES B-T; `signed`: B-B (the file's time-stamp is requested separately); `unsigned`: no signature. */
  status: 'signed_timestamped' | 'signed' | 'unsigned';
  /** Always true: a demo certificate, not a qualified one. */
  demoCertificate: true;
  pdfaProfile: string;
  pdfaCompliant: boolean;
  signedAt?: string;
  signerCertSha256?: Sha256Hex;
  /** Stable warning codes (e.g. `signing_unavailable`). */
  warnings: string[];
  /** SHA-256 of the PDF/A manifest embedded in the file (an associated file). */
  manifestSha256: Sha256Hex;
}

/** `GET /api/runs/:runId/report/view` for a report saved in the old format: files only, links not bound to a version. */
export interface LegacyReportView {
  legacy: true;
  files: ReportFile[];
}

/**
 * `GET /api/runs/:runId/report/view`: the report model the HTML renderer is built from, plus the downloadable files.
 * 404 until a report exists.
 */
export interface ReportView {
  legacy?: false;
  /** Id of the published report version the model and every file below belong to (download paths are bound to it). */
  version: string;
  report: ReportModel;
  files: ReportFile[];
}
