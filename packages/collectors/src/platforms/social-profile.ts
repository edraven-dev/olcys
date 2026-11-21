/**
 * Wykop-style social profile page (fixture markup, offline only): about text, links to other accounts
 * (`account.link`, e.g. the forum profile) and the profile's entries.
 */
import type { SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { recogniseAccountUrl, safeDecode, usesFixtures, type FixtureMapping } from '../framework/urls.ts';
import { absoluteHref, all, blockText, isoDateTime, parseHtml, textOf } from '../html/dom.ts';
import { fetchPage } from '../html/page.ts';
import { handleTarget, observer } from './common.ts';

export const WYKOP_PARSER_VERSION = 'wykop-fixture.v1';
const SOFTWARE = [{ name: 'parser:wykop', version: WYKOP_PARSER_VERSION }];
const WYKOP_HANDLE = /^[A-Za-z0-9_-]{2,35}$/;

export function wykopHandle(nick: string): string | undefined {
  const handle = nick.trim().replace(/^@+/, '');
  return WYKOP_HANDLE.test(handle) ? handle : undefined;
}

export function wykopProfileUrl(handle: string): string {
  return `https://wykop.pl/ludzie/${handle}/`;
}

export interface SocialProfilePage {
  handle?: string;
  about?: string;
  /** Logical profile URLs of other recognised accounts linked from the page. */
  links: string[];
  /** Links skipped because their percent-encoding is malformed (raw `href` values). */
  malformedLinks: string[];
  entries: { id: string; publishedAt?: string; text: string }[];
}

export function parseWykopProfile(html: string, pageUrl: string, mapping?: FixtureMapping): SocialProfilePage {
  const doc = parseHtml(html);
  const handle = textOf(doc.querySelector('h1.username')) || undefined;
  const aboutParagraphs = all(doc, 'section.about p').map((p) => blockText(p));
  const links: string[] = [];
  const malformedLinks: string[] = [];
  for (const anchor of all(doc, 'main a[href]')) {
    const raw = anchor.getAttribute('href') ?? '';
    if (safeDecode(raw) === undefined) {
      malformedLinks.push(raw);
      continue;
    }
    const href = absoluteHref(anchor, pageUrl);
    const account = href ? recogniseAccountUrl(href, mapping) : undefined;
    if (!account || (account.platform === 'wykop' && account.handle?.toLowerCase() === handle?.toLowerCase())) continue;
    if (!links.includes(account.logicalUrl)) links.push(account.logicalUrl);
  }
  const entries = all(doc, 'article.entry').flatMap((entry) => {
    const id = entry.getAttribute('data-entry-id')?.trim();
    const content = entry.querySelector('.entry-content');
    if (!id || !content) return [];
    const publishedAt = isoDateTime(entry.querySelector('time')?.getAttribute('datetime'));
    return [{ id, ...(publishedAt ? { publishedAt } : {}), text: blockText(content) }];
  });
  return {
    ...(handle ? { handle } : {}),
    ...(aboutParagraphs.length ? { about: aboutParagraphs.join('\n') } : {}),
    links,
    malformedLinks,
    entries,
  };
}

export function createWykopCollector(): CollectorFactory {
  return {
    sourceId: 'wykop',
    platform: 'wykop',
    probeHandle: wykopHandle,
    create(descriptor, deps): SourceCollector {
      const mapping = deps.config.fixture;
      return {
        descriptor,
        // Only the fixture page exists: the register's live Wykop access is an API that needs keys.
        supports: (input) =>
          usesFixtures(deps.mode) && handleTarget(input, 'wykop', wykopHandle, mapping) !== undefined,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const target = usesFixtures(deps.mode) ? handleTarget(input, 'wykop', wykopHandle, mapping) : undefined;
          if (!target) {
            rb.note('unsupported_input', 'no wykop handle (the profile page is read offline only)');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const profileUrl = wykopProfileUrl(target.handle);
          const page = await fetchPage(http, {
            url: profileUrl,
            purpose: 'wykop profile',
            containsIdentifier: true,
            software: SOFTWARE,
          });
          rb.addPage(page);
          if (page.status === 'not_found') rb.affirmNotFound(`wykop profile ${target.handle}`);
          if (page.status !== 'ok' || !page.capture || page.body === undefined) return rb.build();
          const capture = page.capture;
          const profile = parseWykopProfile(page.body, capture.finalUrl, mapping);
          const handle = profile.handle ?? target.handle;
          const accountKey = `wykop:${handle.toLowerCase()}`;
          rb.account({
            platform: 'wykop',
            handle,
            profileUrl,
            discoveredVia: { sourceId: descriptor.id, method: target.method, captureId: target.foundIn ?? capture.id },
          });
          const account = observer(rb, capture, 'account', accountKey);
          account('profile.about', profile.about);
          profile.links.forEach((link, i) => account('account.link', link, i));
          for (const link of profile.malformedLinks) rb.note('malformed_link', link);
          for (const entry of profile.entries) {
            // The page key equals the entry's DOM anchor (data-entry-id), so extraction can attribute mentions.
            const post = observer(rb, capture, 'page', `wykop:${entry.id}`);
            post('post.author', accountKey);
            post('post.author_name', handle);
            post('post.published_at', entry.publishedAt);
            post('post.url', `${profileUrl}#wpis-${entry.id}`);
            post('post.text', entry.text);
          }
          return rb.build();
        },
      };
    },
  };
}
