/**
 * P2P classified ads (the fixture's "Tablica Testowa", offline only, served by the fixture site source). Ads come
 * from the watch list and are kept only when the seller's name, login or e-mail matches a case identifier.
 */
import type { CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { safeDecode, usesFixtures } from '../framework/urls.ts';
import { blockText, isoDateTime, parseHtml, textOf } from '../html/dom.ts';
import { fetchPage } from '../html/page.ts';
import { observer } from './common.ts';
import { matchedKinds, matchIdentifiers } from './match.ts';

export const TABLICA_PARSER_VERSION = 'tablica-fixture.v1';
const SOFTWARE = [{ name: 'parser:tablica', version: TABLICA_PARSER_VERSION }];
const AD_PATH = /\/tablica\/ogloszenie\/(\d{1,12})\/?$/;

function defined<T extends Record<string, string | undefined>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<T>;
}

function adUrls(input: CollectorInput): { url: string; search: boolean }[] {
  return (input.values ?? [])
    .filter((v) => v.kind === 'url' && AD_PATH.test(URL.parse(v.value)?.pathname ?? ''))
    .map((v) => ({ url: v.value, search: v.method === 'search' }));
}

export interface ClassifiedAd {
  adId?: string;
  title?: string;
  price?: string;
  publishedAt?: string;
  description?: string;
  seller: { name?: string; login?: string; email?: string; since?: string };
}

export function parseClassifiedAd(html: string): ClassifiedAd {
  const doc = parseHtml(html);
  const ad = doc.querySelector('article.ad');
  const seller = doc.querySelector('aside.seller');
  const description = ad?.querySelector('.ad-description');
  const mailto = seller?.querySelector('a[href^="mailto:"]')?.getAttribute('href');
  const email = mailto ? safeDecode(mailto.slice('mailto:'.length).split('?')[0] ?? '')?.trim() : undefined;
  const fields = {
    adId: ad?.getAttribute('data-ad-id')?.trim(),
    title: textOf(ad?.querySelector('.ad-title')),
    price: textOf(ad?.querySelector('.ad-price')),
    publishedAt: isoDateTime(ad?.querySelector('time.ad-date')?.getAttribute('datetime')),
    description: description ? blockText(description) : undefined,
  };
  const sellerFields = {
    name: textOf(seller?.querySelector('.seller-name')),
    login: textOf(seller?.querySelector('.seller-handle')),
    email,
    since: isoDateTime(seller?.querySelector('.seller-since time')?.getAttribute('datetime')),
  };
  return { ...defined(fields), seller: defined(sellerFields) };
}

export function createClassifiedAdsCollector(): CollectorFactory {
  return {
    sourceId: 'fixture_site',
    platform: 'tablica',
    watchesPages: true,
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => usesFixtures(deps.mode) && adUrls(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          if (!usesFixtures(deps.mode)) {
            rb.note('unsupported_input', 'classified ads are read from the fixture site only');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const { url, search } of adUrls(input)) {
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            const page = await fetchPage(http, {
              url,
              purpose: 'classified ad',
              containsIdentifier: false,
              software: SOFTWARE,
            });
            if (page.status !== 'ok' || !page.capture || page.body === undefined) {
              rb.addPage(page);
              if (page.status === 'not_found') rb.affirmNotFound(`classified ad ${url}`);
              continue;
            }
            const ad = parseClassifiedAd(page.body);
            const found = matchIdentifiers(input.identifiers, [
              { field: 'seller.email', text: ad.seller.email },
              { field: 'seller.name', text: ad.seller.name },
              { field: 'seller.login', text: ad.seller.login },
              { field: 'ad.description', text: ad.description },
            ]);
            if (search && !found.length) {
              // Data minimisation: an ad of someone else is not kept (its fetch stays in the egress log).
              rb.note('no_identifier_match', page.logicalUrl);
              rb.affirmNotFound(`no case identifier in ${page.logicalUrl}`);
              continue;
            }
            rb.addPage(page);
            const capture = page.capture;
            const handle = ad.seller.login ?? ad.seller.name ?? `ad-${ad.adId ?? 'unknown'}`;
            const accountKey = `tablica:${handle.toLowerCase()}`;
            rb.account({
              platform: 'tablica',
              handle,
              profileUrl: page.logicalUrl,
              ...(ad.seller.name ? { displayName: ad.seller.name } : {}),
              discoveredVia: {
                sourceId: descriptor.id,
                method: search ? 'search' : 'cross_link',
                captureId: capture.id,
              },
            });
            const seller = observer(rb, capture, 'account', accountKey);
            seller('profile.name', ad.seller.name);
            seller('profile.login', ad.seller.login);
            seller('profile.email', ad.seller.email);
            seller('profile.member_since', ad.seller.since);
            matchedKinds(found).forEach((kind, i) => seller('computed.identifier_match', kind, i));
            const post = observer(rb, capture, 'page', `tablica:ad=${ad.adId ?? handle}`);
            post('post.author', accountKey);
            post('post.author_name', ad.seller.name);
            post('post.title', ad.title);
            post('post.published_at', ad.publishedAt);
            post('post.price', ad.price);
            post('post.url', page.logicalUrl);
            post('post.text', ad.description);
          }
          return rb.build();
        },
      };
    },
  };
}
