/**
 * Contract of the osint-py username search (`POST /v1/usernames/search`, schema `usernames-search.v1`): request body,
 * response types and a strict parser. The response comes from another process, so it is validated, not cast.
 */

/** Tags of the sites that may be searched; the service enforces the same allow-list. */
export const MAIGRET_TAGS = ['crypto', 'finance', 'pl', 'social', 'coding', 'messaging'] as const;
export type MaigretTag = (typeof MAIGRET_TAGS)[number];

export const USERNAME_STATUSES = [
  'found',
  'not_found',
  'blocked',
  'login_wall',
  'captcha',
  'unknown',
  'illegal',
  'skipped',
] as const;
export type UsernameStatus = (typeof USERNAME_STATUSES)[number];

export const USERNAME_SEARCH_SCHEMA = 'usernames-search.v1';

export interface UsernameSearchRequestBody {
  username: string;
  database: 'fixture' | 'upstream';
  deniedHostSuffixes: string[];
  tags: MaigretTag[];
  timeoutSeconds: number;
}

export interface UsernameSiteResult {
  site: string;
  platform: string;
  tags: string[];
  /** The live profile URL (also when the request went to the fixture site). */
  profileUrl: string;
  status: UsernameStatus;
  reason: string | null;
  httpStatus: number | null;
  requestIds: string[];
  ids: Record<string, string>;
  idsLinks: string[];
}

export interface UsernameSearchRequestLog {
  id: string;
  method: 'GET';
  url: string;
  logicalUrl: string;
  host: string;
  site: string;
  purpose: string;
  containsIdentifier: boolean;
  allowed: boolean;
  denyReason: string | null;
  requestedAt: string;
  receivedAt: string | null;
  httpStatus: number | null;
  responseHeaders: Record<string, string>;
  bodySha256: string | null;
  bodyBase64: string | null;
  bodyTruncated: boolean;
  userAgent: string;
  error?: string | null;
}

export interface UsernameSearchResponse {
  schemaVersion: typeof USERNAME_SEARCH_SCHEMA;
  service: { version: string; maigretVersion: string; socidExtractorVersion: string; python: string };
  username: string;
  database: { id: string; sha256: string; sitesTotal: number; sitesSelected: number; excludedByPolicy: number };
  policy: { version: string; allowExternal: boolean; tags: string[]; userAgent: string };
  startedAt: string;
  finishedAt: string;
  results: UsernameSiteResult[];
  requests: UsernameSearchRequestLog[];
  summary: Record<string, number>;
}

export class UsernameSearchResponseError extends Error {
  constructor(message: string) {
    super(`invalid username search response: ${message}`);
    this.name = 'UsernameSearchResponseError';
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsernameSearchResponseError(`${path} is not an object`);
  }
  return value as Json;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new UsernameSearchResponseError(`${path} is not an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new UsernameSearchResponseError(`${path} is not a string`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : string(value, path);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UsernameSearchResponseError(`${path} is not an integer`);
  }
  return value;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : integer(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new UsernameSearchResponseError(`${path} is not a boolean`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, i) => string(item, `${path}[${i}]`));
}

function stringMap(value: unknown, path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value, path)).map(([k, v]) => [k, string(v, `${path}.${k}`)]));
}

function status(value: unknown, path: string): UsernameStatus {
  const text = string(value, path);
  if (!(USERNAME_STATUSES as readonly string[]).includes(text)) {
    throw new UsernameSearchResponseError(`${path} has unknown status ${text}`);
  }
  return text as UsernameStatus;
}

function parseResult(raw: unknown, path: string): UsernameSiteResult {
  const o = object(raw, path);
  return {
    site: string(o['site'], `${path}.site`),
    platform: string(o['platform'], `${path}.platform`),
    tags: strings(o['tags'], `${path}.tags`),
    profileUrl: string(o['profileUrl'], `${path}.profileUrl`),
    status: status(o['status'], `${path}.status`),
    reason: nullableString(o['reason'], `${path}.reason`),
    httpStatus: nullableInteger(o['httpStatus'], `${path}.httpStatus`),
    requestIds: strings(o['requestIds'], `${path}.requestIds`),
    ids: stringMap(o['ids'], `${path}.ids`),
    idsLinks: strings(o['idsLinks'], `${path}.idsLinks`),
  };
}

function parseRequest(raw: unknown, path: string): UsernameSearchRequestLog {
  const o = object(raw, path);
  if (o['method'] !== 'GET') throw new UsernameSearchResponseError(`${path}.method is not GET`);
  return {
    id: string(o['id'], `${path}.id`),
    method: 'GET',
    url: string(o['url'], `${path}.url`),
    logicalUrl: string(o['logicalUrl'], `${path}.logicalUrl`),
    host: string(o['host'], `${path}.host`),
    site: string(o['site'], `${path}.site`),
    purpose: string(o['purpose'], `${path}.purpose`),
    containsIdentifier: boolean(o['containsIdentifier'], `${path}.containsIdentifier`),
    allowed: boolean(o['allowed'], `${path}.allowed`),
    denyReason: nullableString(o['denyReason'], `${path}.denyReason`),
    requestedAt: string(o['requestedAt'], `${path}.requestedAt`),
    receivedAt: nullableString(o['receivedAt'], `${path}.receivedAt`),
    httpStatus: nullableInteger(o['httpStatus'], `${path}.httpStatus`),
    responseHeaders: stringMap(o['responseHeaders'], `${path}.responseHeaders`),
    bodySha256: nullableString(o['bodySha256'], `${path}.bodySha256`),
    bodyBase64: nullableString(o['bodyBase64'], `${path}.bodyBase64`),
    bodyTruncated: boolean(o['bodyTruncated'], `${path}.bodyTruncated`),
    userAgent: string(o['userAgent'], `${path}.userAgent`),
    error: nullableString(o['error'], `${path}.error`),
  };
}

export function parseUsernameSearchResponse(json: unknown): UsernameSearchResponse {
  const o = object(json, 'response');
  if (o['schemaVersion'] !== USERNAME_SEARCH_SCHEMA) {
    throw new UsernameSearchResponseError(`unsupported schemaVersion ${String(o['schemaVersion'])}`);
  }
  const service = object(o['service'], 'service');
  const database = object(o['database'], 'database');
  const policy = object(o['policy'], 'policy');
  const summary = object(o['summary'], 'summary');
  return {
    schemaVersion: USERNAME_SEARCH_SCHEMA,
    service: {
      version: string(service['version'], 'service.version'),
      maigretVersion: string(service['maigretVersion'], 'service.maigretVersion'),
      socidExtractorVersion: string(service['socidExtractorVersion'], 'service.socidExtractorVersion'),
      python: string(service['python'], 'service.python'),
    },
    username: string(o['username'], 'username'),
    database: {
      id: string(database['id'], 'database.id'),
      sha256: string(database['sha256'], 'database.sha256'),
      sitesTotal: integer(database['sitesTotal'], 'database.sitesTotal'),
      sitesSelected: integer(database['sitesSelected'], 'database.sitesSelected'),
      excludedByPolicy: integer(database['excludedByPolicy'], 'database.excludedByPolicy'),
    },
    policy: {
      version: string(policy['version'], 'policy.version'),
      allowExternal: boolean(policy['allowExternal'], 'policy.allowExternal'),
      tags: strings(policy['tags'], 'policy.tags'),
      userAgent: string(policy['userAgent'], 'policy.userAgent'),
    },
    startedAt: string(o['startedAt'], 'startedAt'),
    finishedAt: string(o['finishedAt'], 'finishedAt'),
    results: array(o['results'], 'results').map((r, i) => parseResult(r, `results[${i}]`)),
    requests: array(o['requests'], 'requests').map((r, i) => parseRequest(r, `requests[${i}]`)),
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, integer(v, `summary.${k}`)])),
  };
}

/** The response without the bodies (kept as separate captures): this is what the search report capture stores. */
export function stripBodies(response: UsernameSearchResponse): UsernameSearchResponse {
  return { ...response, requests: response.requests.map((r) => ({ ...r, bodyBase64: null })) };
}
