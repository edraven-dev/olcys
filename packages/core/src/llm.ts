/**
 * AI model contracts. The model only suggests: nothing here feeds the score until an analyst confirms a suggestion,
 * and even then only a later rescore may take it into account. Any OpenAI-compatible endpoint works (base URL + model).
 */
import type { BlobRef } from './provenance.ts';
import type { Id, IsoDateTime, Sha256Hex } from './common.ts';
import type { SourceId } from './sources.ts';

export const LLM_FAILURE_CODES = [
  'disabled',
  'input_rejected',
  'egress_denied',
  'timeout',
  'http_error',
  'invalid_json',
  'schema_violation',
] as const;
export type LlmFailureCode = (typeof LLM_FAILURE_CODES)[number];

/** Outcome of one logged model call. */
export const LLM_OUTCOMES = ['ok', ...LLM_FAILURE_CODES] as const;
export type LlmOutcome = (typeof LLM_OUTCOMES)[number];

export interface LlmRequest<T = unknown> {
  /** e.g. `address-role-classification`. */
  task: string;
  promptVersion: string;
  /** SHA-256 of the registered prompt definition (see `@olcys/llm` prompt registry). */
  promptSha256: Sha256Hex;
  system: string;
  /** Scraped/untrusted text: always passed delimited as data, never as instructions. */
  untrustedInput: string;
  /** The captures and sources the input text comes from; one with `llmAllowed: false` rejects the request. */
  inputs: { captureId?: Id; sourceId: SourceId; llmAllowed: boolean }[];
  /** JSON Schema the output must satisfy. */
  jsonSchema: Record<string, unknown>;
  /** Validates the parsed output; throws on a violation. */
  parseOutput(value: unknown): T;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  /** Longer `untrustedInput` is rejected (`input_rejected`), never truncated. */
  maxInputChars?: number;
  /** True whenever the input text contains a case identifier (recorded in the egress log). */
  containsIdentifier: boolean;
  runId?: Id;
  caseId?: Id;
}

export interface LlmResponse<T> {
  output: T;
  callId: Id;
  /** The model id the server reported. */
  model: string;
  modelDigest?: string;
}

/** Expected failures are values; only bugs throw. */
export type LlmResult<T> =
  | ({ ok: true } & LlmResponse<T>)
  | { ok: false; code: LlmFailureCode; message: string; callId: Id };

/** Any OpenAI-compatible endpoint; swapping models = changing base URL + model id. */
export interface LlmClient {
  readonly enabled: boolean;
  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** One model call, append-only (every attempt is logged, also the ones that never reached the network). */
export interface LlmCallRecord {
  id: Id;
  caseId?: Id;
  runId?: Id;
  task: string;
  promptVersion: string;
  promptSha256: Sha256Hex;
  baseUrl: string;
  modelRequested: string;
  modelReported?: string;
  modelDigest?: string;
  params: { temperature?: number; seed?: number; max_tokens?: number };
  /** SHA-256 of the request bytes that were (or would have been) sent. */
  requestSha256?: Sha256Hex;
  requestBlob?: BlobRef;
  inputSha256: Sha256Hex;
  inputCaptureIds: Id[];
  inputSourceIds: SourceId[];
  responseBlob?: BlobRef;
  /** The parsed output, when the call succeeded. */
  output?: unknown;
  outcome: LlmOutcome;
  error?: string;
  httpStatus?: number;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  /** Provenance id of the HTTP exchange (`raw_fetches`). */
  fetchId?: Id;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
}

export const LLM_SUGGESTION_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type LlmSuggestionStatus = (typeof LLM_SUGGESTION_STATUSES)[number];

/** A model suggestion. It has zero score weight until an analyst confirms it, and then only a rescore uses it. */
export interface LlmSuggestion {
  id: Id;
  runId: Id;
  task: string;
  target: { candidateId?: Id; linkAssessmentId?: Id; reportId?: Id };
  label: string;
  rationale?: string;
  output?: unknown;
  model: string;
  modelDigest?: string;
  promptVersion: string;
  callId: Id;
  status: LlmSuggestionStatus;
  decidedBy?: string;
  decidedAt?: IsoDateTime;
  justification?: string;
  editedText?: string;
  createdAt: IsoDateTime;
}

/** The analyst's decision about a suggestion (append-only; at most one per suggestion). */
export interface LlmSuggestionDecision {
  id: Id;
  suggestionId: Id;
  decision: 'confirmed' | 'rejected';
  justification: string;
  editedText?: string;
  decidedBy: string;
  decidedAt: IsoDateTime;
}

/** A suggestion as stored (the status is derived from the decision, never stored). */
export type NewLlmSuggestion = Omit<
  LlmSuggestion,
  'status' | 'decidedBy' | 'decidedAt' | 'justification' | 'editedText'
>;

/** Task of the model's drafts for section C of a report (an analyst confirms, edits or rejects each one). */
export const INFERENCE_DRAFT_TASK = 'report-inference-draft';

/** `output` of a suggestion of task `INFERENCE_DRAFT_TASK`; `basedOn` holds ids of the report's facts and results. */
export interface InferenceDraft {
  statement: string;
  basedOn: string[];
  alternatives: string[];
  verificationSteps: string[];
}

/** Typed answer of `POST /api/runs/:runId/report/drafts` (a model failure is a value, not an error). */
export type DraftInferencesResult =
  | { status: 'drafted'; created: number; dropped: { unknownBasis: number; restatesScore: number } }
  | { status: 'skipped'; reason: 'nothing_to_draft' | 'pending_drafts' | 'busy' | 'no_report' }
  | { status: 'failed'; reason: LlmFailureCode };
