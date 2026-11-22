/**
 * Loopback-only HTTP for the demo script. The one place under `scripts/demo/` allowed to call `fetch` (see the oxlint
 * override): it talks only to the developer's own local API and fixture site, never to a third party, and refuses any
 * URL whose host is not a loopback address. Product code keeps going through `@olcys/http`.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class NotLoopbackError extends Error {}

/** Parses the URL and throws unless it is plain http(s) on a loopback host; returns it without a trailing slash. */
export function assertLoopbackUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotLoopbackError(`not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NotLoopbackError(`not an http URL: ${value}`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new NotLoopbackError(`not a loopback host: ${url.hostname}`);
  return url.origin;
}

export interface LocalResponse {
  status: number;
  text: string;
}

/** The service could not be reached (connection refused/reset, host unreachable or unknown, timeout). */
export interface Unreachable {
  unreachable: true;
  /** Error code or name of the underlying failure, e.g. `ECONNREFUSED`. */
  cause: string;
}

export const isUnreachable = (value: LocalResponse | Unreachable): value is Unreachable => 'unreachable' in value;

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND']);

/** Classifies a failure as a real connection problem (returns its code) or `undefined` for anything unexpected. */
export function connectionFailure(error: unknown): string | undefined {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return error.name;
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) return code;
  }
  return undefined;
}

/** Request over loopback. Connection failures come back as `Unreachable`; every other error is rethrown. */
export async function localRequest(
  url: string,
  init: { method?: string; body?: string; contentType?: string } = {},
): Promise<LocalResponse | Unreachable> {
  assertLoopbackUrl(url);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: init.contentType ? { 'content-type': init.contentType } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    const cause = connectionFailure(error);
    if (cause === undefined) throw error;
    return { unreachable: true, cause };
  }
}
