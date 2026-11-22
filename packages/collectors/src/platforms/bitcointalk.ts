/**
 * Bitcointalk-style (SMF 1.x) guest pages: profile → "Show Posts" → up to N topic pages. Pure parsers over the stored
 * HTML; signed-message blocks are split into address / text / signature and NOT verified here (scoring does that).
 */
import type {
  AccountDiscoveryMethod,
  Capture,
  CollectorInput,
  Id,
  IdentifierKind,
  IsoDateTime,
  SourceCollector,
} from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { bitcointalkProfileUrl, recogniseAccountUrl } from '../framework/urls.ts';
import { all, blockText, childElements, parseHtml, rawText, squash, textOf, type DomElement } from '../html/dom.ts';
import { fetchPage } from '../html/page.ts';
import { namesPages } from './common.ts';

export const BITCOINTALK_PARSER_VERSION = 'smf1.v1';
const SOFTWARE = [{ name: 'parser:bitcointalk', version: BITCOINTALK_PARSER_VERSION }];
const BASE = 'https://bitcointalk.org/index.php';
const UID = /^\d{1,8}$/;
const HANDLE_KINDS: ReadonlySet<IdentifierKind> = new Set(['nickname', 'social_login', 'messenger_id']);

export type BitcointalkUrlKind = 'profile' | 'profile_by_name' | 'show_posts' | 'topic_msg';

function validNick(nick: string): boolean {
  const n = nick.trim();
  return n.length > 0 && n.length <= 80 && !/[;&#?=<>"\\\p{Cc}]/u.test(n);
}

/** Builds the only URL shapes the adapter may request (guest pages); throws for anything else. */
export function bitcointalkUrl(
  kind: BitcointalkUrlKind,
  ids: { uid?: string; nick?: string; topicId?: string; msgId?: string },
): string {
  const uid = ids.uid ?? '';
  switch (kind) {
    case 'profile':
      if (!UID.test(uid)) throw new Error(`invalid bitcointalk uid: ${uid}`);
      return bitcointalkProfileUrl(uid);
    case 'show_posts':
      if (!UID.test(uid)) throw new Error(`invalid bitcointalk uid: ${uid}`);
      return `${BASE}?action=profile;u=${uid};sa=showPosts`;
    case 'profile_by_name':
      if (!ids.nick || !validNick(ids.nick)) throw new Error('invalid bitcointalk member name');
      return `${BASE}?action=profile;user=${encodeURIComponent(ids.nick.trim())}`;
    case 'topic_msg':
      if (!/^\d{1,9}$/.test(ids.topicId ?? '') || !/^\d{1,10}$/.test(ids.msgId ?? '')) {
        throw new Error('invalid bitcointalk topic or message id');
      }
      return `${BASE}?topic=${ids.topicId}.msg${ids.msgId}`;
  }
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** SMF dates (`November 01, 2026, 10:00:00 AM`, `Today at 10:00:00 AM`) in the guest time zone → ISO UTC. */
export function parseSmfDate(raw: string, reference: IsoDateTime, offsetMinutes = 0): IsoDateTime | undefined {
  const text = squash(raw.replace(/\u00a0/g, ' ')).replace(/^on:\s*/i, '');
  const time = /(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(text);
  if (!time) return undefined;
  let hour = Number(time[1]) % 12;
  if (time[4]?.toUpperCase() === 'PM') hour += 12;
  let year: number;
  let month: number;
  let day: number;
  const full = /^([A-Za-z]+) (\d{1,2}), (\d{4}),/.exec(text);
  if (full) {
    month = MONTHS.indexOf((full[1] ?? '').toLowerCase());
    day = Number(full[2]);
    year = Number(full[3]);
    if (month < 0) return undefined;
  } else if (/^today at/i.test(text)) {
    const local = new Date(Date.parse(reference) + offsetMinutes * 60_000);
    year = local.getUTCFullYear();
    month = local.getUTCMonth();
    day = local.getUTCDate();
  } else return undefined;
  const utc = Date.UTC(year, month, day, hour, Number(time[2]), Number(time[3])) - offsetMinutes * 60_000;
  return new Date(utc).toISOString();
}

const PROFILE_FIELDS: Readonly<Record<string, string>> = {
  name: 'name',
  posts: 'posts',
  activity: 'activity',
  merit: 'merit',
  position: 'position',
  'date registered': 'date_registered',
  email: 'email',
  website: 'website',
  'bitcoin address': 'bitcoin_address',
  'other contact info': 'other_contact_info',
  gender: 'gender',
  age: 'age',
  location: 'location',
  skype: 'skype',
  icq: 'icq',
  aim: 'aim',
  msn: 'msn',
  yim: 'yim',
};
/** Change on every visit: kept in the capture, never observed (they would flood the run diff). */
const VOLATILE_FIELDS = new Set(['last active', 'local time', 'current status']);
const PLACEHOLDERS = new Set(['hidden', 'n/a', '']);

export interface BitcointalkProfile {
  notFound: boolean;
  uid?: string;
  name?: string;
  /** Known, non-volatile fields by property suffix (`bitcoin_address`, `date_registered` as raw text, …). */
  fields: Record<string, string>;
  signatureText?: string;
}

export function parseBitcointalkProfile(html: string): BitcointalkProfile {
  const doc = parseHtml(html);
  const text = textOf(doc.body);
  if (/The user whose profile you are trying to view does not exist/i.test(text)) return { notFound: true, fields: {} };
  const fields: Record<string, string> = {};
  for (const row of all(doc, 'tr')) {
    const cells = childElements(row, 'td');
    if (cells.length !== 2) continue;
    const label = textOf(cells[0]).replace(/:\s*$/, '').toLowerCase();
    const property = PROFILE_FIELDS[label];
    if (!property || VOLATILE_FIELDS.has(label) || fields[property] !== undefined) continue;
    const valueCell = cells[1];
    if (!valueCell) continue;
    const value =
      property === 'website' ? (valueCell.querySelector('a[href]')?.getAttribute('href') ?? '') : textOf(valueCell);
    if (PLACEHOLDERS.has(value.trim().toLowerCase())) continue;
    fields[property] = value.trim();
  }
  const uidHref = doc.querySelector('a[href*="action=profile;u="]')?.getAttribute('href') ?? '';
  const uid = /[?;&]u=(\d{1,8})/.exec(uidHref)?.[1];
  const signature = doc.querySelector('div.signature');
  return {
    notFound: false,
    ...(uid ? { uid } : {}),
    ...(fields['name'] ? { name: fields['name'] } : {}),
    fields,
    ...(signature && textOf(signature) ? { signatureText: blockText(signature) } : {}),
  };
}

export interface SignedMessageBlock {
  index: number;
  address: string;
  text: string;
  signature: string;
  armor: 'electrum' | 'bitcoin_qt';
  inQuote: boolean;
  quoteAuthor?: string;
}

const SMILEYS: Readonly<Record<string, string>> = {
  smiley: ':)',
  wink: ';)',
  cheesy: ':D',
  grin: ';D',
  angry: '>:(',
  sad: ':(',
  shocked: ':o',
  cool: '8)',
  huh: '???',
  'roll eyes': '::)',
  tongue: ':P',
  embarrassed: ':-[',
  'lips sealed': ':-X',
  undecided: ':-\\',
  kiss: ':-*',
  cry: ":'(",
};

function smiley(element: DomElement): string | undefined {
  return SMILEYS[(element.getAttribute('alt') ?? '').trim().toLowerCase()];
}

// Armour lines may end in CRLF; the message between them is kept exactly as authored.
const ELECTRUM =
  /-----BEGIN BITCOIN SIGNED MESSAGE-----\r?\n([\s\S]*?)\r?\n-----BEGIN SIGNATURE-----\r?\n([^\r\n]+)\r?\n([^\r\n]+)\r?\n-----END BITCOIN SIGNED MESSAGE-----/g;
const BITCOIN_QT =
  /-----BEGIN BITCOIN SIGNED MESSAGE-----\r?\n([\s\S]*?)\r?\n-----BEGIN BITCOIN SIGNATURE-----\r?\n([\s\S]*?)\r?\n[\t ]*\r?\n([^\r\n]+)\r?\n-----END BITCOIN SIGNATURE-----/g;

function blocksIn(
  text: string,
  inQuote: boolean,
  quoteAuthor: string | undefined,
): Omit<SignedMessageBlock, 'index'>[] {
  const found: { at: number; block: Omit<SignedMessageBlock, 'index'> }[] = [];
  const quote = { inQuote, ...(quoteAuthor ? { quoteAuthor } : {}) };
  for (const m of text.matchAll(ELECTRUM)) {
    found.push({
      at: m.index,
      block: {
        text: m[1] ?? '',
        address: (m[2] ?? '').trim(),
        signature: (m[3] ?? '').trim(),
        armor: 'electrum',
        ...quote,
      },
    });
  }
  for (const m of text.matchAll(BITCOIN_QT)) {
    const address = /^Address:\s*(\S+)/im.exec(m[2] ?? '')?.[1] ?? '';
    found.push({
      at: m.index,
      block: { text: m[1] ?? '', address, signature: (m[3] ?? '').trim(), armor: 'bitcoin_qt', ...quote },
    });
  }
  return found.toSorted((a, b) => a.at - b.at).map((f) => f.block);
}

const isQuote = (element: DomElement): boolean => element.matches('div.quote, div.quoteheader');

/** Signed-message blocks of a post body: the author's own text first, then each quote (`inQuote`). */
export function findSignedMessages(post: DomElement): SignedMessageBlock[] {
  // Whitespace-preserving read: trimming or collapsing would change the signed text and fail verification.
  const own = blocksIn(rawText(post, { skip: isQuote, image: smiley }), false, undefined);
  const quoted = all(post, 'div.quote').flatMap((quote) => {
    const header = quote.previousElementSibling?.matches('div.quoteheader') ? quote.previousElementSibling : null;
    const author = /Quote from:\s*(.+?)\s+on\s/i.exec(textOf(header))?.[1];
    const text = rawText(quote, { skip: (el) => el !== quote && isQuote(el), image: smiley });
    return blocksIn(text, true, author);
  });
  return [...own, ...quoted].map((block, index) => Object.assign({ index }, block));
}

export interface BitcointalkPost {
  msgId: string;
  topicId: string;
  authorUid?: string;
  authorName?: string;
  subject?: string;
  board?: string;
  postedAtRaw?: string;
  text: string;
  edited: boolean;
  signedMessages: SignedMessageBlock[];
}

const TOPIC_MSG = /topic=(\d+)\.msg(\d+)/;

function postFrom(
  body: DomElement,
  link: DomElement | null,
  extra: Omit<BitcointalkPost, 'msgId' | 'topicId' | 'text' | 'edited' | 'signedMessages' | 'subject'>,
  edited: boolean,
): BitcointalkPost | undefined {
  const m = TOPIC_MSG.exec(link?.getAttribute('href') ?? '');
  if (!m?.[1] || !m[2]) return undefined;
  const subject = textOf(link);
  return {
    msgId: m[2],
    topicId: m[1],
    ...(subject ? { subject } : {}),
    ...extra,
    text: blockText(body, { image: smiley }),
    edited,
    signedMessages: findSignedMessages(body),
  };
}

/** Posts of a topic page or of a member's "Show Posts" page (`owner` = that member). */
export function parseBitcointalkPosts(
  html: string,
  page: 'topic' | 'show_posts',
  owner?: { uid: string; name?: string },
): BitcointalkPost[] {
  const doc = parseHtml(html);
  const posts: BitcointalkPost[] = [];
  if (page === 'show_posts') {
    for (const header of all(doc, 'tr.titlebg2')) {
      const body = header.nextElementSibling?.querySelector('div.post');
      if (!body) continue;
      const board = textOf(header.querySelector('a[href*="board="]'));
      const date = textOf(header.querySelector('div[align="right"]'));
      const post = postFrom(
        body,
        header.querySelector('a[href*="topic="]'),
        {
          ...(owner ? { authorUid: owner.uid } : {}),
          ...(owner?.name ? { authorName: owner.name } : {}),
          ...(board ? { board } : {}),
          ...(date ? { postedAtRaw: date } : {}),
        },
        false,
      );
      if (post) posts.push(post);
    }
    return posts;
  }
  const boards = all(doc, 'div.nav a[href*="board="]');
  const board = textOf(boards.at(-1));
  for (const cell of all(doc, 'td.td_headerandpost')) {
    const body = cell.querySelector('div.post');
    if (!body) continue;
    const author = cell.parentElement?.querySelector('td.poster_info a[href*="u="]') ?? null;
    const authorUid = /[?;&]u=(\d{1,8})/.exec(author?.getAttribute('href') ?? '')?.[1];
    const authorName = textOf(author);
    const date = textOf(cell.querySelector('div.smalltext'));
    const post = postFrom(
      body,
      cell.querySelector('div.subject a[href*="topic="]'),
      {
        ...(authorUid ? { authorUid } : {}),
        ...(authorName ? { authorName } : {}),
        ...(board ? { board } : {}),
        ...(date ? { postedAtRaw: date } : {}),
      },
      /Last edit:/i.test(textOf(cell)),
    );
    if (post) posts.push(post);
  }
  return posts;
}

const ADDRESS_LIKE = /(?:^|[^A-Za-z0-9])(?:bc1|[13]|0x|T)[A-Za-z0-9]{25,}/;

/**
 * Topics to open from "Show Posts": those with a signed block first, then those with an address-like token, then the
 * newest; each addressed by its lowest qualifying message id.
 */
export function selectTopics(posts: readonly BitcointalkPost[], max: number): { topicId: string; msgId: string }[] {
  const byTopic = new Map<string, BitcointalkPost[]>();
  for (const p of posts) byTopic.set(p.topicId, [...(byTopic.get(p.topicId) ?? []), p]);
  const tier = (p: BitcointalkPost): number => (p.signedMessages.length ? 0 : ADDRESS_LIKE.test(p.text) ? 1 : 2);
  return [...byTopic.entries()]
    .map(([topicId, items]) => {
      const best = Math.min(...items.map(tier));
      const qualifying = items.filter((p) => tier(p) === best);
      const msgId = qualifying.map((p) => p.msgId).toSorted((a, b) => Number(a) - Number(b))[0] ?? '';
      const newest = Math.max(...items.map((p) => Number(p.msgId)));
      return { topicId, msgId, best, newest };
    })
    .toSorted((a, b) => a.best - b.best || b.newest - a.newest)
    .slice(0, max)
    .map(({ topicId, msgId }) => ({ topicId, msgId }));
}

interface Target {
  uid?: string;
  nick?: string;
  method: AccountDiscoveryMethod;
  foundIn?: Id;
}

function targetOf(input: CollectorInput, resolveByName: boolean): Target | undefined {
  const byNick = (nick: string, method: AccountDiscoveryMethod, foundIn?: Id): Target | undefined =>
    resolveByName && validNick(nick) ? { nick: nick.trim(), method, ...(foundIn ? { foundIn } : {}) } : undefined;
  for (const value of input.values ?? []) {
    if (value.kind === 'url') {
      const account = recogniseAccountUrl(value.value);
      if (account?.platform !== 'bitcointalk') continue;
      const method = value.method ?? 'cross_link';
      if (account.platformUserId) {
        return { uid: account.platformUserId, method, ...(value.captureId ? { foundIn: value.captureId } : {}) };
      }
      const target = account.handle ? byNick(account.handle, method, value.captureId) : undefined;
      if (target) return target;
    }
    if (value.kind === 'username') {
      const target = byNick(value.value, value.method ?? 'enumeration');
      if (target) return target;
    }
  }
  // A task that names pages is about those pages only: its identifiers are for matching, never a fallback.
  if (namesPages(input)) return undefined;
  for (const account of input.accounts) {
    if (account.platform !== 'bitcointalk') continue;
    if (account.platformUserId && UID.test(account.platformUserId)) {
      return { uid: account.platformUserId, method: account.discoveredVia.method };
    }
    const target = byNick(account.handle, account.discoveredVia.method);
    if (target) return target;
  }
  for (const identifier of input.identifiers) {
    if (identifier.platform !== 'bitcointalk' || !HANDLE_KINDS.has(identifier.kind)) continue;
    const value = identifier.value.trim();
    if (UID.test(value)) return { uid: value, method: 'input' };
    const linked = recogniseAccountUrl(value);
    if (linked?.platform === 'bitcointalk' && linked.platformUserId)
      return { uid: linked.platformUserId, method: 'input' };
    const target = byNick(value, 'input');
    if (target) return target;
  }
  return undefined;
}

function smfClassify(body: string): { status: 'not_found' | 'error'; reason: string } | undefined {
  if (/The user whose profile you are trying to view does not exist/i.test(body)) {
    return { status: 'not_found', reason: 'member does not exist (SMF error page, HTTP 200)' };
  }
  if (/<title>\s*An Error Has Occurred!\s*<\/title>/i.test(body)) return { status: 'error', reason: 'SMF error page' };
  return undefined;
}

function emitPost(rb: ResultBuilder, capture: Capture, post: BitcointalkPost, offsetMinutes: number): void {
  const key = `bitcointalk:msg=${post.msgId}`;
  const subject = { type: 'page' as const, key };
  const at = (property: string): string => `${key}#${property}`;
  const observe = (property: string, value: string | undefined): void => {
    if (value) rb.observe(capture, subject, property, value, at(property));
  };
  observe('post.author', post.authorUid ? `bitcointalk:${post.authorUid}` : undefined);
  observe('post.author_name', post.authorName);
  observe('post.published_at', post.postedAtRaw && parseSmfDate(post.postedAtRaw, capture.collectedAt, offsetMinutes));
  observe('post.subject', post.subject);
  observe('post.board', post.board);
  observe('post.url', `${BASE}?topic=${post.topicId}.msg${post.msgId}#msg${post.msgId}`);
  observe('post.text', post.text);
  if (post.edited) observe('post.edited', 'true');
  for (const block of post.signedMessages) {
    // The author's own block is a fact about the author's account; a quoted copy stays on the quoting post.
    const owner =
      !block.inQuote && post.authorUid ? { type: 'account' as const, key: `bitcointalk:${post.authorUid}` } : subject;
    const locator = `${key}#signed_message[${block.index}]`;
    rb.observe(capture, owner, 'post.signed_message.address', block.address, locator);
    rb.observe(capture, owner, 'post.signed_message.text', block.text, locator);
    rb.observe(capture, owner, 'post.signed_message.signature', block.signature, locator);
    rb.observe(capture, owner, 'post.signed_message.armor', block.armor, locator);
    if (block.inQuote) {
      rb.observe(capture, owner, 'post.signed_message.in_quote', 'true', locator);
      if (block.quoteAuthor) rb.observe(capture, owner, 'post.signed_message.quote_author', block.quoteAuthor, locator);
    }
  }
}

export function createBitcointalkCollector(): CollectorFactory {
  return {
    sourceId: 'bitcointalk',
    platform: 'bitcointalk',
    probeHandle: (nick) => (validNick(nick) ? nick.trim() : undefined),
    create(descriptor, deps): SourceCollector {
      const options = deps.config.bitcointalk;
      return {
        descriptor,
        supports: (input) => targetOf(input, options.resolveByName) !== undefined,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const target = targetOf(input, options.resolveByName);
          if (!target) {
            rb.note('unsupported_input', 'no bitcointalk uid, profile URL or (offline) member name');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const profileUrl = target.uid
            ? bitcointalkUrl('profile', { uid: target.uid })
            : bitcointalkUrl('profile_by_name', { nick: target.nick ?? '' });
          const page = await fetchPage(http, {
            url: profileUrl,
            purpose: 'bitcointalk profile',
            containsIdentifier: true,
            software: SOFTWARE,
            classify: smfClassify,
          });
          rb.addPage(page);
          if (page.status === 'not_found') rb.affirmNotFound(`bitcointalk member ${target.uid ?? target.nick}`);
          if (page.status !== 'ok' || !page.capture || page.body === undefined) return rb.build();

          const profile = parseBitcointalkProfile(page.body);
          const uid = target.uid ?? profile.uid;
          if (!uid) {
            rb.addStatus('error');
            rb.note('unrecognised_markup', `no member id on ${page.logicalUrl} (${BITCOINTALK_PARSER_VERSION})`);
            return rb.build();
          }
          const capture = page.capture;
          const accountKey = `bitcointalk:${uid}`;
          const handle = profile.name ?? target.nick ?? uid;
          rb.account({
            platform: 'bitcointalk',
            handle,
            platformUserId: uid,
            profileUrl: bitcointalkUrl('profile', { uid }),
            profileCaptureId: capture.id,
            ...(profile.name ? { displayName: profile.name } : {}),
            discoveredVia: { sourceId: descriptor.id, method: target.method, captureId: target.foundIn ?? capture.id },
          });
          const subject = { type: 'account' as const, key: accountKey };
          for (const [field, raw] of Object.entries(profile.fields)) {
            const value =
              field === 'date_registered'
                ? (parseSmfDate(raw, capture.collectedAt, options.guestTimezoneOffsetMinutes) ?? raw)
                : raw;
            rb.observe(capture, subject, `profile.${field}`, value, `bitcointalk:u=${uid}#profile.${field}`);
          }
          if (profile.signatureText) {
            rb.observe(
              capture,
              subject,
              'profile.signature_text',
              profile.signatureText,
              `bitcointalk:u=${uid}#profile.signature_text`,
            );
          }
          const website = profile.fields['website'];
          const linked = website ? recogniseAccountUrl(website) : undefined;
          if (linked)
            rb.observe(capture, subject, 'account.link', linked.logicalUrl, `bitcointalk:u=${uid}#account.link[0]`);

          const postsPage = await fetchPage(http, {
            url: bitcointalkUrl('show_posts', { uid }),
            purpose: 'bitcointalk posts',
            containsIdentifier: true,
            software: SOFTWARE,
            classify: smfClassify,
          });
          rb.addPage(postsPage);
          if (postsPage.status !== 'ok' || !postsPage.capture || postsPage.body === undefined) return rb.build();
          const owner = { uid, ...(profile.name ? { name: profile.name } : {}) };
          const posts = parseBitcointalkPosts(postsPage.body, 'show_posts', owner);
          for (const post of posts) emitPost(rb, postsPage.capture, post, options.guestTimezoneOffsetMinutes);

          for (const topic of selectTopics(posts, options.maxTopicPages)) {
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source (the forum allows ≤ 1 request/s).
            // oxlint-disable-next-line no-await-in-loop
            const topicPage = await fetchPage(http, {
              url: bitcointalkUrl('topic_msg', topic),
              purpose: 'bitcointalk topic',
              containsIdentifier: false,
              software: SOFTWARE,
              classify: smfClassify,
            });
            rb.addPage(topicPage);
            if (topicPage.status !== 'ok' || !topicPage.capture || topicPage.body === undefined) continue;
            for (const post of parseBitcointalkPosts(topicPage.body, 'topic')) {
              emitPost(rb, topicPage.capture, post, options.guestTimezoneOffsetMinutes);
            }
          }
          return rb.build();
        },
      };
    },
  };
}
