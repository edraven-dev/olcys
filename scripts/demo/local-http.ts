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

/** Request over loopback; network failures are returned as `undefined` so callers can print a hint. */
export async function localRequest(
  url: string,
  init: { method?: string; body?: string; contentType?: string } = {},
): Promise<LocalResponse | undefined> {
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
  } catch {
    return undefined;
  }
}
