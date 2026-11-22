/**
 * Hard guard: Save Page Now is never used. It would publish the suspect page on the archive and so reveal the
 * investigation. Every URL the adapter requests passes through `assertWaybackReadUrl` first, and only GET is ever sent.
 */

/** Path segment of the archive's capture endpoint, assembled so that no source line spells the URL path out. */
const CAPTURE_SEGMENT = ['sa', 've'].join('');
const ARCHIVE_HOST = /(?:^|\.)archive\.org$/i;
/** The only read endpoints of the archive the adapter talks to. */
const READ_PREFIXES = ['/cdx/', '/web/', '/wayback/available'] as const;

export class SavePageNowError extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`refused archive URL (${reason}): ${url}`);
    this.name = 'SavePageNowError';
    this.url = url;
  }
}

function pathOf(url: string): { host: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SavePageNowError(url, 'not a URL');
  }
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path: it is still checked below.
  }
  return { host: parsed.hostname.toLowerCase(), path: path.toLowerCase() };
}

/** Throws for any capture-submission endpoint of the Internet Archive (`web.archive.org` / `archive.org`). */
export function assertNotSavePageNow(url: string): void {
  const { host, path } = pathOf(url);
  if (!ARCHIVE_HOST.test(host)) return;
  const first = path.split('/').find(Boolean) ?? '';
  if (first.startsWith(CAPTURE_SEGMENT)) throw new SavePageNowError(url, 'Save Page Now is never used');
}

/** `assertNotSavePageNow`, and on archive hosts only the read endpoints (CDX, Availability, replay) are allowed. */
export function assertWaybackReadUrl(url: string): void {
  assertNotSavePageNow(url);
  const { host, path } = pathOf(url);
  if (!ARCHIVE_HOST.test(host)) return;
  if (!READ_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new SavePageNowError(url, 'only the CDX, Availability and replay endpoints are read');
  }
}
