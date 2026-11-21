/**
 * Typed client for the OŁCyŚ API. The console talks only to its own API under `/api` (Vite proxy in development);
 * it never contacts any other host. Error bodies are parsed into a stable `code` that the UI maps to Polish text —
 * the server's English `message` is never shown.
 */
import { pl } from '../i18n/pl.ts';
import { t } from '../i18n/t.ts';

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];

  constructor(status: number, code: string, message: string, issues: ApiIssue[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function issuesOf(value: unknown): ApiIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((issue) => ({
    path: typeof issue['path'] === 'string' ? issue['path'] : '',
    message: typeof issue['message'] === 'string' ? issue['message'] : '',
  }));
}

/**
 * Accepts the API's `{ error: 'code', message, issues }`, the `{ error: { code, message, details } }` envelope and
 * Fastify's default `{ statusCode, error: 'Not Found', message }`.
 */
export function parseErrorBody(status: number, body: unknown): { code: string; message: string; issues: ApiIssue[] } {
  const fallback = status === 404 ? 'not_found' : status >= 500 ? 'internal' : `http_${status}`;
  if (!isRecord(body)) return { code: fallback, message: '', issues: [] };
  const error = body['error'];
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  if (isRecord(error)) {
    const code = typeof error['code'] === 'string' ? error['code'] : fallback;
    return {
      code,
      message: typeof error['message'] === 'string' ? error['message'] : message,
      issues: issuesOf(error['details']),
    };
  }
  if (typeof error === 'string' && /^[a-z][a-z0-9_]*$/.test(error)) {
    return { code: error, message, issues: issuesOf(body['issues']) };
  }
  return { code: fallback, message, issues: [] };
}

/** `{ items: T[] }` (the API's list shape) or a bare array. */
export function itemsOf<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (isRecord(body) && Array.isArray(body['items'])) return body['items'] as T[];
  return [];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Test hook. */
export function setFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error(`refusing to call ${path}: the console only talks to its own API`);
  try {
    return await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init?.headers },
    });
  } catch (error) {
    throw new ApiRequestError(0, 'network', error instanceof Error ? error.message : String(error));
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  const body = await readJson(response);
  if (!response.ok) {
    const parsed = parseErrorBody(response.status, body);
    throw new ApiRequestError(response.status, parsed.code, parsed.message, parsed.issues);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => requestJson<T>(path),
  list: async <T>(path: string): Promise<T[]> => itemsOf<T>(await requestJson<unknown>(path)),
  /** Optional list: a missing route (404) is an empty list, not an error. */
  listOptional: async <T>(path: string): Promise<T[] | null> => {
    try {
      return itemsOf<T>(await requestJson<unknown>(path));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  },
  post: <T>(path: string, body: unknown): Promise<T> =>
    requestJson<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** HEAD request: true when the resource exists. */
  exists: async (path: string): Promise<boolean> => {
    const response = await send(path, { method: 'HEAD' });
    if (response.status === 404) return false;
    if (!response.ok) throw new ApiRequestError(response.status, parseErrorBody(response.status, undefined).code, '');
    return true;
  },
};

const enc = encodeURIComponent;

export const apiPaths = {
  sources: '/api/sources',
  cases: '/api/cases',
  case: (caseId: string) => `/api/cases/${enc(caseId)}`,
  caseRuns: (caseId: string) => `/api/cases/${enc(caseId)}/runs`,
  run: (runId: string) => `/api/runs/${enc(runId)}`,
  runList: (runId: string, list: RunListName) => `/api/runs/${enc(runId)}/${list}`,
  report: (runId: string) => `/api/runs/${enc(runId)}/report`,
  capture: (captureId: string) => `/api/captures/${enc(captureId)}`,
  blob: (sha256: string) => `/api/blobs/${enc(sha256)}`,
  labels: '/api/labels',
};

export type RunListName =
  | 'captures'
  | 'observations'
  | 'accounts'
  | 'candidates'
  | 'extractions'
  | 'egress'
  | 'transfers'
  | 'links'
  | 'exclusions'
  | 'activity'
  | 'cash-outs'
  | 'changes';

const ERROR_TEXT: Readonly<Record<string, string>> = pl.errors;

/** Polish message for any error thrown by the client (unknown codes show the code). */
export function errorMessage(error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : 'unknown';
  if (code !== 'unknown' && Object.hasOwn(ERROR_TEXT, code)) return ERROR_TEXT[code] ?? pl.errors.unknown;
  return t(pl.errors.unknown, { code: error instanceof ApiRequestError ? error.code : 'client' });
}
