/**
 * Hands one fetched resource to the capture recorder (`ctx.evidence`), which stores the artifacts and the capture
 * manifest and returns the `Capture`: the body as stored by the egress client (as received, or with secrets redacted;
 * the technical report then keeps the original hash) and the response headers as canonical JSON. Collectors never
 * compute manifests, collector identity or clock status themselves.
 */
import { createHash } from 'node:crypto';
import type {
  ArtifactKind,
  BlobRef,
  Capture,
  CaptureDraft,
  CaptureProfile,
  CaptureStatus,
  CaptureTechnicalReport,
  EgressResponse,
  Id,
  RunContext,
  SourceDescriptor,
} from '@olcys/core';
import { canonicalJson } from '@olcys/core';
import type { CollectorConfig } from './config.ts';

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function artifactKindFor(contentType: string): ArtifactKind {
  if (/html|xml/i.test(contentType)) return 'html';
  if (/json/i.test(contentType)) return 'json';
  return 'text';
}

const BODY_DESCRIPTIONS: Partial<Record<ArtifactKind, string>> = {
  html: 'HTTP response body as stored (as received unless secrets were redacted)',
  json: 'HTTP response body (JSON) as stored',
  text: 'HTTP response body (text) as stored',
};

export async function buildCapture(args: {
  ctx: RunContext;
  descriptor: SourceDescriptor;
  config: CollectorConfig;
  /** Final response of the redirect chain. */
  response: EgressResponse;
  /** The stored body (redacted when secrets were found; the provenance envelope keeps the original hash). */
  body: BlobRef;
  /** First URL requested (the fixture URL offline). */
  requestedUrl: string;
  finalUrl: string;
  fetchIds: Id[];
  status: CaptureStatus;
  technical: CaptureTechnicalReport;
}): Promise<Capture> {
  const { ctx, response } = args;
  if (!ctx.evidence) throw new Error('RunContext.evidence (the capture recorder) is not configured');
  const bodyKind = artifactKindFor(response.headers['content-type'] ?? '');
  // Plain HTTP collection: JSON endpoints are API responses, everything else a web page (without browser artifacts).
  const profile: CaptureProfile = bodyKind === 'json' ? 'api_response' : 'web_page';
  const endedAt = ctx.clock.now().toISOString();
  const received = response.provenance.receivedAt;
  const draft: CaptureDraft = {
    sourceId: args.descriptor.id,
    profile,
    userAgent: response.provenance.userAgent,
    fetchIds: args.fetchIds,
    url: args.requestedUrl,
    finalUrl: args.finalUrl,
    startedAt: args.technical.startedAt,
    collectedAt: received,
    endedAt: endedAt > received ? endedAt : received,
    httpStatus: response.status,
    status: args.status,
    ...(response.provenance.remoteAddress ? { serverIp: response.provenance.remoteAddress } : {}),
    responseHeaders: response.headers,
    artifacts: [
      { kind: bodyKind, blob: args.body, description: BODY_DESCRIPTIONS[bodyKind] ?? 'HTTP response body' },
      {
        kind: 'headers',
        bytes: new TextEncoder().encode(canonicalJson({ status: response.status, headers: response.headers })),
        mediaType: 'application/json',
        description: 'HTTP status and kept response headers (canonical JSON)',
      },
    ],
    transformations: args.technical.transformations,
    technical: args.technical,
  };
  return ctx.evidence.record(draft, ctx);
}
