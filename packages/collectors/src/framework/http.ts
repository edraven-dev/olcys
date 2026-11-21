/**
 * Per-source HTTP facade over the run's `EgressClient`: sets `sourceId`/`runId`, maps live URLs to the fixture site
 * offline, never downgrades `containsIdentifier` (and raises it when a case identifier appears in the URL), refuses
 * synthetic persona identifiers in live mode and stops a source for the rest of the run after a barrier.
 */
import type {
  CollectorInput,
  EgressRequest,
  EgressResponse,
  FetchMode,
  Id,
  RunContext,
  SourceDescriptor,
  SourceId,
} from '@olcys/core';
import type { CollectorConfig } from './config.ts';
import { SyntheticIdentifierError } from './errors.ts';
import type { BarrierStatus } from './status.ts';
import { isFixtureUrl, resolveSourceUrl, toLogicalUrl } from './urls.ts';

/** RFC 9309 decision for a URL; `RobotsCache` from the http package satisfies it. */
export interface RobotsPolicy {
  check(url: string, sourceId: SourceId): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

/** Stop-on-block circuit breaker: once a source hits a barrier in a run, it is not contacted again in that run. */
export class SourceCircuitBreaker {
  readonly #stops = new Map<string, { status: BarrierStatus; reason: string }>();

  trip(runId: Id, sourceId: SourceId, status: BarrierStatus, reason: string): void {
    const key = `${runId}|${sourceId}`;
    if (!this.#stops.has(key)) this.#stops.set(key, { status, reason });
  }

  state(runId: Id, sourceId: SourceId): { status: BarrierStatus; reason: string } | undefined {
    return this.#stops.get(`${runId}|${sourceId}`);
  }
}

export interface CollectorDeps {
  mode: FetchMode;
  config: CollectorConfig;
  robots: RobotsPolicy;
  breaker: SourceCircuitBreaker;
}

export type SourceHttpRequest = Omit<EgressRequest, 'sourceId' | 'runId'>;

export interface SourceHttp {
  readonly descriptor: SourceDescriptor;
  readonly ctx: RunContext;
  readonly deps: CollectorDeps;
  /** The URL requested for a live URL in this mode (offline: the fixture URL). Throws `NoFixtureError`. */
  requestUrl(liveUrl: string): string;
  /** The live URL a requested URL stands for. */
  logicalUrl(url: string): string;
  /** Whether a request URL may be sent at all (fixture origin offline, the source's allow-list otherwise). */
  hostAllowed(url: string): boolean;
  /** `url` is the requested URL (see `requestUrl`). */
  fetch(request: SourceHttpRequest): Promise<EgressResponse>;
  stopped(): { status: BarrierStatus; reason: string } | undefined;
  stop(status: BarrierStatus, reason: string): void;
}

const TOKEN_MIN_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenPattern(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, 'i');
}

function urlViews(url: string): string[] {
  const views = [url];
  try {
    views.push(decodeURIComponent(url.replace(/\+/g, ' ')));
  } catch {
    // Malformed percent-encoding: the raw URL is still checked.
  }
  return views;
}

/** The first token that occurs in the URL (raw or decoded) at a token boundary. */
export function findToken(url: string, tokens: readonly string[]): string | undefined {
  const views = urlViews(url);
  return tokens.find((token) => {
    if (token.length < TOKEN_MIN_LENGTH) return false;
    const pattern = tokenPattern(token);
    return views.some((view) => pattern.test(view));
  });
}

/** Case-derived values a request may disclose: identifiers, account handles and ids, nicks to probe, addresses. */
export function identifierTokens(input: CollectorInput): string[] {
  const tokens = new Set<string>();
  for (const identifier of input.identifiers) tokens.add(identifier.value.trim());
  for (const account of input.accounts) {
    tokens.add(account.handle);
    if (account.platformUserId) tokens.add(account.platformUserId);
  }
  for (const value of input.values ?? []) if (value.kind !== 'url') tokens.add(value.value.trim());
  for (const address of input.addresses) tokens.add(address.address);
  return [...tokens].filter((t) => t.length >= TOKEN_MIN_LENGTH);
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
}

export function createSourceHttp(args: {
  descriptor: SourceDescriptor;
  ctx: RunContext;
  deps: CollectorDeps;
  input: CollectorInput;
}): SourceHttp {
  const { descriptor, ctx, deps } = args;
  const tokens = identifierTokens(args.input);
  const mapping = deps.config.fixture;
  return {
    descriptor,
    ctx,
    deps,
    requestUrl: (liveUrl) => resolveSourceUrl(liveUrl, deps.mode, mapping),
    logicalUrl: (url) => toLogicalUrl(url, mapping),
    hostAllowed(url) {
      if (deps.mode === 'offline') return isFixtureUrl(url, mapping);
      const host = new URL(url).hostname.toLowerCase();
      if (descriptor.blockedHosts?.some((p) => hostMatches(host, p))) return false;
      return descriptor.allowedHosts.some((p) => hostMatches(host, p));
    },
    async fetch(request) {
      const stop = deps.breaker.state(ctx.runId, descriptor.id);
      if (stop) throw new Error(`source ${descriptor.id} is stopped for this run (${stop.status})`);
      if (deps.mode === 'live') {
        const synthetic = findToken(request.url, deps.config.syntheticIdentifiers);
        if (synthetic) throw new SyntheticIdentifierError(synthetic);
      }
      let containsIdentifier = request.containsIdentifier;
      if (!containsIdentifier && findToken(request.url, tokens)) {
        containsIdentifier = true;
        ctx.logger.warn('request carries a case identifier; marked containsIdentifier', {
          sourceId: descriptor.id,
          purpose: request.purpose,
        });
      }
      return ctx.http.fetch({ ...request, containsIdentifier, sourceId: descriptor.id, runId: ctx.runId });
    },
    stopped: () => deps.breaker.state(ctx.runId, descriptor.id),
    stop: (status, reason) => deps.breaker.trip(ctx.runId, descriptor.id, status, reason),
  };
}
