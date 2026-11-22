/**
 * @olcys/evidence — content-addressed blob store, hashing and run-to-run comparison (diff).
 */
export { canonicalJson } from '@olcys/core';
export { BlobIntegrityError, BlobNotFoundError, FileBlobStore, InMemoryBlobStore, sha256Hex } from './blob-store.ts';
export {
  diffRuns,
  DIFF_VERSION,
  isWalletProperty,
  SUPPRESSION_REASONS,
  type ChangeEventDraft,
  type RunDiff,
  type RunSnapshot,
  type SuppressionReason,
} from './diff.ts';
export {
  ArtifactIntegrityError,
  CAPTURE_MANIFEST_MEDIA_TYPE,
  createCaptureRecorder,
  requiredArtifacts,
} from './capture-manifest.ts';
export { createClockSyncCheck, injectedClockSync, type ClockSyncCheck } from './clock-sync.ts';
export { READ_ME_FILE, writeCollectionPackage } from './collection-package.ts';
export { readDefaultRouteInterface, resolveCollectorIdentity, type CollectorIdentity } from './collector-identity.ts';
export { custodyCollected } from './custody.ts';
export { readManifest, verifyCapture, type CaptureVerification } from './verify-capture.ts';
