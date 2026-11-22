/**
 * Username enumeration through the internal osint-py service (Maigret as a library, pinned site database, tag
 * allow-list). The service contacts the sites itself under its own allow-list and request log; this collector asks it
 * for one nickname, merges its request log into the egress log (`recordDelegated`) and turns the answer into captures
 * and observations. A hit is a candidate account, never a link: the pivot planner may verify it with the platform
 * collectors, and nothing here carries score weight. Barriers ("blocked", login wall, CAPTCHA) and failures
 * ("unknown") are recorded apart from "not found"; the service never retries around them.
 */
import type {
  Capture,
  CaptureDraft,
  CaptureStatus,
  CaptureTechnicalReport,
  CollectorInput,
  CollectorResult,
  DelegatedRequestRecord,
  EgressResponse,
  FetchMode,
  Id,
  ProvenanceEnvelope,
  RunContext,
  SecretRedactor,
  SourceCollector,
  SourceDescriptor,
} from '@olcys/core';
import { canonicalJson, nowIso } from '@olcys/core';
import { createHash } from 'node:crypto';
import { artifactKindFor } from '../framework/capture.ts';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { COLLECTORS_VERSION, type Env } from '../framework/config.ts';
import { SyntheticIdentifierError } from '../framework/errors.ts';
import { decodeBody } from '../html/dom.ts';
import { createSourceHttp, findToken, type CollectorDeps, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { note, type CollectorStatus } from '../framework/status.ts';
import { recogniseAccountUrl } from '../framework/urls.ts';
import { observer } from '../platforms/common.ts';
import {
  MAIGRET_TAGS,
  parseUsernameSearchResponse,
  stripBodies,
  type MaigretTag,
  type UsernameSearchRequestBody,
  type UsernameSearchRequestLog,
  type UsernameSearchResponse,
  type UsernameSiteResult,
  type UsernameStatus,
} from './response.ts';

export const MAIGRET_SOURCE_ID = 'maigret';
export const MAIGRET_PLATFORM = 'maigret';
export const OSINT_PY_DELEGATE = 'osint-py';
export const DEFAULT_OSINT_PY_URL = 'http://127.0.0.1:8090';
const SEARCH_PATH = '/v1/usernames/search';
const NICK_KINDS = ['nickname', 'social_login'] as const;
/** The service's own request pattern for a username (no whitespace, `/ ? # @ :`), at most 64 characters. */
const VALID_USERNAME = /^[^\s/?#@:]{1,64}$/;

export interface MaigretCollectorOptions {
  /** `OSINT_PY_URL` (loopback or the compose service by default). */
  baseUrl: string;
  /** `fixture` offline and in replay, `upstream` live (`OSINT_PY_DATABASE` overrides). */
  database: 'fixture' | 'upstream';
  /** Host suffixes the service must not contact in addition to its own RED list and the run's `deps.deniedHosts`. */
  deniedHostSuffixes?: readonly string[];
  tags?: readonly MaigretTag[];
  timeoutMs?: number;
}

/**
 * `OSINT_PY_URL` (default loopback) and the site database: `fixture` offline and in replay, `upstream` live;
 * `OSINT_PY_DATABASE=fixture|upstream` overrides.
 */
export function maigretOptionsFromEnv(mode: FetchMode, env: Env): MaigretCollectorOptions {
  const override = env['OSINT_PY_DATABASE']?.trim();
  const database =
    override === 'fixture' || override === 'upstream' ? override : mode === 'live' ? 'upstream' : 'fixture';
  return { baseUrl: env['OSINT_PY_URL']?.trim() || DEFAULT_OSINT_PY_URL, database };
}

/** The nickname the task is about: an input identifier of kind nickname or social login (pages are not its subject). */
export function maigretNick(input: CollectorInput): string | undefined {
  if ((input.values ?? []).some((value) => value.kind === 'url')) return undefined;
  for (const identifier of input.identifiers) {
    if (!(NICK_KINDS as readonly string[]).includes(identifier.kind)) continue;
    const nick = identifier.value.trim().replace(/^@+/, '');
    if (VALID_USERNAME.test(nick)) return nick;
  }
  return undefined;
}

/** The request body is canonical JSON without run ids or times, so equal searches are byte-identical (cassettes). */
export function searchRequestBody(
  username: string,
  options: Pick<MaigretCollectorOptions, 'database' | 'tags' | 'timeoutMs'>,
  deniedHosts: readonly string[],
): UsernameSearchRequestBody {
  const suffixes = [...new Set(deniedHosts.map((h) => h.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean))];
  return {
    username,
    database: options.database,
    deniedHostSuffixes: suffixes.toSorted(),
    tags: [...(options.tags ?? MAIGRET_TAGS)].toSorted(),
    timeoutSeconds: 10,
  };
}

const CAPTURE_STATUS: Partial<Record<UsernameStatus, CaptureStatus>> = {
  found: 'ok',
  blocked: 'blocked',
  login_wall: 'login_wall',
  captcha: 'captcha',
};
const BARRIERS = ['captcha', 'login_wall', 'blocked'] as const;

/**
 * found → ok (partial when a barrier or an unanswered site is among the rest); nothing found → not_found when every
 * site answered "not found"; only barriers → the strongest one; anything else → partial. No site is ever "not found"
 * because it did not answer.
 */
export function rollupUsernameSearch(statuses: readonly UsernameStatus[]): CollectorStatus {
  const count = (s: UsernameStatus) => statuses.filter((x) => x === s).length;
  const found = count('found');
  const absent = count('not_found') + count('illegal');
  const barriers = BARRIERS.filter((b) => statuses.includes(b));
  const unanswered = count('unknown') + count('skipped');
  if (found > 0) return barriers.length || unanswered ? 'partial' : 'ok';
  if (statuses.length === 0) return 'error';
  if (!barriers.length && !unanswered) return 'not_found';
  if (barriers.length && !absent && !unanswered) return barriers[0] as CollectorStatus;
  return 'partial';
}

/** What redaction changed in one page body (never the values): shown in the capture's technical report. */
export interface BodyRedaction {
  secrets: number;
  kinds: string[];
  /** SHA-256 of the body as the service received it. */
  originalSha256: string;
}

/**
 * Private keys and seed phrases never reach storage: every page body and every extracted field of the service's answer
 * goes through the project's redactor before captures, blobs, delegated log rows or provenance are built from it.
 * A body is decoded with its declared charset (as `fetchPage` does); a body without findings keeps its original bytes,
 * one with findings is stored as redacted UTF-8 and its content type says so.
 */
export function redactResponse(
  response: UsernameSearchResponse,
  redactor: SecretRedactor,
): { response: UsernameSearchResponse; redactions: Map<string, BodyRedaction> } {
  const text = (value: string): string => redactor.redact(value).text;
  const redactions = new Map<string, BodyRedaction>();
  const requests = response.requests.map((r) => {
    if (!r.bodyBase64) return r;
    const bytes = decodeBase64(r.bodyBase64);
    const contentType = r.responseHeaders['content-type'] ?? '';
    const result = redactor.redact(decodeBody(bytes, contentType).text);
    if (!result.findings.length) return r;
    redactions.set(r.id, {
      secrets: result.findings.length,
      kinds: [...new Set(result.findings.map((f) => f.kind))].toSorted(),
      originalSha256: r.bodySha256 ?? createHash('sha256').update(bytes).digest('hex'),
    });
    const mediaType = contentType.split(';')[0]?.trim() || 'text/plain';
    return {
      ...r,
      bodyBase64: Buffer.from(result.text, 'utf8').toString('base64'),
      responseHeaders: { ...r.responseHeaders, 'content-type': `${mediaType}; charset=utf-8` },
    };
  });
  return {
    response: {
      ...response,
      results: response.results.map((r) => ({
        ...r,
        ids: Object.fromEntries(Object.entries(r.ids).map(([k, v]) => [k, text(v)])),
        idsLinks: r.idsLinks.map(text),
      })),
      requests,
    },
    redactions,
  };
}

const decodeBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

function delegatedRecord(request: UsernameSearchRequestLog): DelegatedRequestRecord {
  return {
    method: 'GET',
    url: request.url,
    ...(request.logicalUrl !== request.url ? { logicalUrl: request.logicalUrl } : {}),
    purpose: request.purpose,
    containsIdentifier: request.containsIdentifier,
    allowed: request.allowed,
    ...(request.denyReason ? { denyReason: request.denyReason } : {}),
    ...(request.error ? { error: request.error } : {}),
    requestedAt: request.requestedAt,
    ...(request.receivedAt ? { receivedAt: request.receivedAt } : {}),
    ...(request.httpStatus === null ? {} : { httpStatus: request.httpStatus }),
    responseHeaders: request.responseHeaders,
    ...(request.bodyBase64 ? { body: decodeBase64(request.bodyBase64) } : {}),
    userAgent: request.userAgent,
  };
}

interface Delegated {
  egressLogId: Id;
  provenance?: ProvenanceEnvelope;
}

const snake = (key: string): string =>
  key
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

interface Search {
  rb: ResultBuilder;
  http: SourceHttp;
  ctx: RunContext;
  descriptor: SourceDescriptor;
  username: string;
  parsed: UsernameSearchResponse;
  baseUrl: string;
  logged: Map<string, Delegated>;
  redactions: Map<string, BodyRedaction>;
  software: { name: string; version: string }[];
}

async function recordReport(search: Search, response: EgressResponse): Promise<Capture> {
  const { ctx, descriptor, parsed, software } = search;
  if (!ctx.evidence) throw new Error('RunContext.evidence (the capture recorder) is not configured');
  const endedAt = nowIso(ctx.clock);
  const received = response.provenance.receivedAt;
  const draft: CaptureDraft = {
    sourceId: descriptor.id,
    profile: 'api_response',
    userAgent: response.provenance.userAgent,
    fetchIds: [response.provenance.fetchId],
    url: `${search.baseUrl}${SEARCH_PATH}`,
    finalUrl: `${search.baseUrl}${SEARCH_PATH}`,
    startedAt: parsed.startedAt,
    collectedAt: received,
    endedAt: endedAt > received ? endedAt : received,
    httpStatus: response.status,
    status: 'ok',
    responseHeaders: response.headers,
    artifacts: [
      {
        kind: 'json',
        bytes: new TextEncoder().encode(canonicalJson(stripBodies(parsed))),
        mediaType: 'application/json',
        description: 'osint-py username search report (usernames-search.v1; page bodies kept as separate captures)',
      },
      {
        kind: 'headers',
        bytes: new TextEncoder().encode(canonicalJson({ status: response.status, headers: response.headers })),
        mediaType: 'application/json',
        description: 'HTTP status and kept response headers of the osint-py answer (canonical JSON)',
      },
    ],
    transformations: [
      'page bodies removed from the stored report; each found profile and barrier page is a separate capture',
    ],
    technical: {
      method: 'http',
      startedAt: parsed.startedAt,
      redirects: [],
      software,
      transformations: [
        'requests were made by osint-py under its own allow-list; its request log is merged into the egress log',
      ],
      notes: [],
    },
  };
  return ctx.evidence.record(draft, ctx);
}

/** One capture per found profile or barrier page: the last response of the site's request chain. */
async function recordSite(search: Search, result: UsernameSiteResult): Promise<Capture | undefined> {
  const { ctx, descriptor, parsed, logged, software, redactions } = search;
  const status = CAPTURE_STATUS[result.status];
  if (!status) return undefined;
  if (!ctx.evidence) throw new Error('RunContext.evidence (the capture recorder) is not configured');
  const chain = result.requestIds
    .map((id) => parsed.requests.find((r) => r.id === id))
    // The first site on a host also owns the host's robots.txt request: never part of a page's chain.
    .filter((r): r is UsernameSearchRequestLog => r !== undefined && r.allowed && r.purpose !== 'robots.txt');
  const last = chain.at(-1);
  const delegated = last ? logged.get(last.id) : undefined;
  const provenance = delegated?.provenance;
  if (!last || !provenance) return undefined;
  const headers = last.responseHeaders;
  const bodyKind = artifactKindFor(headers['content-type'] ?? '');
  const redirects = chain.slice(0, -1).map((r) => ({ url: r.url, status: r.httpStatus ?? 0 }));
  const barrier = status === 'ok' ? undefined : { status, signals: [result.reason ?? `HTTP ${last.httpStatus ?? 0}`] };
  const redaction = redactions.get(last.id);
  const technical: CaptureTechnicalReport = {
    method: 'http',
    startedAt: chain[0]?.requestedAt ?? last.requestedAt,
    ...(last.logicalUrl !== last.url ? { logicalUrl: last.logicalUrl } : {}),
    redirects,
    ...(barrier ? { barrier } : {}),
    ...(redaction ? { redaction } : {}),
    software,
    transformations: [
      'request made by osint-py (Maigret) under its own allow-list',
      redaction
        ? `${redaction.secrets} secret(s) redacted in memory (${redaction.kinds.join(', ')}); body re-encoded as UTF-8, not the bytes received`
        : 'body stored as received',
      ...(last.bodyTruncated ? ['body truncated by osint-py at its size limit'] : []),
      'headers artifact: canonical JSON of the HTTP status and the kept response headers',
    ],
    notes: [],
  };
  const received = last.receivedAt ?? last.requestedAt;
  const endedAt = nowIso(ctx.clock);
  const draft: CaptureDraft = {
    sourceId: descriptor.id,
    profile: bodyKind === 'json' ? 'api_response' : 'web_page',
    userAgent: last.userAgent,
    fetchIds: chain.flatMap((r) => logged.get(r.id)?.provenance?.fetchId ?? []),
    url: chain[0]?.url ?? last.url,
    finalUrl: last.url,
    startedAt: technical.startedAt,
    collectedAt: received,
    endedAt: endedAt > received ? endedAt : received,
    httpStatus: last.httpStatus ?? 0,
    status,
    responseHeaders: headers,
    artifacts: [
      {
        kind: bodyKind,
        blob: provenance.body,
        description: redaction
          ? 'HTTP response body as received by osint-py, with secrets redacted (UTF-8)'
          : 'HTTP response body as received by osint-py',
      },
      {
        kind: 'headers',
        bytes: new TextEncoder().encode(canonicalJson({ status: last.httpStatus, headers })),
        mediaType: 'application/json',
        description: 'HTTP status and kept response headers (canonical JSON)',
      },
    ],
    discovery: { method: 'enumeration' },
    transformations: technical.transformations,
    technical,
  };
  return ctx.evidence.record(draft, ctx);
}

function describeAccount(result: UsernameSiteResult, username: string, http: SourceHttp) {
  const recognised = recogniseAccountUrl(result.profileUrl, http.deps.config.fixture);
  const platform = recognised?.platform ?? result.platform;
  const handle = recognised?.handle ?? username;
  return { platform, handle, key: `${platform}:${handle.toLowerCase()}` };
}

function addObservations(search: Search, report: Capture, captures: Map<string, Capture>): void {
  const { rb, http, username, parsed } = search;
  for (const result of parsed.results) {
    const { key } = describeAccount(result, username, http);
    observer(rb, report, 'account', key)('enumeration.status', result.status);
    const capture = captures.get(result.site);
    if (result.status !== 'found' || !capture) continue;
    const account = observer(rb, capture, 'account', key);
    for (const [name, value] of Object.entries(result.ids)) {
      const property = snake(name);
      if (property && property !== 'extractor') account(`profile.${property}`, value);
    }
    result.idsLinks.forEach((link, index) => {
      const recognisedLink = recogniseAccountUrl(link, http.deps.config.fixture);
      account(recognisedLink ? 'account.link' : 'profile.link', link, index);
    });
  }
}

function classifyFailure(error: unknown, url: string): { status: 'error'; note: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'EgressDeniedError') return { status: 'error', note: note('allow_list_denied', error.message) };
  if (error.name === 'ReplayMissError') return { status: 'error', note: note('replay_miss', error.message) };
  if (
    ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ||
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|exceeds \d+ bytes/.test(error.message)
  ) {
    return { status: 'error', note: note('fetch_error', `${url}: ${error.message}`) };
  }
  return undefined;
}

function errorNote(response: EgressResponse, url: string): string {
  let code: unknown;
  try {
    code = (JSON.parse(response.text()) as { code?: unknown }).code;
  } catch {
    // Not JSON: reported as a plain HTTP failure below.
  }
  if (response.status === 409 && code === 'external_disabled') {
    return note(
      'external_disabled',
      'osint-py has OLCYS_OSINT_ALLOW_EXTERNAL=false: third-party sites are not contacted',
    );
  }
  if (response.status === 409 && code === 'db_hash_mismatch') {
    return note('db_hash_mismatch', 'the site database of osint-py does not match its pinned SHA-256');
  }
  return note('fetch_error', `${url}: HTTP ${response.status}`);
}

export function maigretCollectorFactory(options: MaigretCollectorOptions): CollectorFactory {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const searchUrl = `${baseUrl}${SEARCH_PATH}`;
  return {
    sourceId: MAIGRET_SOURCE_ID,
    platform: MAIGRET_PLATFORM,
    identifierKinds: NICK_KINDS,
    create(descriptor: SourceDescriptor, deps: CollectorDeps): SourceCollector {
      return {
        descriptor,
        supports: (input) => maigretNick(input) !== undefined,
        async collect(input: CollectorInput, ctx: RunContext): Promise<CollectorResult> {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const username = maigretNick(input);
          if (!username) {
            rb.note('unsupported_input', 'no nickname');
            return rb.build();
          }
          if (deps.mode === 'live' && findToken(username, deps.config.syntheticIdentifiers)) {
            rb.note('synthetic_identifier_refused', new SyntheticIdentifierError(username).message);
            return rb.build();
          }
          // Offline and replay never reach the external web, not even through osint-py: fixture database only.
          if (deps.mode !== 'live' && options.database !== 'fixture') {
            rb.note('unsupported_input', `the ${options.database} site database is refused in ${deps.mode} mode`);
            return rb.build();
          }
          // The service's own requests must reach the egress log: without the merge hook nothing is sent at all.
          if (!ctx.http.recordDelegated) {
            rb.note('delegated_log_unavailable', 'the egress client cannot merge the osint-py request log');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const body = canonicalJson(
            searchRequestBody(username, options, [...(deps.deniedHosts ?? []), ...(options.deniedHostSuffixes ?? [])]),
          );
          let response: EgressResponse;
          try {
            response = await http.fetch({
              url: searchUrl,
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json', 'x-olcys-run-id': ctx.runId },
              body,
              purpose: 'maigret username enumeration (osint-py)',
              containsIdentifier: true,
              timeoutMs: options.timeoutMs ?? 180_000,
              // The raw answer carries unredacted page bodies: only its digest and metadata are kept.
              persistBody: false,
            });
          } catch (error) {
            const failure = classifyFailure(error, searchUrl);
            if (!failure) throw error;
            rb.addPage({ status: failure.status, notes: [failure.note] });
            return rb.build();
          }
          if (response.status !== 200) {
            rb.addPage({ status: 'error', notes: [errorNote(response, searchUrl)] });
            return rb.build();
          }
          let parsed: UsernameSearchResponse;
          try {
            parsed = parseUsernameSearchResponse(response.json());
          } catch (error) {
            if (!(error instanceof Error) || !/invalid username search response|JSON/.test(error.message)) throw error;
            rb.addPage({ status: 'error', notes: [note('unrecognised_markup', error.message)] });
            return rb.build();
          }

          const redacted = redactResponse(parsed, deps.redactor);
          parsed = redacted.response;
          const software = [
            { name: '@olcys/collectors', version: COLLECTORS_VERSION },
            { name: 'osint-py', version: parsed.service.version },
            { name: 'maigret', version: parsed.service.maigretVersion },
            { name: 'socid-extractor', version: parsed.service.socidExtractorVersion },
          ];
          const records = await ctx.http.recordDelegated({
            delegate: OSINT_PY_DELEGATE,
            sourceId: descriptor.id,
            runId: ctx.runId,
            viaFetchId: response.provenance.fetchId,
            toolVersion: `maigret ${parsed.service.maigretVersion} (osint-py ${parsed.service.version})`,
            records: parsed.requests.map(delegatedRecord),
          });
          const logged = new Map<string, Delegated>(parsed.requests.map((r, i) => [r.id, records[i] as Delegated]));
          const search: Search = {
            rb,
            http,
            ctx,
            descriptor,
            username,
            parsed,
            baseUrl,
            logged,
            redactions: redacted.redactions,
            software,
          };

          const report = await recordReport(search, response);
          const captures = new Map<string, Capture>();
          for (const result of parsed.results) {
            // Sequential on purpose: captures are recorded in the order of the service's results.
            // oxlint-disable-next-line no-await-in-loop
            const capture = await recordSite(search, result);
            if (capture) captures.set(result.site, capture);
          }
          rb.addPage({ status: 'ok', capture: report, notes: [] });
          for (const capture of captures.values()) rb.addPage({ status: capture.status, capture, notes: [] });
          addObservations(search, report, captures);

          const absent: string[] = [];
          const unanswered: string[] = [];
          for (const result of parsed.results) {
            const { platform, handle } = describeAccount(result, username, http);
            const capture = captures.get(result.site);
            if (result.status === 'found' && capture) {
              rb.account({
                platform,
                handle,
                profileUrl: result.profileUrl,
                discoveredVia: { sourceId: descriptor.id, method: 'enumeration', captureId: capture.id },
              });
            } else if (result.status === 'not_found' || result.status === 'illegal') {
              absent.push(result.site);
            } else if (result.status === 'blocked' || result.status === 'login_wall' || result.status === 'captcha') {
              rb.note(`barrier_${result.status}`, `${result.site}: ${result.reason ?? 'no reason given'}`);
            } else if (result.status !== 'found') {
              unanswered.push(`${result.site} (${result.reason ?? result.status})`);
            }
          }
          if (absent.length) rb.note('not_found', `${absent.length} site(s) have no profile for ${username}`);
          if (unanswered.length) rb.note('fetch_error', `no answer from ${unanswered.slice(0, 10).join(', ')}`);
          return {
            ...rb.build(),
            status: rollupUsernameSearch(parsed.results.map((r) => r.status)),
          };
        },
      };
    },
  };
}
