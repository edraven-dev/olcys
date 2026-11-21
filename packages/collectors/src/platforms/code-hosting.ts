/**
 * Code-hosting profile (GitHub-style fixture pages, offline only): profile → repositories → raw `FUNDING.json`
 * (Drips `ownedBy` claims). A same-nick account here may belong to someone else; scoring weighs that, not this.
 */
import type { SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { GITHUB_LOGIN, toLogicalUrl, type FixtureMapping } from '../framework/urls.ts';
import { absoluteHref, all, blockText, parseHtml, textOf } from '../html/dom.ts';
import { fetchPage, JSON_ACCEPT } from '../html/page.ts';
import { handleTarget, observer } from './common.ts';

export const GITHUB_PARSER_VERSION = 'github-fixture.v1';
const SOFTWARE = [{ name: 'parser:github', version: GITHUB_PARSER_VERSION }];

/** GitHub logins allow letters, digits and single hyphens: `fikcyjny_kacper` → `fikcyjny-kacper`. */
export function githubLogin(nick: string): string | undefined {
  const login = nick
    .trim()
    .replace(/^@+/, '')
    .replace(/[_.\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return GITHUB_LOGIN.test(login) ? login : undefined;
}

export interface CodeHostingProfile {
  login?: string;
  name?: string;
  bio?: string;
  repositories: { name: string; url: string }[];
}

function logicalPath(href: string | undefined, mapping?: FixtureMapping): URL | undefined {
  if (!href) return undefined;
  try {
    return new URL(mapping ? toLogicalUrl(href, mapping) : href);
  } catch {
    return undefined;
  }
}

export function parseGithubProfile(html: string, pageUrl: string, mapping?: FixtureMapping): CodeHostingProfile {
  const doc = parseHtml(html);
  const login = textOf(doc.querySelector('.vcard-username')) || undefined;
  const name = textOf(doc.querySelector('.vcard-fullname')) || undefined;
  const bio = textOf(doc.querySelector('.user-profile-bio')) || undefined;
  const repositories: { name: string; url: string }[] = [];
  for (const anchor of all(doc, '.repositories a[href]')) {
    const url = logicalPath(absoluteHref(anchor, pageUrl), mapping);
    const [owner, repo, ...rest] = url?.pathname.split('/').filter(Boolean) ?? [];
    if (url?.hostname !== 'github.com' || !owner || !repo || rest.length) continue;
    if (login && owner.toLowerCase() !== login.toLowerCase()) continue;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    if (!repositories.some((r) => r.url === repoUrl)) repositories.push({ name: repo, url: repoUrl });
  }
  return { ...(login ? { login } : {}), ...(name ? { name } : {}), ...(bio ? { bio } : {}), repositories };
}

export interface CodeRepositoryPage {
  readme?: string;
  /** Logical raw URL of the repository's `FUNDING.json`, when the file list links it. */
  fundingUrl?: string;
}

export function parseGithubRepository(
  html: string,
  pageUrl: string,
  repo: { owner: string; name: string },
  mapping?: FixtureMapping,
): CodeRepositoryPage {
  const doc = parseHtml(html);
  const readmeElement = doc.querySelector('.markdown-body');
  const readme = readmeElement ? blockText(readmeElement) : undefined;
  const prefix = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/`.toLowerCase();
  const fundingUrl = all(doc, '.files a[href]')
    .map((a) => logicalPath(absoluteHref(a, pageUrl), mapping)?.toString())
    .find((u) => u && u.toLowerCase().startsWith(prefix) && /\/funding\.json$/i.test(u));
  return { ...(readme ? { readme } : {}), ...(fundingUrl ? { fundingUrl } : {}) };
}

/** Drips claims of a `FUNDING.json`: `drips.<chain>.ownedBy` → `{ chain, address }`. */
export function parseFundingJson(text: string): { chain: string; address: string }[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const drips = (data as { drips?: unknown } | null)?.drips;
  if (!drips || typeof drips !== 'object') return [];
  return Object.entries(drips as Record<string, unknown>).flatMap(([chain, entry]) => {
    const owner = (entry as { ownedBy?: unknown } | null)?.ownedBy;
    return /^[a-z0-9_]+$/i.test(chain) && typeof owner === 'string' && owner.trim()
      ? [{ chain: chain.toLowerCase(), address: owner.trim() }]
      : [];
  });
}

export function createGithubCollector(): CollectorFactory {
  return {
    sourceId: 'github',
    platform: 'github',
    probeHandle: githubLogin,
    create(descriptor, deps): SourceCollector {
      const mapping = deps.config.fixture;
      const maxRepositories = deps.config.github.maxRepositories;
      return {
        descriptor,
        // HTML pages exist only on the fixture site; live GitHub access goes through its REST API (not in this build).
        supports: (input) =>
          deps.mode === 'offline' && handleTarget(input, 'github', githubLogin, mapping) !== undefined,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id);
          const target = deps.mode === 'offline' ? handleTarget(input, 'github', githubLogin, mapping) : undefined;
          if (!target) {
            rb.note('unsupported_input', 'no code-hosting login (the HTML pages are read offline only)');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const profileUrl = `https://github.com/${target.handle}`;
          const page = await fetchPage(http, {
            url: profileUrl,
            purpose: 'github profile',
            containsIdentifier: true,
            software: SOFTWARE,
          });
          rb.addPage(page);
          if (page.status === 'not_found') rb.affirmNotFound(`github account ${target.handle}`);
          if (page.status !== 'ok' || !page.capture || page.body === undefined) return rb.build();
          const profile = parseGithubProfile(page.body, page.capture.finalUrl, mapping);
          const login = profile.login ?? target.handle;
          const accountKey = `github:${login.toLowerCase()}`;
          rb.account({
            platform: 'github',
            handle: login,
            profileUrl: `https://github.com/${login}`,
            ...(profile.name ? { displayName: profile.name } : {}),
            discoveredVia: {
              sourceId: descriptor.id,
              method: target.method,
              captureId: target.foundIn ?? page.capture.id,
            },
          });
          const account = observer(rb, page.capture, 'account', accountKey);
          account('profile.name', profile.name);
          account('profile.bio', profile.bio);
          const repositories = profile.repositories.slice(0, maxRepositories);
          repositories.forEach((repo, i) => account('profile.repository', repo.url, i));
          if (profile.repositories.length > maxRepositories) {
            rb.note('truncated', `${profile.repositories.length} repositories, first ${maxRepositories} read`);
          }
          for (const repo of repositories) {
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            const repoPage = await fetchPage(http, {
              url: repo.url,
              purpose: 'github repository',
              containsIdentifier: true,
              software: SOFTWARE,
            });
            rb.addPage(repoPage);
            if (repoPage.status !== 'ok' || !repoPage.capture || repoPage.body === undefined) continue;
            const repoKey = `github:${login.toLowerCase()}/${repo.name.toLowerCase()}`;
            const parsed = parseGithubRepository(
              repoPage.body,
              repoPage.capture.finalUrl,
              { owner: login, name: repo.name },
              mapping,
            );
            const item = observer(rb, repoPage.capture, 'page', repoKey);
            item('post.author', accountKey);
            item('post.title', `${login}/${repo.name}`);
            item('post.url', repo.url);
            item('post.text', parsed.readme);
            if (!parsed.fundingUrl) continue;
            // oxlint-disable-next-line no-await-in-loop
            const funding = await fetchPage(http, {
              url: parsed.fundingUrl,
              purpose: 'github FUNDING.json',
              containsIdentifier: true,
              accept: JSON_ACCEPT,
              software: SOFTWARE,
            });
            rb.addPage(funding);
            if (funding.status !== 'ok' || !funding.capture || funding.body === undefined) continue;
            // Claims are facts about the account; the locator names the repository file they come from.
            const owner = { type: 'account' as const, key: accountKey };
            const at = (property: string): string => `${repoKey}#${property}`;
            for (const { chain, address } of parseFundingJson(funding.body)) {
              const property = `claim.drips.${chain}_address`;
              rb.observe(funding.capture, owner, property, address, at(property));
            }
            rb.observe(funding.capture, owner, 'claim.funding_json', funding.body.trim(), at('claim.funding_json'));
          }
          return rb.build();
        },
      };
    },
  };
}
