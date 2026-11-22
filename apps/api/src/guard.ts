/**
 * Request guard of the local API (no authentication, loopback only): a browser on another site must not be able to
 * reach it. DNS rebinding is stopped by checking the `Host` header, cross-site writes by checking the `Origin` header
 * of state-changing requests. Tools without an `Origin` (curl, scripts) keep working for reads and writes alike.
 */
import type { FastifyInstance } from 'fastify';

const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;
/** Default port of the web app's dev server (`WEB_PORT`), the only browser origin allowed by default. */
const WEB_PORT = '5173';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface GuardOptions {
  /** Extra allowed `Host` values: a bare host name (any port) or `host:port`. Defaults are always allowed. */
  allowedHosts?: readonly string[];
  /** Port of the web app's dev server when it is not the default 5173 (`WEB_PORT`). */
  webPort?: string;
  /** Extra allowed `Origin` values (full origins such as `https://console.example`). */
  allowedOrigins?: readonly string[];
}

/** Splits `host:port` (and `[::1]:port`) into its host name (lower-case) and port. */
function splitHost(value: string): { host: string; port?: string } {
  const lower = value.trim().toLowerCase();
  const match = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(lower);
  if (!match) return { host: lower };
  return { host: match[1] ?? lower, ...(match[2] ? { port: match[2] } : {}) };
}

/** Comma-separated list from the environment (`OLCYS_API_ALLOWED_HOSTS`), empty entries dropped. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

export function createGuard(options: GuardOptions = {}) {
  const extraHosts = (options.allowedHosts ?? []).map(splitHost);
  const origins = new Set<string>([
    ...DEFAULT_HOSTS.map((h) => `http://${h}:${options.webPort || WEB_PORT}`),
    ...(options.allowedOrigins ?? []).map((o) => o.toLowerCase().replace(/\/+$/, '')),
    // A host the operator allows (e.g. behind a reverse proxy) may also be the origin of the console.
    ...(options.allowedHosts ?? []).flatMap((h) => [`http://${h.toLowerCase()}`, `https://${h.toLowerCase()}`]),
  ]);

  return {
    hostAllowed(header: string | undefined): boolean {
      if (!header) return false;
      const requested = splitHost(header);
      if ((DEFAULT_HOSTS as readonly string[]).includes(requested.host)) return true;
      return extraHosts.some((a) => a.host === requested.host && (a.port === undefined || a.port === requested.port));
    },
    originAllowed(origin: string): boolean {
      return origins.has(origin.toLowerCase().replace(/\/+$/, ''));
    },
  };
}

/** Registers the `onRequest` guard: 421 for an unknown `Host`, 403 for a state-changing request from another origin. */
export function registerGuard(app: FastifyInstance, options: GuardOptions = {}): void {
  const guard = createGuard(options);
  app.addHook('onRequest', async (request, reply) => {
    if (!guard.hostAllowed(request.headers.host)) {
      return reply.code(421).send({ error: 'misdirected_request', message: 'host not allowed' });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && STATE_CHANGING.has(request.method) && !guard.originAllowed(origin)) {
      return reply.code(403).send({ error: 'forbidden_origin', message: 'origin not allowed' });
    }
    return undefined;
  });
}
