import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { BlobRef } from './provenance.ts';
import type { SourceId } from './sources.ts';

export const CAPTURE_STATUSES = ['ok', 'not_found', 'blocked', 'login_wall', 'captcha', 'error'] as const;
/**
 * `blocked`, `login_wall` and `captcha` are NOT "not found": collection stops there (no evasion) and the
 * diff engine must not treat them as removals.
 */
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const ARTIFACT_KINDS = ['html', 'text', 'screenshot', 'json', 'headers', 'warc'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface CaptureArtifact {
  kind: ArtifactKind;
  blob: BlobRef;
}

/** RFC 3161 timestamp token over a capture manifest digest. */
export interface TimestampToken {
  tsaUrl: string;
  token: BlobRef;
  genTime: IsoDateTime;
  hashAlgorithm: 'sha256';
  messageImprint: Sha256Hex;
}

/**
 * A preserved copy of one fetched resource, with the Berkeley Protocol collection fields
 * (URL, source, full capture, collector, machine, synced time, hash at collection).
 */
export interface Capture {
  id: Id;
  runId: Id;
  sourceId: SourceId;
  url: string;
  finalUrl: string;
  collectedAt: IsoDateTime;
  /** Analyst or service account that ran the collection. */
  collector: string;
  collectorHost?: string;
  collectorIp?: string;
  /** False when the clock could not be verified against NTP at collection time. */
  clockSynced: boolean;
  toolVersion: string;
  userAgent: string;
  httpStatus: number;
  status: CaptureStatus;
  artifacts: CaptureArtifact[];
  /** SHA-256 of the canonical JSON manifest listing every artifact digest. */
  manifestSha256: Sha256Hex;
  timestamp?: TimestampToken;
  /** Provenance envelopes of the requests that produced this capture. */
  fetchIds: Id[];
  /** Set when the capture is an archived copy (e.g. a Wayback Machine snapshot). */
  archive?: { provider: 'wayback'; snapshotTimestamp: string; originalUrl: string };
}

export const ACCOUNT_DISCOVERY_METHODS = ['input', 'enumeration', 'cross_link', 'search', 'protocol_lookup'] as const;
export type AccountDiscoveryMethod = (typeof ACCOUNT_DISCOVERY_METHODS)[number];

/** An online account / profile that may or may not belong to the subject. */
export interface OnlineAccount {
  id: Id;
  runId: Id;
  /** e.g. `bitcointalk`, `github`, `keybase`, `farcaster`, `telegram`, `wykop`. */
  platform: string;
  handle: string;
  /** Stable platform id when available (numeric Bitcointalk uid, Farcaster FID, GitHub user id). */
  platformUserId?: string;
  profileUrl: string;
  displayName?: string;
  discoveredVia: { sourceId: SourceId; method: AccountDiscoveryMethod; captureId?: Id; fromAccountId?: Id };
}

/**
 * An atomic fact read from a capture, modelled on FollowTheMoney statements.
 * The diff engine compares observations across runs by (identity, platform, locator, property).
 */
export interface Observation {
  id: Id;
  runId: Id;
  captureId: Id;
  sourceId: SourceId;
  subject: { type: 'account' | 'address' | 'page'; key: string };
  /** Dotted property name, e.g. `profile.bitcoin_address`, `profile.link`, `post.address_mention`, `verification.eth_address`. */
  property: string;
  value: string;
  /** Stable position of the fact within the source, e.g. `bitcointalk:u=557798#profile.bitcoin_address`. */
  locator: string;
  observedAt: IsoDateTime;
}
