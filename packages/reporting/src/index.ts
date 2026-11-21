/**
 * @olcys/reporting — the evidence-grade analysis report: self-contained Polish HTML with source facts, computed
 * results and inferences kept apart, built from the run's stored data, plus the `report.render` pipeline step.
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export const PACKAGE_NAME = '@olcys/reporting';

export { buildReportData, type BuildReportOptions } from './build.ts';
export { formatAmount, formatDecimal, formatLongDate, formatPln, formatUtc, plural } from './format.ts';
export { escapeHtml, markup, SafeHtml, t, type Html } from './html.ts';
export { pl, type Catalogue } from './i18n/pl.ts';
export { STATEMENT_IDS, type StatementClass } from './render/blocks.ts';
export { REPORT_CSP, renderReport } from './render/document.ts';
export { assertSelfContainedHtml, ExternalReferenceError } from './self-contained.ts';
export {
  createReportStage,
  REPORT_DATA_MEDIA_TYPE,
  REPORT_HTML_MEDIA_TYPE,
  REPORT_KINDS,
  storeReport,
  type ReportStage,
  type ReportStageContext,
  type ReportStageOptions,
  type StoredReport,
} from './stage.ts';
export { REPORT_TEMPLATE_VERSION, type RejectedCandidate, type ReportData, type ReportSource } from './types.ts';
export { BAND_IDS, ICD203_SCALE, icdTerm, reportDataJson, scoreBand, type BandId } from './view.ts';
