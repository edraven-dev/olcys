/**
 * Live ↔ fixture URL mapping (offline mode) and recognition of account URLs. Adapters always build live URLs;
 * parsers and locators never depend on the host, so offline and live runs produce the same observations.
 */
import type { FetchMode } from '@olcys/core';
import { NoFixtureError } from './errors.ts';

/** Live host (optionally with an API path) → fixture path prefix; the persona manifest's `hostPrefixes` override it. */
export const DEFAULT_HOST_PREFIXES: Readonly<Record<string, string>> = {
  'bitcointalk.org': '/bitcointalk',
  'wykop.pl': '/wykop',
  'github.com': '/github',
  'raw.githubusercontent.com': '/github-raw',
  't.me': '/telegram',
  'mempool.space/api': '/chain/esplora/api',
  'blockstream.info/api': '/chain/esplora/api',
  'api.etherscan.io/v2/api': '/chain/etherscan/v2/api',
  'api.trongrid.io': '/chain/trongrid',
};

export interface FixtureMapping {
  /** e.g. `http://127.0.0.1:4100` (`OLCYS_FIXTURE_BASE_URL` / `FIXTURE_SITE_URL`). */
  baseUrl: string;
  hostPrefixes: Readonly<Record<string, string>>;
}

interface PrefixEntry {
  host: string;
  path: string;
  prefix: string;
}

function entries(hostPrefixes: Readonly<Record<string, string>>): PrefixEntry[] {
  return Object.entries(hostPrefixes)
    .map(([key, prefix]) => {
      const slash = key.indexOf('/');
      const host = (slash < 0 ? key : key.slice(0, slash)).toLowerCase();
      const path = slash < 0 ? '' : key.slice(slash).replace(/\/+$/, '');
      return { host, path, prefix: `/${prefix.replace(/^\/+|\/+$/g, '')}` };
    })
    .toSorted((a, b) => b.host.length + b.path.length - (a.host.length + a.path.length));
}

function base(mapping: FixtureMapping): URL {
  return new URL(mapping.baseUrl);
}

function basePath(mapping: FixtureMapping): string {
  return base(mapping).pathname.replace(/\/+$/, '');
}

function underPath(pathname: string, prefix: string): boolean {
  return prefix === '' || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True when `url` is served by the fixture site (same origin as the base URL). */
export function isFixtureUrl(url: string, mapping: FixtureMapping): boolean {
  try {
    return new URL(url).origin === base(mapping).origin;
  } catch {
    return false;
  }
}

/** Offline: live URL → fixture URL (path and query kept, fragment dropped). Throws `NoFixtureError` when unmapped. */
export function toFixtureUrl(liveUrl: string, mapping: FixtureMapping): string {
  const url = new URL(liveUrl);
  if (url.origin === base(mapping).origin) return url.toString();
  const host = url.hostname.toLowerCase();
  for (const entry of entries(mapping.hostPrefixes)) {
    if (entry.host !== host || !underPath(url.pathname, entry.path)) continue;
    const rest = url.pathname.slice(entry.path.length);
    return `${base(mapping).origin}${basePath(mapping)}${entry.prefix}${rest}${url.search}`;
  }
  throw new NoFixtureError(host);
}

/** The URL actually requested in `mode`: offline maps live hosts to the fixture site, live and replay keep it. */
export function resolveSourceUrl(liveUrl: string, mode: FetchMode, mapping: FixtureMapping): string {
  return mode === 'offline' ? toFixtureUrl(liveUrl, mapping) : liveUrl;
}

/** Fixture URL → the live URL it stands for (unchanged when it is not a mapped fixture URL). */
export function toLogicalUrl(url: string, mapping: FixtureMapping): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.origin !== base(mapping).origin) return url;
  const path = parsed.pathname.slice(basePath(mapping).length) || '/';
  const candidates = entries(mapping.hostPrefixes).toSorted((a, b) => b.prefix.length - a.prefix.length);
  for (const entry of candidates) {
    if (!underPath(path, entry.prefix)) continue;
    const rest = path.slice(entry.prefix.length);
    return `https://${entry.host}${entry.path}${rest || (entry.path ? '' : '/')}${parsed.search}${parsed.hash}`;
  }
  return url;
}

export interface RecognisedAccount {
  platform: string;
  handle?: string;
  platformUserId?: string;
  /** Canonical live profile URL. */
  logicalUrl: string;
}

const GITHUB_RESERVED = new Set([
  'about',
  'apps',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'login',
  'join',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'issues',
  'search',
  'security',
  'settings',
  'site',
  'sponsors',
  'team',
  'topics',
  'trending',
]);
const TELEGRAM_RESERVED = new Set(['s', 'c', 'joinchat', 'addstickers', 'share', 'proxy', 'iv', 'socks', 'login']);
export const TELEGRAM_CHANNEL = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** RED platforms are recognised too, so the planner can record why a link to them was not followed. */
const RED_PLATFORMS: Readonly<Record<string, string>> = {
  'x.com': 'x_twitter',
  'twitter.com': 'x_twitter',
  'reddit.com': 'reddit',
  'facebook.com': 'meta',
  'instagram.com': 'meta',
  'linkedin.com': 'linkedin',
  'youtube.com': 'youtube',
  'discord.com': 'discord',
  'linktr.ee': 'linktree',
};

/** Recognises a profile URL of a known platform (fixture URLs are mapped back to live URLs first). */
export function recogniseAccountUrl(url: string, mapping?: FixtureMapping): RecognisedAccount | undefined {
  let parsed: URL;
  try {
    parsed = new URL(mapping ? toLogicalUrl(url, mapping) : url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'bitcointalk.org') {
    const search = decodeURIComponent(parsed.search);
    if (!/action=profile/.test(search)) return undefined;
    const uid = /[?;&]u=(\d{1,8})(?![\d])/.exec(search)?.[1];
    if (uid) return { platform: 'bitcointalk', platformUserId: uid, logicalUrl: bitcointalkProfileUrl(uid) };
    const user = /[?;&]user=([^;&#]+)/.exec(search)?.[1];
    if (user) {
      return {
        platform: 'bitcointalk',
        handle: user,
        logicalUrl: `https://bitcointalk.org/index.php?action=profile;user=${encodeURIComponent(user)}`,
      };
    }
    return undefined;
  }
  if (host === 'wykop.pl' && segments[0] === 'ludzie' && segments[1] && segments.length === 2) {
    return { platform: 'wykop', handle: segments[1], logicalUrl: `https://wykop.pl/ludzie/${segments[1]}/` };
  }
  if (host === 'github.com' && segments.length === 1 && segments[0]) {
    const login = segments[0];
    if (GITHUB_RESERVED.has(login.toLowerCase()) || !GITHUB_LOGIN.test(login)) return undefined;
    return { platform: 'github', handle: login, logicalUrl: `https://github.com/${login}` };
  }
  if (host === 't.me') {
    const name = segments[0] === 's' ? segments[1] : segments[0];
    const extra = segments[0] === 's' ? segments.length - 2 : segments.length - 1;
    if (!name || extra > 1 || TELEGRAM_RESERVED.has(name.toLowerCase()) || !TELEGRAM_CHANNEL.test(name))
      return undefined;
    return { platform: 'telegram', handle: name, logicalUrl: `https://t.me/s/${name}` };
  }
  const red = RED_PLATFORMS[host];
  if (red && segments[0]) return { platform: red, handle: segments[0], logicalUrl: parsed.toString() };
  return undefined;
}

export function bitcointalkProfileUrl(uid: string): string {
  return `https://bitcointalk.org/index.php?action=profile;u=${uid}`;
}

/** NFKC, lower case, leading `@` removed, runs of `-`, `_`, `.` → `_` (so `fikcyjny-kacper` ≡ `fikcyjny_kacper`). */
export function normaliseHandle(handle: string): string {
  return handle
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[-_.]+/g, '_');
}
