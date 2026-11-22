/**
 * Pipeline step `report.render`: assembles the run's report data, renders the HTML, checks that it is
 * self-contained, stores both in the blob store and records them as the run's `html` and `data_json` reports.
 * Structurally compatible with the worker's `Stage` (this package does not depend on the worker).
 */
import type { AnalysisRun, BlobRef, BlobStore, Clock, Id, Logger, Repositories, SourceDescriptor } from '@olcys/core';
import { canonicalJson } from '@olcys/core';
import { buildReportData } from './build.ts';
import { buildExports, type ExportSettings } from './export/index.ts';
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
}

export interface StoredReport {
  html: BlobRef;
  data: BlobRef;
  /** The STIX, MISP and CSV exports, keyed by export kind (also the report kind they are stored under). */
  exports: Record<string, BlobRef>;
}

/** Renders and stores one report; returns the blob references of the HTML and of its input data. */
export async function storeReport(
  deps: { repos: Repositories; blobs: BlobStore },
  data: ReportData,
  settings: Partial<ExportSettings> = {},
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
  return { html: htmlRef, data: dataRef, exports };
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
      const stored = await storeReport(ctx, data, options.exports);
      await ctx.progress?.({ report: stored.html.sha256 });
      ctx.logger?.info('report rendered', { runId: ctx.run.id, html: stored.html.sha256, bytes: stored.html.bytes });
    },
  };
}
