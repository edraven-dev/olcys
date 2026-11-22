/**
 * `renderReportPdf`: the report HTML to PDF/A-3b with Gotenberg (Chromium route, the canonical manifest attached as an
 * associated file), validated, then signed with pyHanko (PAdES) through the osint-py service. Every call is one
 * request of the egress client (`gotenberg` / `pdf_signing`); neither service has network access of its own. The RFC
 * 3161 time-stamp of the signature is requested here, by the worker's timestamper, never by the services.
 *
 * Expected failures of the signing step (service unreachable, key missing) give status `unsigned` with a warning;
 * a rendering or PDF/A failure throws `PdfRenderError`.
 */
import { createHash } from 'node:crypto';
import type {
  BlobRef,
  BlobStore,
  EgressClient,
  EgressResponse,
  Id,
  Logger,
  TimestampOutcome,
  TrustedTimestamper,
} from '@olcys/core';
import { buildReportManifest, MANIFEST_FILE_NAME, type ReportManifest } from './manifest.ts';
import { assertSelfContainedHtml } from './self-contained.ts';

export const PDF_MEDIA_TYPE = 'application/pdf';
export const PDFA_PROFILE = 'PDF/A-3b';
export const SIGNATURE_FIELD = 'Podpis';
export const SIGNATURE_REASON = 'Raport z analizy OSINT';
export const PDF_SOURCES = { gotenberg: 'gotenberg', signing: 'pdf_signing' } as const;

export type ReportPdfStatus = 'signed_timestamped' | 'signed' | 'unsigned';

export interface ReportPdfArtifact {
  kind: 'pdf' | 'pdf_signed' | 'manifest_json' | 'timestamp_reply';
  blob: BlobRef;
}

export interface ReportPdfResult {
  status: ReportPdfStatus;
  artifacts: ReportPdfArtifact[];
  pdfa: { profile: typeof PDFA_PROFILE; compliant: boolean; residual: number };
  timestamp: TimestampOutcome | null;
  /** Machine-readable warning codes (the console and the report render Polish text). */
  warnings: string[];
  /** The signing certificate (demo, not qualified) when the PDF is signed. */
  signature?: { signerCertSha256: string; signedAt: string; timestamped: boolean };
}

/** The PDF could not be produced (Gotenberg unreachable or refused, residual violations, not PDF/A-3b). */
export class PdfRenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PdfRenderError';
    this.code = code;
  }
}

export interface ReportPdfDeps {
  http: EgressClient;
  blobs: BlobStore;
  timestamper?: TrustedTimestamper;
  logger?: Logger;
  config: {
    gotenbergUrl: string;
    signingUrl?: string;
    signing: boolean;
    /** Request an RFC 3161 token for the signature (false when the TSA cannot be reached, e.g. offline mode). */
    timestampSignature?: boolean;
  };
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const base = (url: string): string => url.replace(/\/+$/, '');
const headerOf = (response: EgressResponse, name: string): string | undefined =>
  Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];

/** A multipart body built without any network client: serialised through a `Request`, sent by the egress client. */
async function multipart(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const request = new Request('http://local.invalid', { method: 'POST', body: form });
  return {
    body: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get('content-type') ?? 'multipart/form-data',
  };
}

const file = (bytes: string | Uint8Array<ArrayBuffer>, type: string): Blob => new Blob([bytes], { type });

export const gotenbergStages = (): string =>
  JSON.stringify([
    { op: 'attach', file: MANIFEST_FILE_NAME, relationship: 'Data', mimeType: 'application/json' },
    { op: 'remediate', profile: PDFA_PROFILE, language: 'pl-PL' },
  ]);

async function render(
  deps: ReportPdfDeps,
  input: { reportId: Id; runId?: Id; html: string; manifestJson: string },
): Promise<{ pdf: Uint8Array; residual: number }> {
  const form = new FormData();
  form.append('files', file(input.html, 'text/html'), 'index.html');
  form.append('files', file(input.manifestJson, 'application/json'), MANIFEST_FILE_NAME);
  form.append('stages', gotenbergStages());
  form.append('preferCssPageSize', 'true');
  form.append('printBackground', 'true');
  form.append('failOnResourceLoadingFailed', 'true');
  form.append('failOnConsoleExceptions', 'true');
  const { body, contentType } = await multipart(form);
  let response: EgressResponse;
  try {
    response = await deps.http.fetch({
      url: `${base(deps.config.gotenbergUrl)}/forms/chromium/convert/html`,
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      sourceId: PDF_SOURCES.gotenberg,
      purpose: 'report HTML to PDF/A-3b',
      containsIdentifier: true,
      ...(input.runId ? { runId: input.runId } : {}),
      timeoutMs: 60_000,
      persistBody: false,
    });
  } catch (error) {
    throw new PdfRenderError('gotenberg_unreachable', error instanceof Error ? error.message : String(error));
  }
  if (response.status !== 200) {
    throw new PdfRenderError('gotenberg_rejected', `HTTP ${response.status}: ${response.text().slice(0, 300)}`);
  }
  const residual = Number(headerOf(response, 'gotenberg-remediation-residual'));
  if (residual !== 0) {
    throw new PdfRenderError(
      'pdfa_residual',
      `remediation residual is ${headerOf(response, 'gotenberg-remediation-residual')}`,
    );
  }
  return { pdf: response.body, residual };
}

async function validate(deps: ReportPdfDeps, pdf: Uint8Array, runId?: Id): Promise<void> {
  const form = new FormData();
  form.append('files', file(new Uint8Array(pdf), PDF_MEDIA_TYPE), 'report.pdf');
  form.append('profile', PDFA_PROFILE);
  const { body, contentType } = await multipart(form);
  const response = await deps.http.fetch({
    url: `${base(deps.config.gotenbergUrl)}/forms/pdf/validate`,
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    sourceId: PDF_SOURCES.gotenberg,
    purpose: 'validate the report PDF/A-3b',
    containsIdentifier: true,
    ...(runId ? { runId } : {}),
    timeoutMs: 60_000,
    persistBody: false,
  });
  if (response.status !== 200) throw new PdfRenderError('pdfa_validation_failed', `HTTP ${response.status}`);
  const result = Object.values(response.json<Record<string, { compliant?: boolean; violations?: unknown[] }>>())[0];
  if (!result?.compliant || (result.violations?.length ?? 0) > 0) {
    throw new PdfRenderError('pdfa_not_compliant', `the PDF is not ${PDFA_PROFILE}`);
  }
}

interface Signed {
  pdf: Uint8Array;
  signerCertSha256: string;
  signedAt: string;
  timestamped: boolean;
  token?: Uint8Array;
}

class SigningFailure extends Error {}

async function signingCall<T>(
  deps: ReportPdfDeps,
  path: string,
  body: unknown,
  runId: Id | undefined,
  purpose: string,
): Promise<{ status: number; json: T }> {
  const url = deps.config.signingUrl;
  if (!url) throw new SigningFailure('the signing service URL is not configured');
  let response: EgressResponse;
  try {
    response = await deps.http.fetch({
      url: `${base(url)}${path}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      sourceId: PDF_SOURCES.signing,
      purpose,
      containsIdentifier: true,
      ...(runId ? { runId } : {}),
      timeoutMs: 60_000,
      persistBody: false,
    });
  } catch (error) {
    throw new SigningFailure(error instanceof Error ? error.message : String(error));
  }
  let json: T;
  try {
    json = response.json<T>();
  } catch {
    throw new SigningFailure(`signing service answered HTTP ${response.status} without JSON`);
  }
  return { status: response.status, json };
}

async function sign(deps: ReportPdfDeps, pdf: Uint8Array, input: { reportId: Id; runId?: Id }): Promise<Signed> {
  const prepared = await signingCall<{ sessionId?: string; signatureDigestSha256?: string; code?: string }>(
    deps,
    '/v1/pdf/sign/prepare',
    { pdfBase64: Buffer.from(pdf).toString('base64'), fieldName: SIGNATURE_FIELD, reason: SIGNATURE_REASON },
    input.runId,
    'prepare the PAdES signature',
  );
  const { sessionId, signatureDigestSha256: digest } = prepared.json;
  if (prepared.status !== 200 || !sessionId || !digest) {
    throw new SigningFailure(`prepare failed: HTTP ${prepared.status} ${prepared.json.code ?? ''}`.trim());
  }
  let token: Uint8Array | undefined;
  if (deps.timestamper && deps.config.timestampSignature !== false) {
    const outcome = await deps.timestamper.stamp({
      type: 'report_signature',
      id: input.reportId,
      digest,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    if (outcome.status === 'granted') token = outcome.tokenDer;
  }
  const finish = async (tokenDer: Uint8Array | undefined) =>
    signingCall<{
      pdfBase64?: string;
      signerCertSha256?: string;
      signedAt?: string;
      timestamped?: boolean;
      code?: string;
    }>(
      deps,
      '/v1/pdf/sign/finish',
      { sessionId, timestampTokenBase64: tokenDer ? Buffer.from(tokenDer).toString('base64') : null },
      input.runId,
      'finish the PAdES signature',
    );
  let result = await finish(token);
  if (result.status === 400 && token) {
    // The service keeps the session after a mismatching token: the signature is completed without a time-stamp (B-B).
    deps.logger?.warn('signature time-stamp token refused, signing without it', { reportId: input.reportId });
    token = undefined;
    result = await finish(undefined);
  }
  const { pdfBase64, signerCertSha256, signedAt } = result.json;
  if (result.status !== 200 || !pdfBase64 || !signerCertSha256 || !signedAt) {
    throw new SigningFailure(`finish failed: HTTP ${result.status} ${result.json.code ?? ''}`.trim());
  }
  return {
    pdf: new Uint8Array(Buffer.from(pdfBase64, 'base64')),
    signerCertSha256,
    signedAt,
    timestamped: result.json.timestamped === true && token !== undefined,
    ...(token ? { token } : {}),
  };
}

export async function renderReportPdf(
  input: { reportId: Id; runId?: Id; html: string; manifest: ReportManifest },
  deps: ReportPdfDeps,
): Promise<ReportPdfResult> {
  // Chromium never gets a document that references anything outside itself; checked before any request.
  assertSelfContainedHtml(input.html);
  const manifest = buildReportManifest(input.manifest);
  const manifestRef = await deps.blobs.put(new TextEncoder().encode(manifest.json), 'application/json');
  const rendered = await render(deps, { ...input, manifestJson: manifest.json });
  await validate(deps, rendered.pdf, input.runId);
  const pdfRef = await deps.blobs.put(rendered.pdf, PDF_MEDIA_TYPE);
  const result: ReportPdfResult = {
    status: 'unsigned',
    artifacts: [
      { kind: 'pdf', blob: pdfRef },
      { kind: 'manifest_json', blob: manifestRef },
    ],
    pdfa: { profile: PDFA_PROFILE, compliant: true, residual: rendered.residual },
    timestamp: null,
    warnings: [],
  };
  if (!deps.config.signing) {
    result.warnings.push('signing_disabled');
    return result;
  }
  let signed: Signed;
  try {
    signed = await sign(deps, rendered.pdf, input);
  } catch (error) {
    if (!(error instanceof SigningFailure)) throw error;
    deps.logger?.warn('report PDF left unsigned', { reportId: input.reportId, reason: error.message });
    result.warnings.push('signing_unavailable');
    return result;
  }
  const signedRef = await deps.blobs.put(signed.pdf, PDF_MEDIA_TYPE);
  result.artifacts.push({ kind: 'pdf_signed', blob: signedRef });
  result.signature = {
    signerCertSha256: signed.signerCertSha256,
    signedAt: signed.signedAt,
    timestamped: signed.timestamped,
  };
  if (signed.timestamped && signed.token) {
    result.status = 'signed_timestamped';
    const tokenRef = await deps.blobs.put(signed.token, 'application/timestamp-reply');
    result.artifacts.push({ kind: 'timestamp_reply', blob: tokenRef });
    return result;
  }
  result.status = 'signed';
  // PAdES B-B: the whole signed file is time-stamped instead (queued when the TSA cannot be reached, e.g. offline).
  if (deps.timestamper) {
    const outcome = await deps.timestamper.stamp({
      type: 'report_pdf',
      id: input.reportId,
      digest: sha256Of(signed.pdf),
      ...(input.runId ? { runId: input.runId } : {}),
    });
    result.timestamp = outcome;
    if (outcome.status === 'granted') {
      result.artifacts.push({ kind: 'timestamp_reply', blob: outcome.token.token });
    }
  }
  return result;
}
