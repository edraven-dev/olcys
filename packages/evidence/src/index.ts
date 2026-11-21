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
