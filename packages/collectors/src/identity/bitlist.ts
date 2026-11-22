/**
 * BitList (formerly ninjastic.space): a third-party archive of Bitcointalk with a keyless JSON API that links
 * addresses, authors (with the numeric member id) and posts in both directions. AMBER: no published terms or rate
 * limits, and every query discloses the identifier to a private operator. The archive yields contextual mentions
 * (a copy of authored content), never a proof; the numeric uid leads to the primary forum profile.
 * Never queried by board or by free text; one request per identifier and direction; the API is undocumented, so
 * only the observed parameters (`author`, `address`, `limit`) are used.
 */
import type { AddressRef, Capture, CollectorInput, OnlineAccount, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { bitcointalkProfileUrl } from '../framework/urls.ts';
import { blockText, parseHtml } from '../html/dom.ts';
import { findSignedMessages } from '../platforms/bitcointalk.ts';
import { HANDLE_KINDS, namesPages } from '../platforms/common.ts';
import { asArray, asObject, asText, registryFetch, type Json } from '../registries/common.ts';

export const BITLIST_PARSER_VERSION = 'bitlist.v1';
export const BITLIST_BASE_URL = 'https://api.ninjastic.space';
export const BITLIST_DEFAULT_LIMIT = 50;
const SOFTWARE = [{ name: 'parser:bitlist', version: BITLIST_PARSER_VERSION }];
const MAX_TEXT = 4000;

export interface BitlistAddressHit {
  address: string;
  coin: string;
  post_id: number;
  topic_id: number;
  author: string;
  author_uid: number;
  title: string;
  date: string;
  board_id: number;
  board_name: string;
}
export interface BitlistPost {
  post_id: number;
  topic_id: number;
  author: string;
  author_uid: number;
  title: string;
  content: string;
  date: string;
  board_id: number;
  board_name: string;
  updated_at: string | null;
}

function envelope(json: unknown): Json {
  const root = asObject(json);
  if (!root || root['result'] !== 'success') {
    throw new Error(`BitList answered ${asText(root?.['result']) ?? 'no result'}: ${asText(root?.['message']) ?? '?'}`);
  }
  return root;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Throws when `result` is not `success`. */
export function parseBitlistAddresses(json: unknown): { total: number; hits: BitlistAddressHit[] } {
  const data = envelope(json)['data'];
  const object = asObject(data);
  // A missing or renamed list is an unreadable answer, never an empty result.
  if (!Array.isArray(object?.['addresses'])) throw new Error('BitList answer has no addresses list');
  const hits = asArray(object['addresses']).flatMap((item): BitlistAddressHit[] => {
    const hit = asObject(item);
    const address = asText(hit?.['address']);
    if (!hit || !address) return [];
    return [
      {
        address,
        coin: str(hit['coin']),
        post_id: num(hit['post_id']),
        topic_id: num(hit['topic_id']),
        author: str(hit['author']),
        author_uid: num(hit['author_uid']),
        title: str(hit['title']),
        date: str(hit['date']),
        board_id: num(hit['board_id']),
        board_name: str(hit['board_name']),
      },
    ];
  });
  return { total: num(object?.['total_results']) || hits.length, hits };
}

/** Accepts `data.posts` or `data` as the array. Throws when `result` is not `success`. */
export function parseBitlistPosts(json: unknown): { total: number; posts: BitlistPost[] } {
  const data = envelope(json)['data'];
  const object = asObject(data);
  if (!Array.isArray(data) && !Array.isArray(object?.['posts'])) throw new Error('BitList answer has no posts list');
  const list = Array.isArray(data) ? data : asArray(object?.['posts']);
  const posts = list.flatMap((item): BitlistPost[] => {
    const post = asObject(item);
    if (!post || !num(post['post_id'])) return [];
    return [
      {
        post_id: num(post['post_id']),
        topic_id: num(post['topic_id']),
        author: str(post['author']),
        author_uid: num(post['author_uid']),
        title: str(post['title']),
        content: str(post['content']),
        date: str(post['date']),
        board_id: num(post['board_id']),
        board_name: str(post['board_name']),
        updated_at: typeof post['updated_at'] === 'string' ? post['updated_at'] : null,
      },
    ];
  });
  return { total: object ? num(object['total_results']) || posts.length : posts.length, posts };
}

export function bitlistUrl(
  baseUrl: string,
  kind: 'addresses' | 'posts',
  query: { author: string } | { address: string },
  limit: number,
): string {
  const [key, value] = 'author' in query ? (['author', query.author] as const) : (['address', query.address] as const);
  return `${baseUrl.replace(/\/+$/, '')}/${kind}?${key}=${encodeURIComponent(value)}&limit=${limit}`;
}

/** The nick to look up for a nick on another platform, or undefined when it is not a plausible forum name. */
export function bitlistProbeHandle(nick: string): string | undefined {
  const name = nick.trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_.-]{2,40}$/.test(name) ? name : undefined;
}

const sameAuthor = (a: string, b: string): boolean =>
  a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
const sameAddress = (a: string, b: string): boolean =>
  a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;

function addressOf(ref: AddressRef): string | undefined {
  return ref.chain === 'bitcoin' || ref.chain.startsWith('evm') ? ref.address : undefined;
}

interface Targets {
  authors: string[];
  addresses: string[];
}

function targetsOf(input: CollectorInput): Targets {
  const authors = new Set<string>();
  const addresses = new Set<string>();
  const nick = (raw: string): void => {
    const name = bitlistProbeHandle(raw);
    if (name) authors.add(name);
  };
  for (const value of input.values ?? []) if (value.kind === 'username') nick(value.value);
  if (!namesPages(input)) {
    for (const account of input.accounts) if (account.platform === 'bitcointalk') nick(account.handle);
    for (const identifier of input.identifiers) {
      if (identifier.kind === 'crypto_address') {
        if (identifier.chain === 'bitcoin' || identifier.chain?.startsWith('evm'))
          addresses.add(identifier.value.trim());
      } else if (identifier.platform === 'bitcointalk' && HANDLE_KINDS.includes(identifier.kind))
        nick(identifier.value);
    }
    for (const ref of input.addresses) {
      const address = addressOf(ref);
      if (address) addresses.add(address);
    }
  }
  return { authors: [...authors], addresses: [...addresses] };
}

export interface BitlistOptions {
  baseUrl?: string;
  /** Items requested per query (default 50). */
  limit?: number;
  /** Also read the author's archived posts (one more request per nick; default true). */
  includePosts?: boolean;
}

export function createBitlistCollector(options: BitlistOptions = {}): CollectorFactory {
  const baseUrl = options.baseUrl ?? BITLIST_BASE_URL;
  const limit = options.limit ?? BITLIST_DEFAULT_LIMIT;
  const includePosts = options.includePosts ?? true;
  return {
    sourceId: 'bitlist',
    platform: 'bitlist',
    probeHandle: bitlistProbeHandle,
    addressFamilies: ['bitcoin', 'evm'],
    accountsAreReferences: true,
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => {
          const targets = targetsOf(input);
          return targets.authors.length + targets.addresses.length > 0;
        },
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const targets = targetsOf(input);
          if (!targets.authors.length && !targets.addresses.length) {
            rb.note('unsupported_input', 'no nickname or BTC/EVM address for BitList');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const accounts = new Map<number, OnlineAccount>();
          const queries: { kind: 'addresses' | 'posts'; key: 'author' | 'address'; value: string }[] = [
            ...targets.authors.flatMap((value) => [
              { kind: 'addresses' as const, key: 'author' as const, value },
              ...(includePosts ? [{ kind: 'posts' as const, key: 'author' as const, value }] : []),
            ]),
            ...targets.addresses.map((value) => ({ kind: 'addresses' as const, key: 'address' as const, value })),
          ];
          for (const query of queries) {
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source, 1 per 2 s from the register.
            // oxlint-disable-next-line no-await-in-loop
            await runQuery(http, rb, query, baseUrl, limit, accounts);
          }
          return rb.build();
        },
      };
    },
  };
}

async function runQuery(
  http: SourceHttp,
  rb: ResultBuilder,
  query: { kind: 'addresses' | 'posts'; key: 'author' | 'address'; value: string },
  baseUrl: string,
  limit: number,
  accounts: Map<number, OnlineAccount>,
): Promise<void> {
  const url = bitlistUrl(
    baseUrl,
    query.kind,
    query.key === 'author' ? { author: query.value } : { address: query.value },
    limit,
  );
  const total = (json: unknown): number | undefined => {
    try {
      return query.kind === 'addresses' ? parseBitlistAddresses(json).total : parseBitlistPosts(json).total;
    } catch {
      return undefined;
    }
  };
  const answer = await registryFetch(http, {
    url,
    purpose: `bitlist ${query.key === 'author' ? 'author' : 'address'} lookup`,
    software: SOFTWARE,
    notJsonNote: { code: 'fetch_error', detail: 'the BitList answer is not JSON' },
    classify: (json, httpStatus) => {
      if (httpStatus >= 300) return undefined;
      try {
        if (query.kind === 'addresses') parseBitlistAddresses(json);
        else parseBitlistPosts(json);
      } catch (error) {
        return { status: 'error', reason: (error as Error).message, code: 'fetch_error' };
      }
      return total(json) === 0
        ? { status: 'not_found', reason: `no BitList ${query.kind} for ${query.key} ${query.value}` }
        : undefined;
    },
  });
  rb.addPage({ status: answer.status, ...(answer.capture ? { capture: answer.capture } : {}), notes: answer.notes });
  if (answer.status === 'not_found') {
    rb.affirmNotFound(`bitlist ${query.kind} ${query.key} ${query.value}`);
    return;
  }
  if (answer.status !== 'ok' || !answer.capture) return;
  const capture = answer.capture;
  if (query.kind === 'addresses') {
    const parsed = parseBitlistAddresses(answer.json);
    // Data minimisation: only hits about the queried author or address; the raw body stays in the capture.
    const shown = parsed.hits.slice(0, limit);
    const kept = shown.filter((hit) =>
      query.key === 'author' ? sameAuthor(hit.author, query.value) : sameAddress(hit.address, query.value),
    );
    if (parsed.total > shown.length) rb.note('truncated', `${shown.length} of ${parsed.total}`);
    kept.forEach((hit, index) => {
      const subject = accountFor(rb, capture, accounts, hit.author_uid, hit.author);
      const locator = `bitlist:post=${hit.post_id}#address[${index}]`;
      rb.observe(capture, subject, 'archive.post.address', hit.address, locator);
      postFacts(rb, capture, subject, locator, hit);
      if (hit.coin) rb.observe(capture, subject, 'archive.post.coin', hit.coin, locator);
    });
    return;
  }
  const parsed = parseBitlistPosts(answer.json);
  const shownPosts = parsed.posts.slice(0, limit);
  if (parsed.total > shownPosts.length) rb.note('truncated', `${shownPosts.length} of ${parsed.total}`);
  for (const post of shownPosts.filter((p) => sameAuthor(p.author, query.value))) {
    const subject = accountFor(rb, capture, accounts, post.author_uid, post.author);
    const locator = `bitlist:post=${post.post_id}`;
    postFacts(rb, capture, subject, `${locator}#post`, post);
    const body = parseHtml(`<div>${post.content}</div>`).querySelector('div');
    if (!body) continue;
    rb.observe(capture, subject, 'archive.post.text', blockText(body).slice(0, MAX_TEXT), `${locator}#text`);
    // Facts only: the signature is checked where the evidence is weighed, not here.
    for (const block of findSignedMessages(body)) {
      const at = `${locator}#signed_message[${block.index}]`;
      rb.observe(capture, subject, 'post.signed_message.address', block.address, at);
      rb.observe(capture, subject, 'post.signed_message.text', block.text, at);
      rb.observe(capture, subject, 'post.signed_message.signature', block.signature, at);
      rb.observe(capture, subject, 'post.signed_message.armor', block.armor, at);
      if (block.inQuote) rb.observe(capture, subject, 'post.signed_message.in_quote', 'true', at);
      if (block.quoteAuthor) rb.observe(capture, subject, 'post.signed_message.quote_author', block.quoteAuthor, at);
    }
  }
}

function postFacts(
  rb: ResultBuilder,
  capture: Capture,
  subject: { type: 'account'; key: string },
  locator: string,
  post: Pick<BitlistAddressHit, 'post_id' | 'topic_id' | 'title' | 'date' | 'board_id' | 'board_name'>,
): void {
  rb.observe(capture, subject, 'archive.post.board', `${post.board_id}:${post.board_name}`, locator);
  rb.observe(capture, subject, 'archive.post.published_at', post.date, locator);
  rb.observe(capture, subject, 'archive.post.title', post.title, locator);
  rb.observe(
    capture,
    subject,
    'archive.post.url',
    `https://bitcointalk.org/index.php?topic=${post.topic_id}.msg${post.post_id}#msg${post.post_id}`,
    locator,
  );
}

function accountFor(
  rb: ResultBuilder,
  capture: Capture,
  accounts: Map<number, OnlineAccount>,
  uid: number,
  author: string,
): { type: 'account'; key: string } {
  if (uid > 0 && !accounts.has(uid)) {
    accounts.set(
      uid,
      rb.account({
        platform: 'bitcointalk',
        handle: author,
        platformUserId: String(uid),
        profileUrl: bitcointalkProfileUrl(String(uid)),
        discoveredVia: { sourceId: 'bitlist', method: 'search', captureId: capture.id },
      }),
    );
  }
  return { type: 'account', key: uid > 0 ? `bitcointalk:${uid}` : `bitcointalk:${author.toLowerCase()}` };
}
