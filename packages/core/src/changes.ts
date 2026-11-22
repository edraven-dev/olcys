import type { Id, IsoDateTime } from './common.ts';
import type { CaptureStatus } from './evidence.ts';

/** Run-to-run differences. VALUE_CHANGED on a wallet property is the "wallet swapped" alert. */
export const CHANGE_KINDS = ['ADDED', 'REMOVED', 'VALUE_CHANGED', 'SCORE_CHANGED'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeEvent {
  id: Id;
  runId: Id;
  previousRunId: Id;
  kind: ChangeKind;
  key: { identityId?: Id; platform: string; locator: string; property: string };
  before?: string;
  after?: string;
  beforeCaptureId?: Id;
  afterCaptureId?: Id;
  scoreBefore?: number;
  scoreAfter?: number;
  /** For SCORE_CHANGED: whether data, the algorithm version, or both changed. */
  cause?: 'data' | 'algorithm' | 'both';
  detectedAt: IsoDateTime;
}

// --- history timeline: live runs and archived copies of one page or property -----------------------------------------

/**
 * Why a timeline point carries no value: the page could not be read (never a removal), the copy is untrusted, or the
 * addresses were not extracted from it yet (`extraction_pending`: no extraction result exists for the capture).
 */
export type TimelineGapReason = CaptureStatus | 'not_fetched' | 'digest_mismatch' | 'extraction_pending';

export interface TimelinePoint {
  /** Archive: the snapshot time the archive reports; live: when the capture was collected. */
  observedAt: IsoDateTime;
  /** Sorted; `[]` = page read, nothing found; `null` = gap (no statement about the page at this time). */
  values: string[] | null;
  captureId?: Id;
  runId?: Id;
  provenance: 'live' | 'archive';
  gapReason?: TimelineGapReason;
  archive?: {
    snapshotTimestamp: string;
    digest: string;
    /** True when the values were taken from another snapshot with the same content digest (identical bytes). */
    inferredFromDigest: boolean;
    /** When OŁCyŚ retrieved the copy (not the time the archive says the page looked like this). */
    collectedAt?: IsoDateTime;
  };
}

/** Consecutive points (gaps skipped) with the same value set. */
export interface TimelineInterval {
  values: string[];
  from: TimelinePoint;
  to: TimelinePoint;
}

/** The value set changed somewhere between `lastSeenBefore` and `firstSeenAfter` (the bracket). */
export interface TimelineChange {
  before: string[];
  after: string[];
  lastSeenBefore: TimelinePoint;
  firstSeenAfter: TimelinePoint;
  /** Address-valued property: a wallet swap. */
  wallet: boolean;
}

export interface PropertyTimeline {
  key: ChangeEvent['key'];
  points: TimelinePoint[];
  intervals: TimelineInterval[];
  changes: TimelineChange[];
}
