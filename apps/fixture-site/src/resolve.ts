/**
 * Pure request resolution for the fixture site (Node built-ins only). Routes come from `routes.json` in
 * `public/<variant>/` and `public/shared/` (variant first); files resolve in the same order.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

export type Variant = 'v1' | 'v2';
export const VARIANTS: readonly Variant[] = ['v1', 'v2'];

export interface FixtureRoute {
  /** Exact pathname (or the one the route's `pathPrefix` replaces). */
  path: string;
  /** Matches every pathname starting with this prefix instead of `path` (e.g. NBP ranges ending on any day). */
  pathPrefix?: string;
  /** Exact raw search without `?`, e.g. `action=profile;u=900001` (SMF uses `;`). */
  query?: string;
  /** Subset match on URLSearchParams, order- and case-insensitive (Etherscan treats addresses case-insensitively). */
  params?: Record<string, string>;
  /** Raw search starts with. */
  queryPrefix?: string;
  status?: number;
  headers?: Record<string, string>;
  /** Relative file, resolved in `public/<variant>` first, then `public/shared`. */
  file?: string;
}

export interface Resolved {
  file?: string;
  status: number;
  headers: Record<string, string>;
}

export async function loadRoutes(root: string, variant: Variant): Promise<FixtureRoute[]> {
  const routes: FixtureRoute[] = [];
  for (const dir of [variant, 'shared']) {
    let text: string;
    try {
      // Sequential on purpose: variant routes must precede shared ones.
      // oxlint-disable-next-line no-await-in-loop
      text = await readFile(join(root, dir, 'routes.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    routes.push(...(JSON.parse(text) as { routes: FixtureRoute[] }).routes);
  }
  return routes;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Resolves a relative path inside `public/<variant>` then `public/shared`, refusing path traversal. */
export async function resolveFile(
  root: string,
  variant: Variant,
  relativePath: string,
  fallbacks: (p: string) => string[] = (p) => [p],
): Promise<string | undefined> {
  const relative = normalize(relativePath).replace(/^([/\\])+/, '');
  for (const dir of [variant, 'shared']) {
    const base = join(root, dir);
    for (const option of fallbacks(relative)) {
      const candidate = join(base, option);
      if (candidate !== base && !candidate.startsWith(base + sep)) continue; // path traversal guard
      // Sequential on purpose: the first existing file wins.
      // oxlint-disable-next-line no-await-in-loop
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

const PATH_FALLBACKS = (p: string): string[] => [p, join(p, 'index.html'), `${p}.json`, join(p, 'index.json')];

type Matcher = (route: FixtureRoute, search: string) => boolean;

/** Match order: exact `query`, then `params`, then `queryPrefix`, then path-only routes. */
const MATCHERS: Matcher[] = [
  (r, search) => r.query !== undefined && r.query === search,
  (r, search) => {
    if (r.query !== undefined || !r.params) return false;
    const params = new URLSearchParams(search);
    return Object.entries(r.params).every(([key, value]) => params.get(key)?.toLowerCase() === value.toLowerCase());
  },
  (r, search) =>
    r.query === undefined && r.params === undefined && r.queryPrefix !== undefined && search.startsWith(r.queryPrefix),
  (r) => r.query === undefined && r.params === undefined && r.queryPrefix === undefined,
];

export async function resolveRequest(
  root: string,
  variant: Variant,
  routes: readonly FixtureRoute[],
  pathname: string,
  search: string,
): Promise<Resolved | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const candidates = routes.filter((r) =>
    r.pathPrefix !== undefined ? decoded.startsWith(r.pathPrefix) : r.path === decoded,
  );
  for (const matcher of MATCHERS) {
    const route = candidates.find((r) => matcher(r, search));
    if (!route) continue;
    const headers = route.headers ?? {};
    if (route.file === undefined) return { status: route.status ?? 200, headers };
    // Sequential: at most one route matches, then its file is resolved.
    // oxlint-disable-next-line no-await-in-loop
    const file = await resolveFile(root, variant, route.file);
    return file ? { file, status: route.status ?? 200, headers } : undefined;
  }
  const file = await resolveFile(root, variant, decoded, PATH_FALLBACKS);
  return file ? { file, status: 200, headers: {} } : undefined;
}
