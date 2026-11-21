/**
 * Fetches one page through the source's HTTP facade and turns the answer into a capture: allow-list and robots.txt
 * (RFC 9309) are checked for every hop, redirects are followed manually (at most 5 hops), barriers stop the source
 * for the rest of the run, and the block page itself is preserved as evidence. No browser, no subresources.
 */
import type { CaptureStatus, CaptureTechnicalReport, EgressResponse, Id } from '@olcys/core';
import { nowIso } from '@olcys/core';
import { buildCapture } from '../framework/capture.ts';
import { COLLECTORS_VERSION } from '../framework/config.ts';
import { NoFixtureError, SyntheticIdentifierError } from '../framework/errors.ts';
import type { SourceHttp } from '../framework/http.ts';
import type { PageOutcome } from '../framework/result.ts';
import { isBarrierStatus, note, statusFromHttp } from '../framework/status.ts';
import { usesFixtures } from '../framework/urls.ts';
import { detectAccessBarrier } from './barrier.ts';
import { decodeBody } from './dom.ts';

export const MAX_HOPS = 5;
export const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
export const JSON_ACCEPT = 'application/json,text/plain;q=0.9,*/*;q=0.8';
const ACCEPT_LANGUAGE = 'pl-PL,pl;q=0.9,en;q=0.5';

export interface PageRequest {
  /** Live URL; mapped to the fixture site offline. */
  url: string;
  /** Shown in the egress log, e.g. `bitcointalk profile`. */
  purpose: string;
  containsIdentifier: boolean;
  accept?: string;
  /** Tools and parser versions recorded in the capture's technical report. */
  software?: { name: string; version: string }[];
  /** Overrides the HTTP-derived status from the body (e.g. an HTTP 200 "member does not exist" page). */
  classify?: (body: string) => { status: CaptureStatus; reason: string } | undefined;
}

export interface PageResult extends PageOutcome {
  /** Decoded body of the final response, for the parsers. */
  body?: string;
  contentType?: string;
  /** Live URL of the final response (the fixture URL mapped back offline). */
  logicalUrl: string;
}

interface FetchFailure {
  status: CaptureStatus;
  note: string;
}

/** Expected transport outcomes become typed results; anything else is a bug and is rethrown. */
function classifyFetchError(error: unknown, url: string): FetchFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'EgressDeniedError') return { status: 'blocked', note: note('allow_list_denied', error.message) };
  if (error.name === 'ReplayMissError') return { status: 'error', note: note('replay_miss', error.message) };
  if (error instanceof SyntheticIdentifierError) {
    return { status: 'error', note: note('synthetic_identifier_refused', url) };
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError') {
    return { status: 'error', note: note('fetch_error', `${url}: ${error.message}`) };
  }
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|exceeds \d+ bytes|too many redirects/.test(error.message)
  ) {
    return { status: 'error', note: note('fetch_error', `${url}: ${error.message}`) };
  }
  return undefined;
}

export async function fetchPage(http: SourceHttp, request: PageRequest): Promise<PageResult> {
  const startedAt = nowIso(http.ctx.clock);
  const stop = http.stopped();
  if (stop) {
    return {
      status: stop.status,
      logicalUrl: request.url,
      notes: [note('source_stopped', `${stop.status}: ${stop.reason}`)],
    };
  }
  let url: string;
  try {
    url = http.requestUrl(request.url);
  } catch (error) {
    if (error instanceof NoFixtureError) {
      return { status: 'error', logicalUrl: request.url, notes: [note('no_fixture_for_host', error.host)] };
    }
    throw error;
  }
  const requestedUrl = url;
  const redirects: { url: string; status: number }[] = [];
  const fetchIds: Id[] = [];
  const notes: string[] = [];
  let robots: CaptureTechnicalReport['robots'];
  let response: EgressResponse | undefined;
  let finalUrl = url;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (!http.hostAllowed(url)) {
      return {
        status: 'blocked',
        logicalUrl: http.logicalUrl(url),
        notes: [note('allow_list_denied', `${new URL(url).hostname} is not allowed for ${http.descriptor.id}`)],
      };
    }
    // Sequential on purpose: every hop is checked against robots.txt before it is requested.
    // oxlint-disable-next-line no-await-in-loop
    const decision = await http.deps.robots.check(url, http.descriptor.id);
    const robotsUrl = new URL('/robots.txt', url).toString();
    robots = decision.allowed ? { allowed: true, robotsUrl } : { allowed: false, robotsUrl, reason: decision.reason };
    if (!decision.allowed) {
      return {
        status: 'blocked',
        logicalUrl: http.logicalUrl(url),
        notes: [note('robots_disallowed', `${http.logicalUrl(url)} (${decision.reason})`)],
      };
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      response = await http.fetch({
        url,
        redirect: 'manual',
        // The egress client keeps only the hash: the body is redacted here, in memory, before anything is stored.
        persistBody: false,
        headers: { accept: request.accept ?? HTML_ACCEPT, 'accept-language': ACCEPT_LANGUAGE },
        purpose: request.purpose,
        containsIdentifier: request.containsIdentifier,
      });
    } catch (error) {
      const failure = classifyFetchError(error, http.logicalUrl(url));
      if (!failure) throw error;
      return { status: failure.status, logicalUrl: http.logicalUrl(url), notes: [failure.note] };
    }
    fetchIds.push(response.provenance.fetchId);
    finalUrl = url;
    const location = response.headers['location'];
    if (response.status < 300 || response.status >= 400 || !location) break;
    redirects.push({ url, status: response.status });
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      // A redirect target that is not a URL ends this page with a typed error; the collection goes on.
      return {
        status: 'error',
        logicalUrl: http.logicalUrl(url),
        notes: [note('redirect_invalid', `${http.logicalUrl(url)} → ${location.slice(0, 200)}`)],
      };
    }
    if (usesFixtures(http.deps.mode) && !http.hostAllowed(next)) {
      // A redirect to a live host of a mapped platform is followed on the fixture site; others are refused above.
      try {
        next = http.requestUrl(next);
      } catch (error) {
        if (!(error instanceof NoFixtureError)) throw error;
      }
    }
    url = next;
    if (hop === MAX_HOPS - 1) notes.push(note('redirect_limit', `more than ${MAX_HOPS} hops`));
  }
  if (!response) throw new Error('unreachable: no response after the redirect loop');

  const contentType = response.headers['content-type'] ?? '';
  const decoded = decodeBody(response.body, contentType);
  const charset = decoded.charset;
  // Private keys and seed phrases never reach storage or observations: everything below sees the redacted text.
  const redaction = http.deps.redactor.redact(decoded.text);
  const body = redaction.text;
  const secretKinds = [...new Set(redaction.findings.map((f) => f.kind))].toSorted();
  const mediaType = contentType || 'application/octet-stream';
  const stored = redaction.findings.length
    ? await http.ctx.blobs.put(
        new TextEncoder().encode(body),
        `${mediaType.split(';')[0]?.trim() || 'text/plain'}; charset=utf-8`,
      )
    : await http.ctx.blobs.put(response.body, mediaType);
  const html = /html|xml/i.test(contentType) ? body : '';
  const verdict = detectAccessBarrier({ status: response.status, headers: response.headers, finalUrl, html });
  let status: CaptureStatus = verdict.status === 'ok' ? statusFromHttp(response.status) : verdict.status;
  if (notes.length) status = 'error';
  const classified = status === 'ok' ? request.classify?.(body) : undefined;
  if (classified) {
    status = classified.status;
    notes.push(note(classified.status === 'not_found' ? 'not_found' : 'unrecognised_markup', classified.reason));
  }
  if (isBarrierStatus(status)) {
    const signals = verdict.signals.length ? verdict.signals : [`HTTP ${response.status}`];
    http.stop(status, signals.join('; '));
    notes.push(note(`barrier_${status}`, `${http.logicalUrl(finalUrl)}: ${signals.join('; ')}`));
    if (response.status === 429)
      notes.push(note('rate_limited', `retry-after ${response.headers['retry-after'] ?? '?'}`));
  }
  const logicalUrl = http.logicalUrl(finalUrl);
  const technical: CaptureTechnicalReport = {
    method: 'http',
    startedAt,
    ...(logicalUrl !== finalUrl ? { logicalUrl } : {}),
    redirects,
    ...(robots ? { robots } : {}),
    redaction: {
      secrets: redaction.findings.length,
      kinds: secretKinds,
      originalSha256: response.provenance.body.sha256,
    },
    ...(verdict.status !== 'ok' ? { barrier: { status: verdict.status, signals: verdict.signals } } : {}),
    software: [{ name: '@olcys/collectors', version: COLLECTORS_VERSION }, ...(request.software ?? [])],
    transformations: [
      redaction.findings.length
        ? `${redaction.findings.length} secret(s) redacted in memory (${secretKinds.join(', ')}); stored and parsed body re-encoded as UTF-8`
        : `body stored as received; parsed after charset decode (${charset})`,
      'headers artifact: canonical JSON of the HTTP status and the kept response headers',
    ],
    notes,
  };
  const capture = await buildCapture({
    ctx: http.ctx,
    descriptor: http.descriptor,
    config: http.deps.config,
    response,
    body: stored,
    requestedUrl,
    finalUrl,
    fetchIds,
    status,
    technical,
  });
  return { status, capture, body, contentType, logicalUrl, notes };
}
