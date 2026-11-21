/**
 * Public channel web previews (`t.me/s/<channel>` markup). Previews only: no API, no login, no groups or private
 * channels. Channel posts are third-party statements (e.g. scam warnings); the channel is never pivoted on.
 */
import type { SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { TELEGRAM_CHANNEL } from '../framework/urls.ts';
import { all, blockText, isoDateTime, parseHtml, textOf } from '../html/dom.ts';
import { fetchPage } from '../html/page.ts';
import { handleTarget, observer } from './common.ts';
import { matchedKinds, matchIdentifiers } from './match.ts';

export const TELEGRAM_PARSER_VERSION = 'tgme.v1';
const SOFTWARE = [{ name: 'parser:telegram', version: TELEGRAM_PARSER_VERSION }];

export function telegramChannel(value: string): string | undefined {
  const name = value.trim().replace(/^@+/, '');
  return TELEGRAM_CHANNEL.test(name) ? name : undefined;
}

export interface ChannelPreview {
  isPreview: boolean;
  channel?: { username?: string; title?: string; description?: string };
  posts: { dataPost: string; id: string; publishedAt?: string; authorName?: string; text: string }[];
}

export function parseTelegramPreview(html: string): ChannelPreview {
  const doc = parseHtml(html);
  const info = doc.querySelector('.tgme_channel_info');
  const posts = all(doc, '.tgme_widget_message[data-post]').flatMap((message) => {
    const dataPost = message.getAttribute('data-post')?.trim() ?? '';
    const id = /\/(\d+)$/.exec(dataPost)?.[1];
    const textElement = message.querySelector('.tgme_widget_message_text');
    if (!id || !textElement) return [];
    const publishedAt = isoDateTime(message.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime'));
    const authorName = textOf(message.querySelector('.tgme_widget_message_owner_name'));
    return [
      {
        dataPost,
        id,
        ...(publishedAt ? { publishedAt } : {}),
        ...(authorName ? { authorName } : {}),
        text: blockText(textElement),
      },
    ];
  });
  if (!info) return { isPreview: false, posts };
  const username = textOf(info.querySelector('.tgme_channel_info_header_username')).replace(/^@+/, '');
  const title = textOf(info.querySelector('.tgme_channel_info_header_title'));
  const description = textOf(info.querySelector('.tgme_channel_info_description'));
  return {
    isPreview: true,
    channel: {
      ...(username ? { username } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    },
    posts,
  };
}

export function createTelegramCollector(): CollectorFactory {
  return {
    sourceId: 'telegram_preview',
    platform: 'telegram',
    probeHandle: telegramChannel,
    watchesPages: true,
    pivotOnAccounts: false,
    create(descriptor, deps): SourceCollector {
      const mapping = deps.config.fixture;
      return {
        descriptor,
        supports: (input) => handleTarget(input, 'telegram', telegramChannel, mapping) !== undefined,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const target = handleTarget(input, 'telegram', telegramChannel, mapping);
          if (!target) {
            rb.note('unsupported_input', 'no public channel name');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const search = target.method === 'search';
          const page = await fetchPage(http, {
            url: `https://t.me/s/${target.handle}`,
            purpose: 'telegram channel preview',
            // A watch-list channel name is configuration, not a case identifier (the URL net still checks it).
            containsIdentifier: !search,
            software: SOFTWARE,
          });
          if (page.status !== 'ok' || !page.capture || page.body === undefined) {
            rb.addPage(page);
            if (page.status === 'not_found') rb.affirmNotFound(`telegram channel ${target.handle}`);
            return rb.build();
          }
          const preview = parseTelegramPreview(page.body);
          if (!preview.isPreview || !/\/s\//.test(page.logicalUrl)) {
            rb.affirmNotFound(`no public preview for ${target.handle}`);
            return rb.build();
          }
          const matches = new Map(
            preview.posts.map((p) => [
              p.id,
              matchIdentifiers(input.identifiers, [{ field: 'post.text', text: p.text }]),
            ]),
          );
          if (search && ![...matches.values()].some((m) => m.length)) {
            rb.note('no_identifier_match', page.logicalUrl);
            rb.affirmNotFound(`no case identifier in ${page.logicalUrl}`);
            return rb.build();
          }
          rb.addPage(page);
          const capture = page.capture;
          const channel = preview.channel?.username ?? target.handle;
          const accountKey = `telegram:${channel.toLowerCase()}`;
          rb.account({
            platform: 'telegram',
            handle: channel,
            profileUrl: `https://t.me/${channel}`,
            ...(preview.channel?.title ? { displayName: preview.channel.title } : {}),
            discoveredVia: { sourceId: descriptor.id, method: target.method, captureId: target.foundIn ?? capture.id },
          });
          const account = observer(rb, capture, 'account', accountKey);
          account('profile.name', preview.channel?.title);
          account('profile.description', preview.channel?.description);
          for (const post of preview.posts) {
            // The page key equals the message's DOM anchor (data-post), so extraction can attribute mentions.
            const item = observer(rb, capture, 'page', `telegram:${post.dataPost}`);
            item('post.author', accountKey);
            item('post.author_name', post.authorName);
            item('post.published_at', post.publishedAt);
            item('post.url', `https://t.me/${post.dataPost}`);
            item('post.text', post.text);
            matchedKinds(matches.get(post.id) ?? []).forEach((kind, i) => item('computed.identifier_match', kind, i));
          }
          return rb.build();
        },
      };
    },
  };
}
