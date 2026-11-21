import type { EgressClient } from '@olcys/core';

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/** Minimal RFC 9309 parser: groups by user-agent, longest matching rule wins, Allow beats Disallow on ties. */
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
      if (value) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function matches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    `^${body
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`,
  );
  return regex.test(path);
}

export function isAllowedByRobots(groups: Group[], userAgent: string, path: string): boolean {
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!matches(path, rule.path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

/** Fetches and caches `/robots.txt` per origin through the egress client. A missing robots.txt allows everything. */
export class RobotsCache {
  private readonly client: EgressClient;
  private readonly userAgent: string;
  private readonly cache = new Map<string, Promise<Group[]>>();

  constructor(client: EgressClient, userAgent: string) {
    this.client = client;
    this.userAgent = userAgent;
  }

  async isAllowed(url: string, sourceId: string): Promise<boolean> {
    const target = new URL(url);
    let groups = this.cache.get(target.origin);
    if (!groups) {
      groups = this.client
        .fetch({
          url: `${target.origin}/robots.txt`,
          sourceId,
          purpose: 'robots.txt',
          containsIdentifier: false,
        })
        .then((res) => (res.status >= 200 && res.status < 300 ? parseRobots(res.text()) : []))
        .catch(() => []);
      this.cache.set(target.origin, groups);
    }
    return isAllowedByRobots(await groups, this.userAgent, `${target.pathname}${target.search}`);
  }
}
