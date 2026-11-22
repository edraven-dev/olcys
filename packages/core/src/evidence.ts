import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { BlobRef, FetchMode } from './provenance.ts';
import type { SourceId } from './sources.ts';

export const CAPTURE_STATUSES = ['ok', 'not_found', 'blocked', 'login_wall', 'captcha', 'error'] as const;
/**
 * `blocked`, `login_wall` and `captcha` are NOT "not found": collection stops there (no evasion) and the
 * diff engine must not treat them as removals.
 */
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * `html` is the response body exactly as received; `rendered_html` is the DOM serialised by a browser after load and
 * `screenshot` a full-page image (both produced only by a browser capture, which this deployment does not enable).
 */
export const ARTIFACT_KINDS = ['html', 'rendered_html', 'text', 'screenshot', 'json', 'headers', 'warc'] as const;
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
 * How a capture was made (Berkeley Protocol Annex IV "services used", ¶154 transformations): the request chain, the
 * robots.txt decision, access-barrier signals and the software that produced the artifacts.
 */
export interface CaptureTechnicalReport {
  method: 'http' | 'browser';
  startedAt: IsoDateTime;
  /** Live URL the request stands for when it was served by the synthetic fixture site (offline mode). */
  logicalUrl?: string;
  /** Every hop before the final response (manual redirect following). */
  redirects: { url: string; status: number }[];
  robots?: { allowed: boolean; robotsUrl: string; reason?: string };
  /** Signals that classified the response as a block, login wall or CAPTCHA (collection stopped there). */
  barrier?: { status: CaptureStatus; signals: string[] };
  /**
   * Secrets removed before storage: how many and of which kinds (never their values), and the SHA-256 of the body as
   * received (from the provenance envelope), which differs from the stored artifact when something was redacted.
   */
  redaction?: { secrets: number; kinds: string[]; originalSha256: Sha256Hex };
  /** Tools and parser versions, e.g. `{ name: 'parser:bitcointalk', version: 'smf1.v1' }`. */
  software: { name: string; version: string }[];
  /** Transformations applied to derive artifacts or observations, e.g. `charset decode (utf-8)`. */
  transformations: string[];
  notes: string[];
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
  /** How the capture was made (redirects, robots.txt, barrier signals, logical URL, software). */
  technical?: CaptureTechnicalReport;
}

const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * Snapshot time of an archived copy as the Wayback Machine writes it: `20240101123456` → `2024-01-01T12:34:56.000Z`.
 * Only the full 14-digit form is accepted.
 */
export function waybackTimestampToIso(timestamp: string): IsoDateTime {
  const m = TIMESTAMP.exec(timestamp);
  if (!m) throw new Error(`not a 14-digit Wayback timestamp: ${timestamp}`);
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error(`not a valid Wayback timestamp: ${timestamp}`);
  }
  return date.toISOString();
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
  /** The capture that actually read the account's profile page (`discoveredVia.captureId` may name a page that linked to it). */
  profileCaptureId?: Id;
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

// --- Berkeley Protocol capture records ---------------------------------------------------------------------------

export const CAPTURE_PROFILES = ['web_page', 'api_response', 'archive_snapshot'] as const;
/** What kind of resource a capture preserves; decides which artifacts are required (completeness). */
export type CaptureProfile = (typeof CAPTURE_PROFILES)[number];

export const CLOCK_SYNC_METHODS = ['chrony', 'timedatectl', 'timesyncd_marker', 'injected', 'unknown'] as const;
export type ClockSyncMethod = (typeof CLOCK_SYNC_METHODS)[number];

/** Whether the collecting machine's clock was disciplined by NTP, from local OS state only (never from the network). */
export interface ClockSyncStatus {
  synced: boolean;
  method: ClockSyncMethod;
  source?: string;
  /** System-time offset in milliseconds when the method reports it. */
  offsetMs?: number;
  checkedAt: IsoDateTime;
}

export const CAPTURE_MANIFEST_SCHEMA_ID = 'olcys.capture-manifest/1' as const;

/**
 * The capture manifest (Berkeley Protocol ¶155 and Annex IV collection form): canonical JSON stored as a blob, whose
 * SHA-256 is `Capture.manifestSha256`. Contains the analyst name and machine IP: never log it.
 */
export interface CaptureManifest {
  schema: typeof CAPTURE_MANIFEST_SCHEMA_ID;
  captureId: Id;
  caseId: Id;
  runId: Id;
  sourceId: SourceId;
  profile: CaptureProfile;
  mode: FetchMode;
  userAgent: string;
  fetchIds: Id[];
  collector: {
    name: string;
    host: string;
    ip?: string;
    ipSource: 'configured' | 'local_interface' | 'unknown';
    /** Always null: no virtual identity (sock-puppet account) is ever used. */
    virtualIdentity: null;
  };
  time: {
    startedAt: IsoDateTime;
    collectedAt: IsoDateTime;
    endedAt: IsoDateTime;
    hashedAt: IsoDateTime;
    clock: ClockSyncStatus;
  };
  target: {
    url: string;
    finalUrl: string;
    httpStatus: number;
    status: CaptureStatus;
    serverIp?: string;
    responseHeaders: Record<string, string>;
  };
  tools: { name: string; version: string }[];
  artifacts: { kind: ArtifactKind; sha256: Sha256Hex; bytes: number; mediaType: string; description: string }[];
  completeness: { required: ArtifactKind[]; missing: ArtifactKind[] };
  /** Berkeley Protocol ¶154: conversions made by the collection process. */
  transformations: string[];
  discovery?: {
    method: AccountDiscoveryMethod;
    fromAccountId?: Id;
    searchProvider?: string;
    query?: string;
    rank?: number;
  };
  archive?: {
    provider: 'wayback';
    snapshotTimestamp: string;
    originalUrl: string;
    replayUrl?: string;
    cdxDigest?: string;
  };
  technical?: Omit<CaptureTechnicalReport, 'software' | 'transformations'>;
}

/** An artifact handed to the recorder: raw bytes, or a blob the egress client already stored (re-hashed on record). */
export type CaptureDraftArtifact = { kind: ArtifactKind; description: string } & (
  | { bytes: Uint8Array; mediaType: string }
  | { blob: BlobRef }
);

/** What a collector knows about a capture; the recorder adds identity, clock, tool version, ids and the manifest. */
export interface CaptureDraft extends Pick<
  CaptureManifest,
  'sourceId' | 'profile' | 'userAgent' | 'fetchIds' | 'discovery' | 'archive'
> {
  url: string;
  finalUrl: string;
  startedAt: IsoDateTime;
  collectedAt: IsoDateTime;
  endedAt: IsoDateTime;
  httpStatus: number;
  status: CaptureStatus;
  serverIp?: string;
  responseHeaders?: Record<string, string>;
  artifacts: CaptureDraftArtifact[];
  transformations: string[];
  tools?: { name: string; version: string }[];
  technical?: CaptureTechnicalReport;
}

export const CUSTODY_ACTIONS = [
  'collected',
  'timestamped',
  'timestamp_failed',
  'verified',
  'verification_failed',
  'included_in_report',
  'exported',
  'viewed',
] as const;
export type CustodyAction = (typeof CUSTODY_ACTIONS)[number];

/** One append-only chain-of-custody entry about a capture or report. */
export interface CustodyEvent {
  id: Id;
  at: IsoDateTime;
  actor: string;
  action: CustodyAction;
  runId?: Id;
  subject: { type: 'capture' | 'report' | 'report_artifact'; id: Id };
  detail: Record<string, string | number | boolean>;
}
