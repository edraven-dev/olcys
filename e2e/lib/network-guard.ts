import type { BrowserContext } from '@playwright/test';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True for the hosts the console may contact: loopback only. */
export function isLocalUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    // data:/blob:/about: never leave the browser.
    if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') return true;
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export interface NetworkGuard {
  /** Every attempted request to a non-local host. */
  violations: string[];
  /** Uncaught page errors and console errors (CSP violations show up here). */
  pageErrors: string[];
}

/**
 * Records every request whose host is not loopback and aborts it, plus page and console errors. The test asserts both
 * lists empty at the end.
 */
export async function guardNetwork(
  context: BrowserContext,
  /** Known console messages that are tolerated (each one needs a reason at the call site). */
  tolerated: RegExp[] = [],
): Promise<NetworkGuard> {
  const guard: NetworkGuard = { violations: [], pageErrors: [] };
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocalUrl(url)) return route.fallback();
    guard.violations.push(`${route.request().method()} ${url}`);
    return route.abort('blockedbyclient');
  });
  const watch = (page: import('@playwright/test').Page) => {
    page.on('pageerror', (error) => guard.pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !tolerated.some((re) => re.test(`${message.text()} @ ${page.url()}`)))
        guard.pageErrors.push(`console: ${message.text()} @ ${page.url()}`);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on('page', watch);
  return guard;
}
