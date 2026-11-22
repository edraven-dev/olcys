/**
 * The report manifest embedded in the PDF/A as an associated file (`manifest.json`, relationship Data): the canonical
 * JSON of the report model the HTML was rendered from, the digests tying HTML, model and captures together, and the
 * time-stamp tokens of the captures. Facts, computed results and inferences stay separate inside the model.
 */
import { createHash } from 'node:crypto';
import type { BlobStore, Id, IsoDateTime } from '@olcys/core';
import { canonicalJson } from '@olcys/core';
import type { ReportData } from './types.ts';
import { reportDataJson } from './view.ts';

export const REPORT_MANIFEST_SCHEMA = 'olcys.report-manifest/1';
export const MANIFEST_FILE_NAME = 'manifest.json';

export interface ReportManifestCapture {
  captureId: Id;
  /** SHA-256 of the capture's canonical manifest (the digest that was time-stamped). */
  manifestSha256: string;
  sourceId: string;
  url: string;
  collectedAt: IsoDateTime;
  artifacts: { kind: string; sha256: string; bytes: number }[];
  timestamp?: { tsaUrl: string; genTime: IsoDateTime; serialNumber?: string; responseDerBase64: string };
}

export interface ReportManifest {
  schema: typeof REPORT_MANIFEST_SCHEMA;
  reportId: Id;
  caseId: Id;
  runId: Id;
  generatedAt: IsoDateTime;
  /** SHA-256 of the canonical JSON of `reportModel`: the value the HTML prints as the digest of the report data. */
  reportModelSha256: string;
  htmlSha256: string;
  /** The report data the HTML was rendered from (the same canonical JSON as the stored report data file). */
  reportModel: unknown;
  captures: ReportManifestCapture[];
  tool: { version: string; gitCommit?: string };
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Captures of the report with their stored time-stamp tokens (read from the blob store). */
export async function manifestCaptures(data: ReportData, blobs: BlobStore): Promise<ReportManifestCapture[]> {
  return Promise.all(
    data.captures.map(async (capture): Promise<ReportManifestCapture> => {
      const token = capture.timestamp;
      const entry: ReportManifestCapture = {
        captureId: capture.id,
        manifestSha256: capture.manifestSha256,
        sourceId: capture.sourceId,
        url: capture.url,
        collectedAt: capture.collectedAt,
        artifacts: capture.artifacts.map((a) => ({ kind: a.kind, sha256: a.blob.sha256, bytes: a.blob.bytes })),
      };
      if (token) {
        const der = await blobs.get(token.token.sha256);
        entry.timestamp = {
          tsaUrl: token.tsaUrl,
          genTime: token.genTime,
          ...(token.serialNumber ? { serialNumber: token.serialNumber } : {}),
          responseDerBase64: Buffer.from(der).toString('base64'),
        };
      }
      return entry;
    }),
  );
}

/** The manifest of one report, built from its data and the digest of its HTML. */
export async function createReportManifest(
  data: ReportData,
  htmlSha256: string,
  blobs: BlobStore,
  gitCommit?: string,
): Promise<ReportManifest> {
  const reportDataText = reportDataJson(data);
  return {
    schema: REPORT_MANIFEST_SCHEMA,
    reportId: data.reportId,
    caseId: data.case.id,
    runId: data.run.id,
    generatedAt: data.generatedAt,
    reportModelSha256: sha256Hex(reportDataText),
    htmlSha256,
    reportModel: JSON.parse(reportDataText),
    captures: await manifestCaptures(data, blobs),
    tool: { version: data.run.config.toolVersion, ...(gitCommit ? { gitCommit } : {}) },
  };
}

/** Canonical JSON (RFC 8785) of the manifest and its SHA-256. */
export function buildReportManifest(manifest: ReportManifest): { json: string; sha256: string } {
  const json = canonicalJson(JSON.parse(JSON.stringify(manifest)));
  return { json, sha256: sha256Hex(json) };
}
