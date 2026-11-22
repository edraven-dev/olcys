/**
 * Security headers and the access log of the API.
 *
 * Headers are set in one `onSend` hook so no route can forget them. A route that sets its own, stricter
 * `Content-Security-Policy` (stored blobs, the report) keeps it. HSTS only behind TLS (`OLCYS_HSTS=1`).
 * The access log records who viewed or exported which case and why, one row per audited request.
 */
import { createHash } from 'node:crypto';
import type { AccessAction, AccessLogEntry, Id, Repositories } from '@olcys/core';
import { newId, nowIso } from '@olcys/core';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import { idOf } from './ids.ts';

/** CSP of JSON API responses: nothing may load or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
const HSTS = 'max-age=31536000; includeSubDomains';

/** CSP of the report HTML: its inline stylesheets are allowed by hash only, never inline scripts. */
export function reportCsp(html: string): string {
  const hashes = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) =>
      `'sha256-${createHash('sha256')
        .update(m[1] ?? '')
        .digest('base64')}'`,
  );
  const style = hashes.length ? hashes.join(' ') : "'none'";
  return `default-src 'none'; style-src ${style}; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}

export interface SecurityOptions {
  /** Adds `Strict-Transport-Security` (set only when the API is served over TLS). */
  hsts?: boolean;
}

export function registerSecurityHeaders(app: FastifyInstance, options: SecurityOptions = {}): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', API_CSP);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (options.hsts) reply.header('strict-transport-security', HSTS);
    return payload;
  });
}

interface Audited {
  action: AccessAction;
  /** Which path parameter names the case / run, if any. */
  scope: 'case' | 'run' | 'none';
}

/** Audited routes by Fastify route pattern. */
const AUDITED: Readonly<Record<string, Audited>> = {
  '/api/cases/:caseId': { action: 'case.view', scope: 'case' },
  '/api/cases/:caseId/runs': { action: 'case.view', scope: 'case' },
  '/api/runs/:runId': { action: 'run.view', scope: 'run' },
  '/api/runs/:runId/captures': { action: 'evidence.view', scope: 'run' },
  '/api/runs/:runId/observations': { action: 'evidence.view', scope: 'run' },
  '/api/runs/:runId/accounts': { action: 'evidence.view', scope: 'run' },
  '/api/runs/:runId/egress': { action: 'evidence.view', scope: 'run' },
  '/api/runs/:runId/links': { action: 'run.view', scope: 'run' },
  '/api/runs/:runId/report': { action: 'report.view', scope: 'run' },
  '/api/runs/:runId/exports/:format': { action: 'export.download', scope: 'run' },
  '/api/captures/:captureId': { action: 'evidence.view', scope: 'none' },
  '/api/blobs/:sha256': { action: 'evidence.view', scope: 'none' },
  '/api/access-log': { action: 'audit.view', scope: 'none' },
};

const outcomeOf = (status: number): AccessLogEntry['outcome'] =>
  status === 401 || status === 403 ? 'denied' : status >= 400 ? 'failed' : 'ok';

/** Stated purpose: the `X-Olcys-Purpose` header (trimmed, at most 500 characters). */
function statedPurpose(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-olcys-purpose'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 500);
  return value || undefined;
}

export interface AccessLogOptions {
  repos: Repositories;
  analyst: string;
  onError(error: unknown): void;
}

/** One access-log row per audited request (reads only; HEAD and GET), written after the response is sent. */
export function registerAccessLog(app: FastifyInstance, options: AccessLogOptions): void {
  const { repos } = options;
  const log = repos.accessLog;
  if (!log) return;
  app.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    const pattern = request.routeOptions.url;
    const audited = pattern ? AUDITED[pattern] : undefined;
    if (!audited) return;
    try {
      const params = request.params as { caseId?: string; runId?: string; format?: string };
      let caseId: Id | undefined;
      let runId: Id | undefined;
      if (audited.scope === 'case') caseId = idOf(params.caseId ?? '');
      if (audited.scope === 'run') {
        runId = idOf(params.runId ?? '');
        caseId = runId ? (await repos.runs.get(runId))?.caseId : undefined;
      }
      const purpose = statedPurpose(request) ?? (caseId ? (await repos.cases.get(caseId))?.purpose : undefined);
      await log.add({
        id: newId(),
        at: nowIso(),
        actor: options.analyst,
        action: audited.action,
        ...(caseId ? { caseId } : {}),
        ...(runId ? { runId } : {}),
        resource: params.format ? `${pattern}#${params.format}` : (pattern ?? ''),
        ...(purpose ? { purpose } : {}),
        outcome: outcomeOf(reply.statusCode),
        ip: request.ip,
      });
    } catch (error) {
      options.onError(error);
    }
  });
}

/**
 * Pino options of the API request log: secrets and credentials are redacted, request lines carry the path only
 * (query strings can hold identifiers) and no request headers are logged at all.
 */
export function httpLogOptions(): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.authorization',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: request.url.split('?')[0],
        host: request.headers.host,
        remoteAddress: request.ip,
      }),
    },
  };
}
