/**
 * Builds the `Capture` record of one fetched resource: the body exactly as received (the provenance envelope's blob,
 * so its SHA-256 is the hash at collection), the response headers as canonical JSON, collector identity, every fetch
 * of the redirect chain and a SHA-256 manifest over all of it. One module, so a sealing recorder can replace it.
 */
import { createHash } from 'node:crypto';
import type {
  ArtifactKind,
  Capture,
  CaptureArtifact,
  CaptureStatus,
  CaptureTechnicalReport,
  EgressResponse,
  Id,
  RunContext,
  SourceDescriptor,
} from '@olcys/core';
import { canonicalJson, newId } from '@olcys/core';
import type { CollectorConfig } from './config.ts';

export const CAPTURE_MANIFEST_SCHEMA = 'olcys.capture-manifest.v1';

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function artifactKindFor(contentType: string): ArtifactKind {
  if (/html|xml/i.test(contentType)) return 'html';
  if (/json/i.test(contentType)) return 'json';
  return 'text';
}

/** SHA-256 of the canonical JSON manifest of a capture (every field except the digest itself). */
export function captureManifestSha256(capture: Omit<Capture, 'manifestSha256'>): string {
  return sha256Hex(canonicalJson({ schema: CAPTURE_MANIFEST_SCHEMA, ...capture }));
}

export async function buildCapture(args: {
  ctx: RunContext;
  descriptor: SourceDescriptor;
  config: CollectorConfig;
  /** Final response of the redirect chain. */
  response: EgressResponse;
  /** First URL requested (the fixture URL offline). */
  requestedUrl: string;
  finalUrl: string;
  fetchIds: Id[];
  status: CaptureStatus;
  technical: CaptureTechnicalReport;
}): Promise<Capture> {
  const { ctx, response, config } = args;
  const headersJson = canonicalJson({ status: response.status, headers: response.headers });
  const headersBlob = await ctx.blobs.put(new TextEncoder().encode(headersJson), 'application/json');
  const artifacts: CaptureArtifact[] = [
    { kind: artifactKindFor(response.headers['content-type'] ?? ''), blob: response.provenance.body },
    { kind: 'headers', blob: headersBlob },
  ];
  const capture: Omit<Capture, 'manifestSha256'> = {
    id: newId(),
    runId: ctx.runId,
    sourceId: args.descriptor.id,
    url: args.requestedUrl,
    finalUrl: args.finalUrl,
    collectedAt: response.provenance.receivedAt,
    collector: config.collectorName,
    ...(config.collectorHost ? { collectorHost: config.collectorHost } : {}),
    clockSynced: config.clockSynced,
    toolVersion: response.provenance.toolVersion,
    userAgent: response.provenance.userAgent,
    httpStatus: response.status,
    status: args.status,
    artifacts,
    fetchIds: args.fetchIds,
    technical: args.technical,
  };
  return { ...capture, manifestSha256: captureManifestSha256(capture) };
}
