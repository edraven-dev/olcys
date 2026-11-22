/**
 * Shared parts of the three registry collectors: one JSON request through the source's HTTP facade turned into a
 * capture (the answer as received, hash and headers sealed by `buildCapture`), status mapping and small readers for
 * loosely typed registry JSON. Official APIs under their published terms: no robots.txt fetch, no redirects followed,
 * quota errors are never retried (a 429 stops the source for the run).
 */
import type { Capture, CaptureStatus, CaptureTechnicalReport, EgressResponse, Id } from '@olcys/core';
import { nowIso } from '@olcys/core';
import { buildCapture } from '../framework/capture.ts';
import { COLLECTORS_VERSION } from '../framework/config.ts';
import { NoFixtureError } from '../framework/errors.ts';
import type { SourceHttp } from '../framework/http.ts';
import { isBarrierStatus, note, statusFromHttp, type NoteCode } from '../framework/status.ts';
import { providerFetch } from '../search/provider.ts';

export const REGISTRY_ACCEPT = 'application/json';

export interface RegistryRequest {
  /** Live URL; mapped to the fixture site offline. */
  url: string;
  purpose: string;
  headers?: Record<string, string>;
  /** Header or query names kept out of logs, provenance and recordings. */
  secretParams?: string[];
  software: { name: string; version: string }[];
  /** Note for a 2xx answer that is not JSON (default: `unrecognised_markup`). */
  notJsonNote?: { code: 'fetch_error' | 'unrecognised_markup'; detail: string };
  /**
   * Overrides the status of a parsed answer, whatever its HTTP status (an empty result list is "not found", a documented
   * quota error is "blocked"). `code` defaults to `not_found` / `unrecognised_markup` by status.
   */
  classify?: (
    json: unknown,
    httpStatus: number,
  ) => { status: CaptureStatus; reason: string; code?: NoteCode } | undefined;
}

export interface RegistryAnswer {
  status: CaptureStatus;
  capture?: Capture;
  httpStatus?: number;
  contentType: string;
  /** Parsed body; undefined when the answer is not JSON (an HTML maintenance page, an empty body). */
  json?: unknown;
  /** True for a 2xx answer that is not JSON. */
  notJson: boolean;
  notes: string[];
}

/** HTTP status → capture status; 204 (CEIDG: nothing found) is "not found", not success. */
function captureStatusFor(httpStatus: number): CaptureStatus {
  return httpStatus === 204 ? 'not_found' : statusFromHttp(httpStatus);
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

const failed = (status: CaptureStatus, text: string): RegistryAnswer => ({
  status,
  contentType: '',
  notJson: false,
  notes: [text],
});

export async function registryFetch(http: SourceHttp, request: RegistryRequest): Promise<RegistryAnswer> {
  const startedAt = nowIso(http.ctx.clock);
  const stop = http.stopped();
  if (stop) return failed(stop.status, note('source_stopped', `${stop.status}: ${stop.reason}`));
  let url: string;
  try {
    url = http.requestUrl(request.url);
  } catch (error) {
    if (error instanceof NoFixtureError) return failed('error', note('no_fixture_for_host', error.host));
    throw error;
  }
  if (!http.hostAllowed(url)) {
    return failed(
      'blocked',
      note('allow_list_denied', `${new URL(url).hostname} is not allowed for ${http.descriptor.id}`),
    );
  }
  const fetched = await providerFetch(
    { ...http.ctx, http: { fetch: (r) => http.fetch(r) } },
    {
      url,
      redirect: 'manual',
      // The body is stored below (redacted when needed); the egress client keeps only its hash.
      persistBody: false,
      headers: { accept: REGISTRY_ACCEPT, ...request.headers },
      ...(request.secretParams ? { secretParams: request.secretParams } : {}),
      sourceId: http.descriptor.id,
      purpose: request.purpose,
      // Names and tax identifiers are case identifiers.
      containsIdentifier: true,
    },
  );
  if ('failure' in fetched) return failed('error', fetched.failure);
  const response: EgressResponse = fetched.response;

  const contentType = response.headers['content-type'] ?? '';
  const raw = new TextDecoder('utf-8').decode(response.body);
  const redaction = http.deps.redactor.redact(raw);
  const secretKinds = [...new Set(redaction.findings.map((f) => f.kind))].toSorted();
  const mediaType = contentType || 'application/octet-stream';
  const stored = redaction.findings.length
    ? await http.ctx.blobs.put(
        new TextEncoder().encode(redaction.text),
        `${mediaType.split(';')[0]?.trim()}; charset=utf-8`,
      )
    : await http.ctx.blobs.put(response.body, mediaType);

  const notes: string[] = [];
  let status = captureStatusFor(response.status);
  const parsed = response.body.byteLength && !/html/i.test(contentType) ? parseJson(redaction.text) : undefined;
  const notJson = status === 'ok' && parsed === undefined;
  if (notJson) {
    status = 'error';
    const { code, detail } = request.notJsonNote ?? { code: 'unrecognised_markup', detail: 'the answer is not JSON' };
    notes.push(note(code, detail));
  }
  const verdict = parsed ? request.classify?.(parsed.value, response.status) : undefined;
  if (verdict) {
    status = verdict.status;
    notes.push(note(verdict.code ?? (status === 'not_found' ? 'not_found' : 'unrecognised_markup'), verdict.reason));
  }
  if (isBarrierStatus(status)) {
    http.stop(status, `HTTP ${response.status}`);
    notes.push(note(`barrier_${status}`, `${http.logicalUrl(url)}: HTTP ${response.status}`));
    if (response.status === 429)
      notes.push(note('rate_limited', `retry-after ${response.headers['retry-after'] ?? '?'}`));
  }
  const logicalUrl = http.logicalUrl(url);
  const technical: CaptureTechnicalReport = {
    method: 'http',
    startedAt,
    ...(logicalUrl !== url ? { logicalUrl } : {}),
    redirects: [],
    ...(isBarrierStatus(status) ? { barrier: { status, signals: [`HTTP ${response.status}`] } } : {}),
    redaction: {
      secrets: redaction.findings.length,
      kinds: secretKinds,
      originalSha256: response.provenance.body.sha256,
    },
    software: [{ name: '@olcys/collectors', version: COLLECTORS_VERSION }, ...request.software],
    transformations: [
      redaction.findings.length
        ? `${redaction.findings.length} secret(s) redacted in memory (${secretKinds.join(', ')})`
        : 'official API answer stored as received (JSON); observations are read from it by field path',
      'headers artifact: canonical JSON of the HTTP status and the kept response headers',
    ],
    notes,
  };
  const fetchIds: Id[] = [response.provenance.fetchId];
  const capture = await buildCapture({
    ctx: http.ctx,
    descriptor: http.descriptor,
    config: http.deps.config,
    response,
    body: stored,
    requestedUrl: url,
    finalUrl: response.finalUrl || url,
    fetchIds,
    status,
    technical,
  });
  return {
    status,
    capture,
    httpStatus: response.status,
    contentType,
    ...(parsed ? { json: parsed.value } : {}),
    notJson,
    notes,
  };
}

/** Loosely typed JSON access: the registries' shapes are read defensively, a missing field is simply absent. */
export type Json = Record<string, unknown>;

export function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty string, or a number as a string; anything else is undefined. */
export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function joinText(parts: readonly (string | undefined)[], separator = ' '): string | undefined {
  const text = parts.filter((p): p is string => !!p).join(separator);
  return text || undefined;
}
