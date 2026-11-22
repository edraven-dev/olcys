import type { Sha256Hex } from './common.ts';
import type { FetchMode } from './provenance.ts';

/** Cursor-paginated list returned by the API. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Error body returned by the API. `code` is stable English; the UI maps it to Polish text. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/** Optional capabilities of an API instance; the console hides what is switched off. */
export interface ApiFeatures {
  /** Analyst judgements on links and analyst overrides of a case. */
  judgements: boolean;
  suggestions: boolean;
  schedules: boolean;
  reportPdf: boolean;
  exports: boolean;
  auth: boolean;
}

/** `GET /api/meta`: what this API instance runs and supports (read-only, no secrets). */
export interface ApiMeta {
  toolVersion: string;
  /** `CORE_CONTRACTS_VERSION` of the server. */
  contracts: string;
  mode: FetchMode;
  features: ApiFeatures;
  /** Weights and rule versions that new runs are configured with. */
  scoring?: { weightsVersion: string; weightsSha256: Sha256Hex; rulesVersions: Record<string, string> };
}
