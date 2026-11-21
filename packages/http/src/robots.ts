import type { EgressClient } from '@olcys/core';

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export type RobotsDecision = { allowed: true } | { allowed: false; reason: string };

type RobotsRules =
  | { kind: 'rules'; groups: Group[] }
  | { kind: 'allow_all' }
  | { kind: 'disallow_all'; reason: string };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * RFC 9309 §2.2.2 normalisation, applied to both rule paths and request paths before comparison: non-ASCII characters
 * are percent-encoded (UTF-8), escapes of unreserved characters are decoded, other escapes are upper-cased.
 */
export function normaliseRobotsPath(value: string): string {
  let encoded = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    encoded += code > 0x7e || code < 0x20 ? encodeURIComponent(ch) : ch;
  }
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/** Minimal RFC 9309 parser: groups by user-agent; rule paths are normalised. */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value) current.rules.push({ allow: key === 'allow', path: normaliseRobotsPath(value) });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * `*`-wildcard match of the whole `text` against `pattern`, in O(text × pattern) without backtracking blow-up
 * (remote robots.txt rules must not be able to stall the process).
 */
function wildcardMatch(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = p;
      p += 1;
      starT = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** A rule matches a path prefix, unless it ends with `$` (then the whole path). */
function ruleMatches(path: string, rule: string): boolean {
  return rule.endsWith('$') ? wildcardMatch(path, rule.slice(0, -1)) : wildcardMatch(path, `${rule}*`);
}

/** The product token of a user-agent string, e.g. `olcys` for `OLCYS/0.1 (OSINT research prototype)`. */
function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[/\s]/)[0] ?? '').toLowerCase();
}

/** Longest matching rule wins; `Allow` wins ties; groups naming the product token replace the `*` group. */
export function isAllowedByRobots(groups: Group[], userAgent: string, path: string): boolean {
  const token = productToken(userAgent);
  const specific = groups.filter((g) => g.agents.includes(token));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const target = normaliseRobotsPath(path);
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!ruleMatches(target, rule.path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

export interface RobotsCacheOptions {
  /** Milliseconds before an unreachable robots.txt is fetched again (default 60 s). */
  retryAfterFailureMs?: number;
  /** Milliseconds a fetched robots.txt (or a 4xx answer) stays valid (default 24 h, RFC 9309 §2.4). */
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Fetches and caches `/robots.txt` per origin through the egress client (RFC 9309 §2.3.1): 2xx → parsed rules,
 * 4xx → no restrictions (both cached for `cacheTtlMs`, default 24 h), 5xx or an unreachable file → complete disallow
 * until a retry after `retryAfterFailureMs`.
 */
export class RobotsCache {
  private readonly client: EgressClient;
  private readonly userAgent: string;
  private readonly retryAfterFailureMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { rules: Promise<RobotsRules>; expiresAt: number }>();

  constructor(client: EgressClient, userAgent: string, options: RobotsCacheOptions = {}) {
    this.client = client;
    this.userAgent = userAgent;
    this.retryAfterFailureMs = options.retryAfterFailureMs ?? 60_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async isAllowed(url: string, sourceId: string): Promise<boolean> {
    return (await this.check(url, sourceId)).allowed;
  }

  async check(url: string, sourceId: string): Promise<RobotsDecision> {
    const target = new URL(url);
    let entry = this.cache.get(target.origin);
    if (!entry || entry.expiresAt <= this.now()) {
      const created = { rules: this.load(target.origin, sourceId), expiresAt: Number.POSITIVE_INFINITY };
      this.cache.set(target.origin, created);
      const rules = await created.rules;
      created.expiresAt = this.now() + (rules.kind === 'disallow_all' ? this.retryAfterFailureMs : this.cacheTtlMs);
      entry = created;
    }
    const rules = await entry.rules;
    if (rules.kind === 'allow_all') return { allowed: true };
    if (rules.kind === 'disallow_all') return { allowed: false, reason: rules.reason };
    return isAllowedByRobots(rules.groups, this.userAgent, `${target.pathname}${target.search}`)
      ? { allowed: true }
      : { allowed: false, reason: 'disallowed by robots.txt' };
  }

  private async load(origin: string, sourceId: string): Promise<RobotsRules> {
    try {
      const res = await this.client.fetch({
        url: `${origin}/robots.txt`,
        sourceId,
        purpose: 'robots.txt',
        containsIdentifier: false,
      });
      if (res.status >= 200 && res.status < 300) return { kind: 'rules', groups: parseRobots(res.text()) };
      if (res.status >= 400 && res.status < 500) return { kind: 'allow_all' };
      return { kind: 'disallow_all', reason: `robots.txt unreachable (HTTP ${res.status})` };
    } catch (error) {
      // Typed result, not a swallowed error: an unreachable robots.txt means complete disallow (RFC 9309).
      return {
        kind: 'disallow_all',
        reason: `robots.txt unreachable (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
}
