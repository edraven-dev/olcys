/**
 * The synthetic fixture site's HTTP server (Node built-ins only: it runs in compose from a read-only mount without
 * node_modules). Every response is marked `x-olcys-synthetic: true`.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';
import { loadRoutes, resolveRequest, type FixtureRoute, type Variant } from './resolve.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface FixtureServerOptions {
  root: string;
  variant: Variant;
  host: string;
  port: number;
  /** Enables `POST /__fixture/variant` (body `v1` or `v2`) to switch variants at runtime. Off by default. */
  allowVariantSwitch: boolean;
}

export interface FixtureServer {
  url: string;
  port: number;
  variant(): Variant;
  close(): Promise<void>;
}

async function readSmallBody(req: IncomingMessage, limit: number): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > limit) throw new Error('body too large');
  }
  return body.trim();
}

export async function createFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  let variant = options.variant;
  let routes: FixtureRoute[] = await loadRoutes(options.root, variant);

  const send = (res: ServerResponse, status: number, headers: Record<string, string>, body?: string | Buffer) => {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'x-olcys-synthetic': 'true',
      'x-olcys-fixture-variant': variant,
      ...headers,
    });
    res.end(body);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const method = req.method ?? 'GET';
    const text = { 'content-type': 'text/plain; charset=utf-8' };

    if (method === 'POST' && url.pathname === '/__fixture/variant' && options.allowVariantSwitch) {
      const requested = await readSmallBody(req, 16);
      if (requested !== 'v1' && requested !== 'v2') return send(res, 400, text, 'expected v1 or v2');
      variant = requested;
      routes = await loadRoutes(options.root, variant);
      return send(res, 204, {});
    }
    if (method !== 'GET' && method !== 'HEAD')
      return send(res, 405, { ...text, allow: 'GET, HEAD' }, 'method not allowed');
    if (url.pathname === '/healthz') return send(res, 200, text, `ok ${variant}`);

    const resolved = await resolveRequest(options.root, variant, routes, url.pathname, url.search.replace(/^\?/, ''));
    if (!resolved) return send(res, 404, text, 'not found');
    if (!resolved.file) return send(res, resolved.status, resolved.headers, method === 'HEAD' ? undefined : '');
    const body = await readFile(resolved.file);
    const headers = {
      'content-type': MIME[extname(resolved.file)] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      ...resolved.headers,
    };
    return send(res, resolved.status, headers, method === 'HEAD' ? undefined : body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[fixture-site]', error);
      if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'internal error');
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const port = (server.address() as AddressInfo).port;
  const hostForUrl = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${hostForUrl}:${port}`,
    port,
    variant: () => variant,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
