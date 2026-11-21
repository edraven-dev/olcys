/**
 * Ports: interfaces implemented by packages and wired together in apps/worker (the composition root).
 * Packages depend on these interfaces, never on each other's implementations, so they can be built in
 * parallel. Changing a port is a contract change (see AGENTS.md).
 */
import type { Valuation } from './analytics.ts';
import type { Identifier } from './case.ts';
import type { AddressSummary, NormalizedTransfer, UtxoTransaction } from './chain-data.ts';
import type { AddressRef, ChainId } from './chains.ts';
import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { AccountDiscoveryMethod, Capture, Observation, OnlineAccount } from './evidence.ts';
import type { AddressLabel } from './labels.ts';
import type { BlobRef, ChainTip, FetchMode, ProvenanceEnvelope } from './provenance.ts';
import type { SourceDescriptor, SourceId } from './sources.ts';

export interface Clock {
  now(): Date;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Content-addressed, immutable storage for raw bodies and capture artifacts. */
export interface BlobStore {
  put(bytes: Uint8Array, mediaType: string): Promise<BlobRef>;
  get(sha256: Sha256Hex): Promise<Uint8Array>;
  has(sha256: Sha256Hex): Promise<boolean>;
}

export interface EgressRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  sourceId: SourceId;
  /** Shown in the egress log, e.g. `bitcointalk profile lookup`. */
  purpose: string;
  /** Must be true whenever the URL, headers or body contain a case identifier. */
  containsIdentifier: boolean;
  runId?: Id;
  /** Query/header names to redact in logs and provenance (API keys, tokens). */
  secretParams?: string[];
  timeoutMs?: number;
  /** `manual` returns 3xx responses to the caller (each hop is still allow-listed); default `follow`. */
  redirect?: 'follow' | 'manual';
  /** False hashes the body but does not store it. Default true. */
  persistBody?: boolean;
}

export interface EgressResponse {
  status: number;
  /** URL after redirects. */
  finalUrl: string;
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
  provenance: ProvenanceEnvelope;
}

/** The ONLY way any package may talk to the network: allow-list, rate limits, logging, record/replay. */
export interface EgressClient {
  fetch(request: EgressRequest): Promise<EgressResponse>;
}

/** Everything a job needs, injected by the worker. */
export interface RunContext {
  runId: Id;
  caseId: Id;
  mode: FetchMode;
  http: EgressClient;
  blobs: BlobStore;
  clock: Clock;
  logger: Logger;
  signal?: AbortSignal;
}

export const PIVOT_VALUE_KINDS = ['username', 'url', 'nip', 'regon', 'krs'] as const;
export type PivotValueKind = (typeof PIVOT_VALUE_KINDS)[number];

/**
 * A value found during collection (or taken from a configured directory) that a collector can take as input, e.g. a
 * profile URL linked from another account or a nick to look up on another platform.
 */
export interface PivotValue {
  kind: PivotValueKind;
  value: string;
  /** How the value was found; `search` marks directory pages that must match a case identifier to be kept. */
  method?: AccountDiscoveryMethod;
  observationId?: Id;
  captureId?: Id;
}

export interface CollectorInput {
  identifiers: Identifier[];
  accounts: OnlineAccount[];
  addresses: AddressRef[];
  /** Pivot generation (0 = input identifiers). */
  depth: number;
  /** Values discovered by earlier tasks (linked URLs, nicks to probe, directory pages). */
  values?: PivotValue[];
}

export interface CollectorResult {
  status: 'ok' | 'partial' | 'not_found' | 'blocked' | 'login_wall' | 'captcha' | 'error';
  captures: Capture[];
  accounts: OnlineAccount[];
  observations: Observation[];
  notes: string[];
}

/** One OSINT source adapter (packages/collectors). */
export interface SourceCollector {
  readonly descriptor: SourceDescriptor;
  supports(input: CollectorInput): boolean;
  collect(input: CollectorInput, ctx: RunContext): Promise<CollectorResult>;
}

export interface TransferPage {
  items: NormalizedTransfer[];
  nextCursor?: string;
}

/** One blockchain data provider (packages/chain-adapters). Same interface for public APIs and self-hosted nodes. */
export interface ChainProvider {
  readonly id: string;
  readonly chains: readonly ChainId[];
  getTip(chain: ChainId, ctx: RunContext): Promise<ChainTip>;
  getAddressSummary(address: AddressRef, ctx: RunContext): Promise<AddressSummary>;
  listTransfers(
    address: AddressRef,
    options: { cursor?: string; fromBlock?: number; toBlock?: number; limit?: number },
    ctx: RunContext,
  ): Promise<TransferPage>;
  listUtxoTransactions?(
    address: AddressRef,
    options: { cursor?: string; limit?: number },
    ctx: RunContext,
  ): Promise<{ items: UtxoTransaction[]; nextCursor?: string }>;
  getCode?(address: AddressRef, ctx: RunContext): Promise<{ code: string; fetchId: Id }>;
}

/** Label lookup valid at a point in time (labels and PoR lists rotate). */
export interface LabelLookup {
  labelsFor(address: AddressRef, at?: IsoDateTime): Promise<AddressLabel[]>;
}

export interface FxRateSource {
  /** NBP Table A average rate of the last business day before `transactionAt`. */
  plnRate(currency: string, transactionAt: IsoDateTime, ctx: RunContext): Promise<Valuation['nbp']>;
}

export interface PriceSource {
  price(asset: string, quote: string, at: IsoDateTime): Promise<NonNullable<Valuation['price']>>;
}

export interface SearchQuery {
  text: string;
  exact: boolean;
  maxResults: number;
}

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
  rank: number;
  provider: string;
  fetchId: Id;
}

export interface SearchProvider {
  readonly id: string;
  search(query: SearchQuery, ctx: RunContext): Promise<SearchResult[]>;
}

export interface LlmRequest {
  /** e.g. `address-role-classification`. */
  task: string;
  promptVersion: string;
  system: string;
  /** Scraped/untrusted text: always passed delimited as data, never as instructions. */
  untrustedInput: string;
  /** JSON Schema the output must satisfy. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  runId?: Id;
}

export interface LlmResponse<T> {
  output: T;
  callId: Id;
  model: string;
  modelDigest?: string;
}

/** Any OpenAI-compatible endpoint; swapping models = changing base URL + model id. */
export interface LlmClient {
  complete<T>(request: LlmRequest): Promise<LlmResponse<T>>;
}
