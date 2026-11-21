/**
 * Pipeline step `report.render`: assembles the run's report data, renders the HTML, checks that it is
 * self-contained, stores both in the blob store and records them as the run's `html` and `data_json` reports.
 * Structurally compatible with the worker's `Stage` (this package does not depend on the worker).
 */
import type { AnalysisRun, BlobRef, BlobStore, Clock, Id, Logger, Repositories, SourceDescriptor } from '@olcys/core';
import { buildReportData } from './build.ts';
import { renderReport } from './render/document.ts';
import { assertSelfContainedHtml } from './self-contained.ts';
import type { ReportData } from './types.ts';
import { reportDataJson } from './view.ts';

export const REPORT_HTML_MEDIA_TYPE = 'text/html; charset=utf-8';
export const REPORT_DATA_MEDIA_TYPE = 'application/json';
export const REPORT_KINDS = { html: 'html', data: 'data_json' } as const;

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
  sources?: readonly SourceDescriptor[];
  weightsStatus?: string;
  clock?: Clock;
}

export interface StoredReport {
  html: BlobRef;
  data: BlobRef;
}

/** Renders and stores one report; returns the blob references of the HTML and of its input data. */
export async function storeReport(
  deps: { repos: Repositories; blobs: BlobStore },
  data: ReportData,
): Promise<StoredReport> {
  const html = renderReport(data);
  assertSelfContainedHtml(html);
  const encoder = new TextEncoder();
  const dataRef = await deps.blobs.put(encoder.encode(reportDataJson(data)), REPORT_DATA_MEDIA_TYPE);
  const htmlRef = await deps.blobs.put(encoder.encode(html), REPORT_HTML_MEDIA_TYPE);
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
  return { html: htmlRef, data: dataRef };
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
      const stored = await storeReport(ctx, data);
      await ctx.progress?.({ report: stored.html.sha256 });
      ctx.logger?.info('report rendered', { runId: ctx.run.id, html: stored.html.sha256, bytes: stored.html.bytes });
    },
  };
}
