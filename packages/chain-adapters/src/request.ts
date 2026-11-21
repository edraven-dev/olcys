/**
 * The one request helper of every chain adapter. All traffic goes through `ctx.http` (the egress-guarded client):
 * allow-list, rate limit, egress log with `containsIdentifier`, provenance and cassettes are handled there.
 * HTTP 429/503 are not retried here (the egress client owns that); only throttling that arrives as HTTP 200 with an
 * error body (e.g. Etherscan "Max rate limit reached") is retried, as new logged requests.
 */
import type { EgressResponse, Id, RunContext, SourceId } from '@olcys/core';
import { ChainProviderError, type ChainErrorKind } from './errors.ts';
import { parseJsonExact } from './json.ts';

export interface ChainRequest {
  providerId: string;
  sourceId: SourceId;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Shown in the egress log, e.g. `bitcoin address history`. */
  purpose: string;
  /** True whenever the URL or body carries an address or transaction id. */
  containsIdentifier: boolean;
  /** Query parameters / headers to redact (API keys). */
  secretParams?: string[];
}

/** Stops a provider for the rest of a run after a block (403, challenge page): no further requests are sent. */
export class CircuitBreaker {
  private readonly open = new Map<string, { kind: ChainErrorKind; reason: string }>();

  isOpen(runId: string): boolean {
    return this.open.has(runId);
  }

  /** Why the provider was stopped in this run (the first barrier wins). */
  reason(runId: string): { kind: ChainErrorKind; reason: string } | undefined {
    return this.open.get(runId);
  }

  trip(runId: string, kind: ChainErrorKind, reason: string): void {
    if (!this.open.has(runId)) this.open.set(runId, { kind, reason });
  }
}

export interface RequestOptions {
  /** Body-level classification of a 2xx response (`ok` or an error kind). */
  classify?: (body: unknown) => 'ok' | ChainErrorKind;
  /** Retries of body-level throttling (default 3: 1 s, 2 s, 4 s, ± 20 %). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  breaker?: CircuitBreaker;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Maps a non-2xx HTTP status to an error kind. */
export function statusKind(status: number): ChainErrorKind | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 401) return 'auth_error';
  if (status === 403 || status === 451) return 'blocked';
  if (status === 404) return 'not_found';
  if (status === 429 || status === 503) return 'rate_limited';
  return 'upstream_error';
}

async function send(ctx: RunContext, req: ChainRequest, breaker?: CircuitBreaker): Promise<EgressResponse> {
  const stopped = breaker?.reason(ctx.runId);
  if (stopped) {
    throw new ChainProviderError(
      stopped.kind,
      req.providerId,
      `provider stopped earlier in this run (${stopped.reason}); not contacted again`,
    );
  }
  try {
    return await ctx.http.fetch({
      url: req.url,
      method: req.method ?? 'GET',
      sourceId: req.sourceId,
      purpose: req.purpose,
      containsIdentifier: req.containsIdentifier,
      runId: ctx.runId,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.secretParams ? { secretParams: req.secretParams } : {}),
    });
  } catch (error) {
    // The error classes live in @olcys/http; packages only see them through the port, so match by name.
    const name = error instanceof Error ? error.name : '';
    if (name === 'EgressDeniedError') {
      throw new ChainProviderError('egress_denied', req.providerId, (error as Error).message, { cause: error });
    }
    if (name === 'ReplayMissError') {
      throw new ChainProviderError('replay_miss', req.providerId, (error as Error).message, { cause: error });
    }
    throw new ChainProviderError('upstream_error', req.providerId, `request failed: ${String(error)}`, {
      cause: error,
    });
  }
}

/** Statuses that are barriers: the provider is stopped for the rest of the run, never retried around. */
const BARRIER_STATUSES: ReadonlyMap<number, ChainErrorKind> = new Map<number, ChainErrorKind>([
  [403, 'blocked'],
  [429, 'rate_limited'],
  [451, 'blocked'],
]);

/**
 * Barrier check before any parsing: a challenge page (`cf-mitigated: challenge`, whatever its status) is `captcha`;
 * 403/451 are `blocked`, a 429 that outlived the egress client's own retries is `rate_limited`. Each opens the
 * provider's circuit for the rest of the run. Other non-2xx statuses throw without opening it.
 */
function failOnStatus(ctx: RunContext, req: ChainRequest, response: EgressResponse, breaker?: CircuitBreaker): void {
  const fail = (kind: ChainErrorKind, reason: string): never => {
    throw new ChainProviderError(kind, req.providerId, `${reason} from ${response.provenance.url}`, {
      fetchId: response.provenance.fetchId,
    });
  };
  const mitigated = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'cf-mitigated')?.[1];
  if (mitigated !== undefined) {
    breaker?.trip(ctx.runId, 'captcha', `challenge (cf-mitigated: ${mitigated})`);
    fail('captcha', `challenge page (cf-mitigated: ${mitigated}, HTTP ${response.status})`);
  }
  const barrier = BARRIER_STATUSES.get(response.status);
  if (barrier !== undefined) {
    breaker?.trip(ctx.runId, barrier, `HTTP ${response.status}`);
    fail(barrier, `HTTP ${response.status}`);
  }
  const kind = statusKind(response.status);
  if (kind !== undefined) fail(kind, `HTTP ${response.status}`);
}

/** GET/POST returning a JSON body; integers beyond 2^53 and decimals keep their exact text. */
export async function requestJson<T>(
  ctx: RunContext,
  req: ChainRequest,
  options: RequestOptions = {},
): Promise<{ data: T; fetchId: Id }> {
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    // Sequential on purpose: a throttled request is retried only after the back-off.
    // oxlint-disable-next-line no-await-in-loop
    const response = await send(ctx, req, options.breaker);
    failOnStatus(ctx, req, response, options.breaker);
    let data: unknown;
    try {
      data = parseJsonExact(response.text());
    } catch (error) {
      throw new ChainProviderError('invalid_response', req.providerId, 'response is not valid JSON', {
        fetchId: response.provenance.fetchId,
        cause: error,
      });
    }
    const verdict = options.classify?.(data) ?? 'ok';
    if (verdict === 'ok') return { data: data as T, fetchId: response.provenance.fetchId };
    if (verdict !== 'rate_limited' || attempt >= maxRetries) {
      throw new ChainProviderError(verdict, req.providerId, 'provider returned an error body', {
        fetchId: response.provenance.fetchId,
      });
    }
    const base = 1000 * 2 ** attempt;
    // oxlint-disable-next-line no-await-in-loop
    await sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
  }
}

/** GET returning a plain-text body (e.g. Esplora `/blocks/tip/height`). */
export async function requestText(
  ctx: RunContext,
  req: ChainRequest,
  options: Pick<RequestOptions, 'breaker'> = {},
): Promise<{ text: string; fetchId: Id }> {
  const response = await send(ctx, req, options.breaker);
  failOnStatus(ctx, req, response, options.breaker);
  return { text: response.text().trim(), fetchId: response.provenance.fetchId };
}
