import type {
  ArtifactKind,
  BlobRef,
  Capture,
  CaptureArtifact,
  CaptureDraft,
  CaptureManifest,
  CaptureProfile,
  CaptureRecorder,
  Id,
  RunContext,
  Sha256Hex,
} from '@olcys/core';
import { CAPTURE_MANIFEST_SCHEMA_ID, canonicalJson, CaptureManifestSchema, newId, parse } from '@olcys/core';
import type { ClockSyncCheck } from './clock-sync.ts';
import type { CollectorIdentity } from './collector-identity.ts';
import { readChecked } from './verify-capture.ts';

const MAX_REMEMBERED_RUNS = 8;

export const CAPTURE_MANIFEST_MEDIA_TYPE = 'application/vnd.olcys.capture-manifest+json';

/** A stored artifact is missing or does not hash to its digest: nothing is recorded. */
export class ArtifactIntegrityError extends Error {
  readonly sha256: Sha256Hex;
  constructor(sha256: Sha256Hex, reason: 'missing' | 'digest_mismatch') {
    super(`artifact ${sha256} ${reason === 'missing' ? 'is not in the blob store' : 'does not match its digest'}`);
    this.name = 'ArtifactIntegrityError';
    this.sha256 = sha256;
  }
}

/** Artifact kinds a complete capture of the profile has (a missing one is recorded, the capture is still kept). */
export function requiredArtifacts(profile: CaptureProfile): ArtifactKind[] {
  switch (profile) {
    case 'web_page':
      return ['html', 'screenshot'];
    case 'api_response':
      return ['headers', 'json'];
    case 'archive_snapshot':
      return ['html'];
  }
}

function missingKinds(profile: CaptureProfile, present: Set<ArtifactKind>): ArtifactKind[] {
  if (profile === 'api_response') {
    const body = ['json', 'html', 'text'].some((k) => present.has(k as ArtifactKind));
    return [...(present.has('headers') ? [] : (['headers'] as const)), ...(body ? [] : (['json'] as const))];
  }
  return requiredArtifacts(profile).filter((kind) => !present.has(kind));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The one place that turns collected bytes into an evidence record. It re-hashes artifacts that the egress client
 * already stored, stores the others, builds the canonical-JSON manifest (RFC 8785), stores it as a blob and returns a
 * `Capture` whose `manifestSha256` is that blob's digest. The collector identity, clock status and tool version are
 * set here; whatever a collector would claim about them is not accepted. Warnings go to the run's logger.
 */
export function createCaptureRecorder(options: {
  clockSync: ClockSyncCheck;
  collector: CollectorIdentity;
  toolVersion: string;
  gitCommit?: string;
  /** Id generator, replaceable in tests. */
  newId?: () => Id;
}): CaptureRecorder {
  const generateId = options.newId ?? (() => newId());
  // Missing-artifact warnings are logged once per run and kind set, not per capture. The recorder lives as long as the
  // process, so only the most recent runs are remembered.
  const warned = new Map<string, Set<string>>();

  return {
    async record(draft: CaptureDraft, ctx: RunContext): Promise<Capture> {
      const stored: { kind: ArtifactKind; description: string; ref: BlobRef }[] = [];
      for (const artifact of draft.artifacts) {
        if ('blob' in artifact) {
          // Sequential on purpose: one artifact in memory at a time.
          // oxlint-disable-next-line no-await-in-loop
          const check = await readChecked(ctx.blobs, artifact.blob.sha256);
          if (check.result !== 'ok') throw new ArtifactIntegrityError(artifact.blob.sha256, check.result);
          stored.push({ kind: artifact.kind, description: artifact.description, ref: artifact.blob });
        } else {
          // oxlint-disable-next-line no-await-in-loop
          const ref = await ctx.blobs.put(artifact.bytes, artifact.mediaType);
          stored.push({ kind: artifact.kind, description: artifact.description, ref });
        }
      }

      const clock = await options.clockSync.status();
      const required = requiredArtifacts(draft.profile);
      const missing = missingKinds(draft.profile, new Set(stored.map((a) => a.kind)));
      if (missing.length > 0) {
        const key = `${draft.profile}:${missing.join(',')}`;
        const seen = warned.get(ctx.runId) ?? new Set<string>();
        warned.delete(ctx.runId);
        warned.set(ctx.runId, seen);
        if (warned.size > MAX_REMEMBERED_RUNS) warned.delete(warned.keys().next().value!);
        if (!seen.has(key)) {
          seen.add(key);
          ctx.logger.warn('captures are missing required artifacts; kept as incomplete', {
            runId: ctx.runId,
            profile: draft.profile,
            missing,
          });
        }
      }

      const {
        software = [],
        transformations: technicalTransformations = [],
        ...technical
      } = draft.technical ?? {
        software: [],
        transformations: [],
      };
      const tools = unique(
        [
          { name: 'olcys', version: options.toolVersion },
          ...(options.gitCommit ? [{ name: 'olcys-git-commit', version: options.gitCommit }] : []),
          ...(draft.tools ?? []),
          ...software,
        ],
        (t) => `${t.name}\u0000${t.version}`,
      ).toSorted((a, b) => compare(a.name, b.name) || compare(a.version, b.version));

      const captureId = generateId();
      const manifest: CaptureManifest = {
        schema: CAPTURE_MANIFEST_SCHEMA_ID,
        captureId,
        caseId: ctx.caseId,
        runId: ctx.runId,
        sourceId: draft.sourceId,
        profile: draft.profile,
        mode: ctx.mode,
        userAgent: draft.userAgent,
        fetchIds: draft.fetchIds,
        collector: {
          name: options.collector.name,
          host: options.collector.host,
          ...(options.collector.ip ? { ip: options.collector.ip } : {}),
          ipSource: options.collector.ipSource,
          virtualIdentity: null,
        },
        time: {
          startedAt: draft.startedAt,
          collectedAt: draft.collectedAt,
          endedAt: draft.endedAt,
          hashedAt: ctx.clock.now().toISOString(),
          clock,
        },
        target: {
          url: draft.url,
          finalUrl: draft.finalUrl,
          httpStatus: draft.httpStatus,
          status: draft.status,
          ...(draft.serverIp ? { serverIp: draft.serverIp } : {}),
          responseHeaders: draft.responseHeaders ?? {},
        },
        tools,
        artifacts: stored
          .map((a) => ({
            kind: a.kind,
            sha256: a.ref.sha256,
            bytes: a.ref.bytes,
            mediaType: a.ref.mediaType,
            description: a.description,
          }))
          .toSorted((a, b) => compare(a.kind, b.kind) || compare(a.sha256, b.sha256)),
        completeness: { required, missing },
        transformations: unique([...draft.transformations, ...technicalTransformations], (t) => t),
        ...(draft.discovery ? { discovery: draft.discovery } : {}),
        ...(draft.archive ? { archive: draft.archive } : {}),
        ...(draft.technical ? { technical: technical as NonNullable<CaptureManifest['technical']> } : {}),
      };
      parse(CaptureManifestSchema, JSON.parse(canonicalJson(manifest)));

      const ref = await ctx.blobs.put(new TextEncoder().encode(canonicalJson(manifest)), CAPTURE_MANIFEST_MEDIA_TYPE);
      const artifacts: CaptureArtifact[] = stored.map((a) => ({ kind: a.kind, blob: a.ref }));
      return {
        id: captureId,
        runId: ctx.runId,
        sourceId: draft.sourceId,
        url: draft.url,
        finalUrl: draft.finalUrl,
        collectedAt: draft.collectedAt,
        collector: options.collector.name,
        collectorHost: options.collector.host,
        ...(options.collector.ip ? { collectorIp: options.collector.ip } : {}),
        clockSynced: clock.synced,
        toolVersion: options.toolVersion,
        userAgent: draft.userAgent,
        httpStatus: draft.httpStatus,
        status: draft.status,
        artifacts,
        manifestSha256: ref.sha256,
        fetchIds: draft.fetchIds,
        ...(draft.archive
          ? {
              archive: {
                provider: draft.archive.provider,
                snapshotTimestamp: draft.archive.snapshotTimestamp,
                originalUrl: draft.archive.originalUrl,
              },
            }
          : {}),
        ...(draft.technical ? { technical: draft.technical } : {}),
      };
    },
  };
}
