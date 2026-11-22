import type { ArtifactKind, BlobStore, CaptureManifest, Sha256Hex } from '@olcys/core';
import { CaptureManifestSchema } from '@olcys/core';
import { BlobIntegrityError, BlobNotFoundError, sha256Hex } from './blob-store.ts';

export interface CaptureVerification {
  ok: boolean;
  manifest: 'ok' | 'missing' | 'digest_mismatch' | 'schema_invalid';
  artifacts: { kind: ArtifactKind; sha256: Sha256Hex; result: 'ok' | 'missing' | 'digest_mismatch' }[];
}

export type BlobCheck = { result: 'ok'; bytes: Uint8Array } | { result: 'missing' | 'digest_mismatch' };

/** Reads a blob and checks its digest; only "not found" and "integrity" failures are results, any other error is thrown. */
export async function readChecked(blobs: BlobStore, sha256: Sha256Hex): Promise<BlobCheck> {
  try {
    const bytes = await blobs.get(sha256);
    return sha256Hex(bytes) === sha256 ? { result: 'ok', bytes } : { result: 'digest_mismatch' };
  } catch (error) {
    if (error instanceof BlobIntegrityError) return { result: 'digest_mismatch' };
    if (error instanceof BlobNotFoundError) return { result: 'missing' };
    throw error;
  }
}

/** Reads a manifest blob and returns it validated, or why it cannot be used. */
export async function readManifest(
  manifestSha256: Sha256Hex,
  blobs: BlobStore,
): Promise<
  { manifest: CaptureManifest; bytes: Uint8Array } | { problem: 'missing' | 'digest_mismatch' | 'schema_invalid' }
> {
  const read = await readChecked(blobs, manifestSha256);
  if (read.result !== 'ok') return { problem: read.result };
  const parsed = CaptureManifestSchema.safeParse(safeJson(read.bytes));
  return parsed.success ? { manifest: parsed.data, bytes: read.bytes } : { problem: 'schema_invalid' };
}

function safeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Re-checks a capture from its manifest digest: the manifest blob hashes to the digest and is valid, and every
 * artifact it lists is present and hashes to its recorded digest.
 */
export async function verifyCapture(manifestSha256: Sha256Hex, blobs: BlobStore): Promise<CaptureVerification> {
  const loaded = await readManifest(manifestSha256, blobs);
  if ('problem' in loaded) return { ok: false, manifest: loaded.problem, artifacts: [] };
  const artifacts: CaptureVerification['artifacts'] = [];
  for (const artifact of loaded.manifest.artifacts) {
    // oxlint-disable-next-line no-await-in-loop
    const check = await readChecked(blobs, artifact.sha256);
    artifacts.push({ kind: artifact.kind, sha256: artifact.sha256, result: check.result });
  }
  return { ok: artifacts.every((a) => a.result === 'ok'), manifest: 'ok', artifacts };
}
