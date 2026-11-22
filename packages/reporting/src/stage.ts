/**
 * Pipeline step `report.render`: assembles the run's report data, renders the HTML, checks that it is
 * self-contained, stores both in the blob store and records them as the run's `html` and `data_json` reports.
 * Structurally compatible with the worker's `Stage` (this package does not depend on the worker).
 */
import type {
  AnalysisRun,
  BlobRef,
  BlobStore,
  Clock,
  EgressClient,
  Id,
  Logger,
  PartialCode,
  PartialParams,
  Repositories,
  SourceDescriptor,
  TrustedTimestamper,
} from '@olcys/core';
import { canonicalJson } from '@olcys/core';
import { buildReportData } from './build.ts';
import { buildExports, type ExportSettings } from './export/index.ts';
import { createReportManifest } from './manifest.ts';
import { PdfRenderError, renderReportPdf, type ReportPdfDeps, type ReportPdfResult } from './pdf.ts';
import { pl } from './i18n/pl.ts';
import { renderReport } from './render/document.ts';
import { assertSelfContainedHtml } from './self-contained.ts';
import type { ReportData } from './types.ts';
import { reportDataJson } from './view.ts';

export const REPORT_HTML_MEDIA_TYPE = 'text/html; charset=utf-8';
export const REPORT_DATA_MEDIA_TYPE = 'application/json';
export const REPORT_KINDS = { html: 'html', data: 'data_json', exportSet: 'export_set' } as const;

export interface ReportStageContext {
  run: AnalysisRun;
  /** The run whose collected evidence is reported (for a rescore: the rescored run). */
  evidenceRunId?: Id;
  repos: Repositories;
  blobs: BlobStore;
  logger?: Logger;
  progress?(detail: Record<string, unknown>): Promise<void>;
  /** The report is incomplete (e.g. the PDF could not be produced): the run ends as `partial`. */
  markPartial?(reason: string, coded?: { code: PartialCode; params?: PartialParams }): void;
}

export interface ReportStage {
  readonly step: 'report.render';
  run(ctx: ReportStageContext): Promise<void>;
}

export interface ReportStageOptions {
  /** STIX producer name and TLP marking of the exports (default: the demo instance name and TLP:AMBER). */
  exports?: Partial<ExportSettings>;
  sources?: readonly SourceDescriptor[];
  weightsStatus?: string;
  clock?: Clock;
  /** PDF/A rendering and signing; absent: the report has HTML, data and exports only. */
  pdf?: ReportPdfOptions;
}

/** Wiring of the PDF step: the egress client is created per run (it logs into the run's repositories). */
export interface ReportPdfOptions {
  createHttp(ctx: { repos: Repositories; blobs: BlobStore; runId: Id }): EgressClient;
  timestamper?: TrustedTimestamper;
  config: ReportPdfDeps['config'];
  gitCommit?: string;
}

export interface StoredReport {
  html: BlobRef;
  data: BlobRef;
  /** The STIX, MISP and CSV exports, keyed by export kind (also the report kind they are stored under). */
  exports: Record<string, BlobRef>;
  /** The PDF step's result (absent when the step is not configured or failed). */
  pdf?: ReportPdfResult;
  /** Why the PDF could not be produced (stable code), when it could not. */
  pdfError?: string;
}

/** Renders and stores one report; returns the blob references of the HTML and of its input data. */
export async function storeReport(
  deps: { repos: Repositories; blobs: BlobStore },
  data: ReportData,
  settings: Partial<ExportSettings> = {},
  pdfStep?: { deps: ReportPdfDeps; gitCommit?: string },
): Promise<StoredReport> {
  const html = renderReport(data);
  assertSelfContainedHtml(html);
  const encoder = new TextEncoder();
  // Every blob is stored first (content-addressed, so harmless on their own); only then is the version registered.
  const dataRef = await deps.blobs.put(encoder.encode(reportDataJson(data)), REPORT_DATA_MEDIA_TYPE);
  const htmlRef = await deps.blobs.put(encoder.encode(html), REPORT_HTML_MEDIA_TYPE);
  const exports: Record<string, BlobRef> = {};
  const set: ExportSet = {
    version: 1,
    runId: data.run.id,
    htmlSha256: htmlRef.sha256,
    dataSha256: dataRef.sha256,
    exports: {},
  };
  const artifacts = buildExports(
    { data },
    { producerName: settings.producerName ?? pl.exports.producerDefault, tlp: settings.tlp ?? 'amber' },
  );
  const refs = await Promise.all(
    artifacts.map((artifact) => deps.blobs.put(encoder.encode(artifact.content), artifact.mediaType)),
  );
  artifacts.forEach((artifact, i) => {
    const ref = refs[i];
    if (!ref) return;
    exports[artifact.kind] = ref;
    set.exports[artifact.kind] = { sha256: ref.sha256, mediaType: artifact.mediaType };
  });
  // The PDF belongs to this version: it is part of the set (and so of the version id), never added afterwards.
  let pdf: ReportPdfResult | undefined;
  let pdfError: string | undefined;
  if (pdfStep) {
    try {
      const manifest = await createReportManifest(data, htmlRef.sha256, deps.blobs, pdfStep.gitCommit);
      pdf = await renderReportPdf({ reportId: data.reportId, runId: data.run.id, html, manifest }, pdfStep.deps);
      set.pdf = pdfSetEntry(data.reportId, pdf);
    } catch (error) {
      pdfError = error instanceof PdfRenderError ? error.code : 'pdf_failed';
      pdfStep.deps.logger?.error('report PDF failed', {
        runId: data.run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const setRef = await deps.blobs.put(encoder.encode(canonicalJson(set)), REPORT_DATA_MEDIA_TYPE);
  // One publication at a time per run: concurrent renders must not interleave their rows, or the latest HTML
  // and the latest export set could belong to different versions.
  await serialized(data.run.id, async () => {
    await deps.repos.analysis.addReport({
      runId: data.run.id,
      kind: REPORT_KINDS.data,
      blobSha256: dataRef.sha256,
      mediaType: REPORT_DATA_MEDIA_TYPE,
    });
    await deps.repos.analysis.addReport({
      runId: data.run.id,
      kind: REPORT_KINDS.html,
      blobSha256: htmlRef.sha256,
      mediaType: REPORT_HTML_MEDIA_TYPE,
    });
    // Registered last: the exports belong to the version whose HTML this set names (see `findExportSet`).
    await deps.repos.analysis.addReport({
      runId: data.run.id,
      kind: REPORT_KINDS.exportSet,
      blobSha256: setRef.sha256,
      mediaType: REPORT_DATA_MEDIA_TYPE,
    });
  });
  return { html: htmlRef, data: dataRef, exports, ...(pdf ? { pdf } : {}), ...(pdfError ? { pdfError } : {}) };
}

function pdfSetEntry(reportId: Id, pdf: ReportPdfResult): PdfSetEntry {
  const blob = (kind: string) => pdf.artifacts.find((a) => a.kind === kind)?.blob;
  const file = blob('pdf_signed') ?? blob('pdf');
  const manifest = blob('manifest_json');
  if (!file || !manifest) throw new PdfRenderError('pdf_incomplete', 'the PDF step returned no file');
  const token = blob('timestamp_reply');
  return {
    reportId,
    status: pdf.status,
    sha256: file.sha256,
    bytes: file.bytes,
    mediaType: file.mediaType,
    manifestSha256: manifest.sha256,
    pdfa: pdf.pdfa,
    demoCertificate: true,
    warnings: pdf.warnings,
    ...(pdf.signature ? { signature: pdf.signature } : {}),
    ...(pdf.status === 'signed_timestamped' && token
      ? { timestampSha256: token.sha256, timestampBytes: token.bytes }
      : {}),
  };
}

const publishing = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task of the same key (in this process) has settled. */
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (publishing.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  publishing.set(key, tail);
  try {
    return await run;
  } finally {
    if (publishing.get(key) === tail) publishing.delete(key);
  }
}

/** The exports of one report version: the HTML they were generated with and a digest per export kind. */
export interface ExportSet {
  version: 1;
  /** The run and the report data of the version (absent in sets stored before versioned downloads). */
  runId?: string;
  htmlSha256: string;
  dataSha256?: string;
  exports: Record<string, { sha256: string; mediaType: string }>;
  /** The PDF/A of this version (the signed one when signing succeeded), absent when it was not produced. */
  pdf?: PdfSetEntry;
}

/** The PDF of a report version. A `report_pdf` time-stamp requested for a `signed` PDF is granted later, outside the set. */
export interface PdfSetEntry {
  reportId: Id;
  status: 'signed_timestamped' | 'signed' | 'unsigned';
  /** SHA-256, size and media type of the served PDF (signed when it is signed). */
  sha256: string;
  bytes: number;
  mediaType: string;
  manifestSha256: string;
  pdfa: { profile: string; compliant: boolean; residual: number };
  /** Always true: the signing certificate is a self-signed demo one, not a qualified one. */
  demoCertificate: true;
  warnings: string[];
  signature?: { signerCertSha256: string; signedAt: string; timestamped: boolean };
  /** The RFC 3161 token embedded in the signature (status `signed_timestamped`). */
  timestampSha256?: string;
  timestampBytes?: number;
}

/**
 * The exports that belong to the run's current report: the latest export set, valid only when it names the latest HTML
 * report. A newer HTML whose exports failed to save (or a run rendered before exports existed) yields `undefined`, so
 * downloads never mix versions.
 */
export async function findExportSet(
  deps: { repos: Repositories; blobs: BlobStore },
  runId: Id,
): Promise<ExportSet | undefined> {
  const [html, stored] = await Promise.all([
    deps.repos.analysis.latestReport(runId, REPORT_KINDS.html),
    deps.repos.analysis.latestReport(runId, REPORT_KINDS.exportSet),
  ]);
  if (!html || !stored) return undefined;
  try {
    const set = JSON.parse(new TextDecoder().decode(await deps.blobs.get(stored.blobSha256))) as ExportSet;
    return set.version === 1 && set.htmlSha256 === html.blobSha256 ? set : undefined;
  } catch {
    return undefined;
  }
}

/** One complete published report version: the set blob that names its HTML, data and exports (all content-addressed). */
export interface PublishedReport {
  legacy?: false;
  /** SHA-256 of the export-set blob: the version id (the set is registered last, so it exists only for a complete version). */
  version: string;
  set: ExportSet & { runId: string; dataSha256: string };
}

/**
 * A report saved before versioned downloads (its export set names neither run nor data). Its HTML and exports are the
 * run's current ones, but their links cannot be bound to a version.
 */
export interface LegacyReport {
  legacy: true;
  set: ExportSet;
}

const isPublishedSet = (set: ExportSet, runId: Id): set is PublishedReport['set'] =>
  set.version === 1 && set.runId === runId && typeof set.dataSha256 === 'string';

const parseSet = (bytes: Uint8Array): ExportSet => JSON.parse(new TextDecoder().decode(bytes)) as ExportSet;

/**
 * The run's current report, or `undefined` when there is none (no rows, or the newest HTML is not covered by a
 * complete set yet). A report in the old format is returned as `legacy`. A stored blob that cannot be read or parsed
 * is a fault and throws.
 */
export async function findPublishedReport(
  deps: { repos: Repositories; blobs: BlobStore },
  runId: Id,
): Promise<PublishedReport | LegacyReport | undefined> {
  const [html, stored] = await Promise.all([
    deps.repos.analysis.latestReport(runId, REPORT_KINDS.html),
    deps.repos.analysis.latestReport(runId, REPORT_KINDS.exportSet),
  ]);
  if (!html || !stored) return undefined;
  const set = parseSet(await deps.blobs.get(stored.blobSha256));
  if (set.version !== 1 || set.htmlSha256 !== html.blobSha256) return undefined;
  return isPublishedSet(set, runId) ? { version: stored.blobSha256, set } : { legacy: true, set };
}

/**
 * A published version named by its id (a download link of an earlier listing). `undefined` only when no such version
 * exists (no blob, or a blob that is not a version of this run); an unreadable or unparsable stored blob throws.
 */
export async function loadReportVersion(
  deps: { repos: Repositories; blobs: BlobStore },
  runId: Id,
  version: string,
): Promise<PublishedReport | undefined> {
  if (!(await deps.blobs.has(version))) return undefined;
  const set = parseSet(await deps.blobs.get(version));
  return set !== null && typeof set === 'object' && isPublishedSet(set, runId) ? { version, set } : undefined;
}

export function createReportStage(options: ReportStageOptions = {}): ReportStage {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    step: 'report.render',
    async run(ctx) {
      const data = await buildReportData(ctx.repos, ctx.run.id, {
        ...(options.sources ? { sources: options.sources } : {}),
        ...(options.weightsStatus ? { weightsStatus: options.weightsStatus } : {}),
        generatedAt: clock.now().toISOString(),
        ...(ctx.evidenceRunId ? { evidenceRunId: ctx.evidenceRunId } : {}),
      });
      const pdf = options.pdf;
      const stored = await storeReport(
        ctx,
        data,
        options.exports,
        pdf
          ? {
              deps: {
                http: pdf.createHttp({ repos: ctx.repos, blobs: ctx.blobs, runId: ctx.run.id }),
                blobs: ctx.blobs,
                ...(pdf.timestamper ? { timestamper: pdf.timestamper } : {}),
                ...(ctx.logger ? { logger: ctx.logger } : {}),
                config: pdf.config,
              },
              ...(pdf.gitCommit ? { gitCommit: pdf.gitCommit } : {}),
            }
          : undefined,
      );
      if (stored.pdfError)
        ctx.markPartial?.(`report PDF not produced: ${stored.pdfError}`, {
          code: 'pdf_unavailable',
          params: { reason: stored.pdfError },
        });
      await ctx.progress?.({ report: stored.html.sha256 });
      ctx.logger?.info('report rendered', { runId: ctx.run.id, html: stored.html.sha256, bytes: stored.html.bytes });
    },
  };
}
