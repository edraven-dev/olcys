/**
 * The only network client in OŁCyŚ. Every request is checked against the allow-list of the sources enabled for the
 * run (per redirect hop), rate-limited per host, logged (allowed, denied or failed, with `containsIdentifier`), stored
 * as raw bytes in the blob store and described by a provenance envelope. Modes: live, offline, replay (see docs).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BlobRef,
  BlobStore,
  Clock,
  EgressClient,
  EgressLogEntry,
  EgressRequest,
  EgressResponse,
  FetchMode,
  Logger,
  ProvenanceEnvelope,
  SourceDescriptor,
  SourceKind,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { EgressDeniedError, ReplayMissError } from './errors.ts';

export interface EgressSinks {
  log(entry: EgressLogEntry): void | Promise<void>;
  provenance(envelope: ProvenanceEnvelope): void | Promise<void>;
}

export interface EgressClientOptions {
  mode: FetchMode;
  runId?: string;
  /** Sources and providers enabled for the run; their `allowedHosts` form the allow-list. */
  enabledSources: readonly SourceDescriptor[];
  /** Hosts of the fixture site and internal services (Gotenberg, osint-py, local LLM). */
  localHosts?: readonly string[];
  /** Additional hosts allowed in live mode (deployment configuration, e.g. a self-hosted node). */
  extraAllowedHosts?: readonly string[];
  blobs: BlobStore;
  sinks: EgressSinks;
  clock?: Clock;
  logger?: Logger;
  /** Cassette directory for replay/offline lookups and live recording. */
  cassetteDir?: string;
  record?: boolean;
  userAgent?: string;
  toolVersion: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

export const DEFAULT_LOCAL_HOSTS = [
  '127.0.0.1',
  'localhost',
  'fixture-site',
  'gotenberg',
  'osint-py',
  'ollama',
] as const;
const DEFAULT_SECRET_PARAMS = ['apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'x-api-key'];
const KEPT_HEADERS = ['content-type', 'etag', 'last-modified', 'date', 'retry-after', 'location', 'content-length'];
/** Source kinds that stay live in replay mode (when they target a local host). */
const LIVE_IN_REPLAY: ReadonlySet<SourceKind> = new Set<SourceKind>(['internal_service', 'ai_model']);

interface Cassette {
  request: { method: string; url: string };
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  finalUrl: string;
  synthetic?: boolean;
  sandbox?: boolean;
}

interface Fetched {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  finalUrl: string;
  egressLogId: string;
  synthetic?: boolean;
  sandbox?: boolean;
}

type LogFields = Omit<EgressLogEntry, 'id' | 'at' | 'mode' | 'runId'>;

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function hostMatches(host: string, pattern: string): boolean {
  const p = normaliseHost(pattern);
  if (p.startsWith('*.')) return host.endsWith(p.slice(1));
  return host === p;
}

function secretNames(extra: readonly string[] = []): Set<string> {
  return new Set([...DEFAULT_SECRET_PARAMS, ...extra].map((s) => s.toLowerCase()));
}

/** Redacts secret query parameters (by name, case-insensitive) in a URL. */
export function redactUrl(raw: string, secretParams: readonly string[] = []): string {
  const url = new URL(raw);
  const secrets = secretNames(secretParams);
  for (const key of Array.from(url.searchParams.keys())) {
    if (secrets.has(key.toLowerCase())) url.searchParams.set(key, 'REDACTED');
  }
  return url.toString();
}

/** Stable request key for cassettes: method + URL without secrets + body hash. */
export function requestHash(
  method: string,
  url: string,
  body?: string | Uint8Array,
  secretParams?: readonly string[],
): string {
  const bodyHash = body === undefined ? '' : createHash('sha256').update(body).digest('hex');
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${redactUrl(url, secretParams)}\n${bodyHash}`)
    .digest('hex');
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

function keptHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

export function createEgressClient(options: EgressClientOptions): EgressClient {
  const clock = options.clock ?? { now: () => new Date() };
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const userAgent = options.userAgent ?? `OLCYS/${options.toolVersion} (OSINT research prototype)`;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBodyBytes = options.maxBodyBytes ?? 25 * 1024 * 1024;
  const localHosts = new Set((options.localHosts ?? DEFAULT_LOCAL_HOSTS).map(normaliseHost));
  const sources = new Map(options.enabledSources.map((s) => [s.id, s]));
  const nextSlot = new Map<string, number>();

  const isLocal = (host: string): boolean => localHosts.has(host);

  function allowedFor(source: SourceDescriptor | undefined, host: string): string | undefined {
    if (!source) return 'source not enabled for this run';
    if (source.compliance === 'RED') return 'RED source';
    if (source.blockedHosts?.some((p) => hostMatches(host, p))) return 'host blocked';
    if (isLocal(host)) return undefined;
    const hosts = [...source.allowedHosts, ...(options.extraAllowedHosts ?? [])];
    if (hosts.some((p) => hostMatches(host, p))) return undefined;
    return `host ${host} not in the allow-list of ${source.id}`;
  }

  /** Why a live request to `host` must not be sent (undefined when it may). */
  function liveDenial(source: SourceDescriptor, firstHost: string, host: string): string | undefined {
    const denial = allowedFor(source, host);
    if (denial) return denial;
    if (options.mode !== 'live' && !isLocal(host)) return `external host in ${options.mode} mode`;
    if (!isLocal(firstHost) && isLocal(host)) return 'external host redirected to an internal host';
    return undefined;
  }

  /** offline: only local hosts are live; replay: only internal services on local hosts are live. */
  function servedFromCassette(source: SourceDescriptor, host: string): boolean {
    if (options.mode === 'live') return false;
    if (options.mode === 'offline') return !isLocal(host);
    return !(LIVE_IN_REPLAY.has(source.kind) && isLocal(host));
  }

  async function throttle(host: string, source: SourceDescriptor): Promise<void> {
    if (source.rateLimit.requests <= 0) return;
    const interval = (source.rateLimit.perSeconds * 1000) / source.rateLimit.requests;
    const now = clock.now().getTime();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + interval);
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async function log(fields: LogFields): Promise<string> {
    const id = newId();
    await options.sinks.log({
      id,
      ...(options.runId ? { runId: options.runId } : {}),
      mode: options.mode,
      at: clock.now().toISOString(),
      ...fields,
    });
    return id;
  }

  function cassettePath(sourceId: string, hash: string): string | undefined {
    return options.cassetteDir ? join(options.cassetteDir, sourceId, `${hash}.json`) : undefined;
  }

  async function readCassette(sourceId: string, hash: string): Promise<Cassette | undefined> {
    const path = cassettePath(sourceId, hash);
    if (!path) return undefined;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(text) as Cassette;
  }

  async function writeCassette(sourceId: string, hash: string, cassette: Cassette): Promise<void> {
    const path = cassettePath(sourceId, hash);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`);
  }

  /** Reads the body, refusing (and cancelling) anything above `maxBodyBytes`. */
  async function readCapped(response: Response): Promise<Uint8Array> {
    const tooLarge = `response body exceeds ${maxBodyBytes} bytes`;
    if (Number(response.headers.get('content-length')) > maxBodyBytes) {
      await response.body?.cancel();
      throw new Error(tooLarge);
    }
    if (!response.body) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBodyBytes) throw new Error(tooLarge);
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async function fetchLive(request: EgressRequest, source: SourceDescriptor, firstHost: string): Promise<Fetched> {
    let url = request.url;
    let method = request.method ?? 'GET';
    let body = request.body;
    let headers: Record<string, string> = { 'user-agent': userAgent, ...request.headers };
    const describe = (host: string): LogFields => ({
      sourceId: request.sourceId,
      host,
      method,
      urlRedacted: redactUrl(url, request.secretParams),
      purpose: request.purpose,
      containsIdentifier: request.containsIdentifier,
      allowed: true,
    });

    // Sequential on purpose: every hop is allow-listed, throttled and logged before the next one is sent.
    for (let hop = 0; ; hop += 1) {
      const host = normaliseHost(new URL(url).hostname);
      const denial = liveDenial(source, firstHost, host);
      if (denial) {
        const reason = hop === 0 ? denial : `redirect: ${denial}`;
        // oxlint-disable-next-line no-await-in-loop
        await log({ ...describe(host), allowed: false, denyReason: reason });
        throw new EgressDeniedError(host, reason);
      }
      // oxlint-disable-next-line no-await-in-loop
      await throttle(host, source);
      let response: Response;
      try {
        // oxlint-disable-next-line no-await-in-loop
        response = await doFetch(url, {
          method,
          redirect: 'manual',
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(request.timeoutMs ?? 20_000),
        });
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop
        await log({ ...describe(host), error: describeError(error) });
        throw error;
      }

      const location = response.headers.get('location');
      if (request.redirect !== 'manual' && response.status >= 300 && response.status < 400 && location !== null) {
        // oxlint-disable-next-line no-await-in-loop
        await response.body?.cancel();
        // oxlint-disable-next-line no-await-in-loop
        await log({ ...describe(host), httpStatus: response.status });
        if (hop >= maxRedirects) throw new Error(`too many redirects (more than ${maxRedirects})`);
        const next = new URL(location, url);
        if (next.origin !== new URL(url).origin) {
          // Never forward credentials to another origin.
          const secrets = secretNames([...(request.secretParams ?? []), 'cookie']);
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !secrets.has(name.toLowerCase())));
        }
        const toGet =
          response.status === 303
            ? method !== 'GET'
            : method === 'POST' && (response.status === 301 || response.status === 302);
        if (toGet) {
          method = 'GET';
          body = undefined;
        }
        url = next.toString();
        continue;
      }

      let bytes: Uint8Array;
      try {
        // oxlint-disable-next-line no-await-in-loop
        bytes = await readCapped(response);
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop
        await log({ ...describe(host), httpStatus: response.status, error: describeError(error) });
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop
      const egressLogId = await log({ ...describe(host), httpStatus: response.status, bytes: bytes.byteLength });
      return {
        status: response.status,
        headers: keptHeaders(response.headers),
        body: bytes,
        finalUrl: url,
        egressLogId,
      };
    }
  }

  return {
    async fetch(request: EgressRequest): Promise<EgressResponse> {
      const method = request.method ?? 'GET';
      const source = sources.get(request.sourceId);
      const requestedAt = clock.now().toISOString();
      const urlRedacted = redactUrl(request.url, request.secretParams);
      const hash = requestHash(method, request.url, request.body, request.secretParams);
      const firstHost = normaliseHost(new URL(request.url).hostname);
      const fields: LogFields = {
        sourceId: request.sourceId,
        host: firstHost,
        method,
        urlRedacted,
        purpose: request.purpose,
        containsIdentifier: request.containsIdentifier,
        allowed: true,
      };

      const denial = allowedFor(source, firstHost);
      if (denial !== undefined || !source) {
        const reason = denial ?? 'denied';
        await log({ ...fields, allowed: false, denyReason: reason });
        throw new EgressDeniedError(firstHost, reason);
      }

      let fetched: Fetched;
      if (servedFromCassette(source, firstHost)) {
        const cassette = await readCassette(request.sourceId, hash);
        if (!cassette) {
          await log({ ...fields, allowed: false, denyReason: 'replay miss' });
          throw new ReplayMissError(hash, urlRedacted);
        }
        const body = new Uint8Array(Buffer.from(cassette.bodyBase64, 'base64'));
        fetched = {
          status: cassette.status,
          headers: cassette.headers,
          body,
          finalUrl: cassette.finalUrl,
          egressLogId: await log({ ...fields, httpStatus: cassette.status, bytes: body.byteLength }),
          ...(cassette.synthetic ? { synthetic: true } : {}),
          ...(cassette.sandbox ? { sandbox: true } : {}),
        };
      } else {
        fetched = await fetchLive(request, source, firstHost);
        if (options.record && options.mode === 'live' && !isLocal(firstHost)) {
          await writeCassette(request.sourceId, hash, {
            request: { method, url: urlRedacted },
            status: fetched.status,
            headers: fetched.headers,
            bodyBase64: Buffer.from(fetched.body).toString('base64'),
            finalUrl: redactUrl(fetched.finalUrl, request.secretParams),
          });
        }
      }

      const { status, headers, body, finalUrl } = fetched;
      const persist = request.persistBody !== false;
      const mediaType = headers['content-type'] ?? 'application/octet-stream';
      const blob: BlobRef = persist
        ? await options.blobs.put(body, mediaType)
        : { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength, mediaType };
      const finalRedacted = redactUrl(finalUrl, request.secretParams);

      const envelope: ProvenanceEnvelope = {
        fetchId: newId(),
        ...(options.runId ? { runId: options.runId } : {}),
        sourceId: request.sourceId,
        provider: source.name,
        method,
        url: urlRedacted,
        ...(finalRedacted !== urlRedacted ? { finalUrl: finalRedacted } : {}),
        requestedAt,
        receivedAt: clock.now().toISOString(),
        httpStatus: status,
        responseHeaders: headers,
        body: blob,
        mode: options.mode,
        toolVersion: options.toolVersion,
        userAgent,
        egressLogId: fetched.egressLogId,
        bodyPersisted: persist,
        ...(fetched.synthetic ? { synthetic: true } : {}),
        ...(fetched.sandbox ? { sandbox: true } : {}),
      };
      await options.sinks.provenance(envelope);

      const text = (): string => new TextDecoder().decode(body);
      return {
        status,
        finalUrl: finalRedacted,
        headers,
        body,
        text,
        json: <T>() => JSON.parse(text()) as T,
        provenance: envelope,
      };
    },
  };
}
