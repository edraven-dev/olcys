import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { SourceId } from './sources.ts';

/**
 * offline  no outbound network at all (fixture site only)
 * replay   every outbound request is served from recorded cassettes; a miss is an error
 * live     real network, restricted to the egress allow-list
 */
export const FETCH_MODES = ['live', 'replay', 'offline'] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

/** Reference to immutable bytes in the content-addressed blob store. */
export interface BlobRef {
  sha256: Sha256Hex;
  bytes: number;
  mediaType: string;
}

export interface ChainTip {
  height: number;
  hash: string;
  observedAt: IsoDateTime;
}

/**
 * Attached to every response obtained from outside the system (web page, API call, chain data).
 * With it, any fetch can be replayed and later re-verified (e.g. against a self-hosted node at `chainTip`).
 */
export interface ProvenanceEnvelope {
  fetchId: Id;
  runId?: Id;
  sourceId: SourceId;
  /** Human-readable provider, e.g. `mempool.space`, `etherscan-v2`, `bitcointalk.org`. */
  provider: string;
  method: 'GET' | 'POST';
  /** Full URL with API keys and other secret parameters redacted. */
  url: string;
  requestedAt: IsoDateTime;
  receivedAt: IsoDateTime;
  httpStatus: number;
  /** Selected response headers (content-type, etag, last-modified, date, retry-after). */
  responseHeaders: Record<string, string>;
  /** Raw response body as stored. */
  body: BlobRef;
  mode: FetchMode;
  toolVersion: string;
  userAgent: string;
  apiVersion?: string;
  chainTip?: ChainTip;
  pagination?: { page?: number; cursor?: string; nextCursor?: string };
  egressLogId: Id;
  /** Peer IP address of the server (Berkeley Protocol Annex IV), when known. */
  remoteAddress?: string;
  /** False when the body was hashed but deliberately not stored (restrictive terms, tokens). */
  bodyPersisted?: boolean;
  /** Set when the response is synthetic demo data (e.g. generated chain history). */
  synthetic?: boolean;
  /** Set when the response comes from a local sandbox chain. */
  sandbox?: boolean;
}

/** One row per outbound request attempt, allowed or denied. Shown to the analyst. */
export interface EgressLogEntry {
  id: Id;
  runId?: Id;
  sourceId: SourceId;
  host: string;
  method: 'GET' | 'POST';
  urlRedacted: string;
  purpose: string;
  /** True when the request disclosed a case identifier (nick, e-mail, address, ...) to the host. */
  containsIdentifier: boolean;
  allowed: boolean;
  denyReason?: string;
  mode: FetchMode;
  at: IsoDateTime;
  httpStatus?: number;
  bytes?: number;
}
