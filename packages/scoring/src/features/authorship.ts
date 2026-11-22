import type { AddressCandidate, Capture, Id, Observation } from '@olcys/core';
import type { AccountIndex, AccountInfo } from './accounts.ts';
import { baseProperty, normaliseUrl, postToken } from './normalise.ts';

/** `context.anchor` (DOM anchor of the enclosing post, e.g. `msg65000101`) is set by newer extractor versions. */
type CandidateContext = AddressCandidate['context'] & { anchor?: string };

export interface Authorship {
  /** The account that authored the content the candidate was found in; `undefined` when not evidenced. */
  authorOf(candidate: AddressCandidate): AccountInfo | undefined;
  /** The author of the page (post) an observation is about, via its `post.author` fact. */
  pageAuthor(captureId: Id, pageKey: string): AccountInfo | undefined;
}

interface CaptureFacts {
  /** Post token (`msg65000101`) → author. */
  posts: Map<string, AccountInfo>;
  /** Accounts evidenced as authors of the capture: account subjects and `post.author` values. */
  authors: Set<AccountInfo>;
}

/** Tokens of locators that point into one post (`bitcointalk:msg=65000001#…` → `msg65000001`). */
const POST_TOKEN = /^(?:msg|post|wpis|entry|comment|item)\d+$/;

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

const only = <T>(set: ReadonlySet<T> | undefined): T | undefined => (set?.size === 1 ? [...set][0] : undefined);

/** Platform prefix of a subject key or locator (`bitcointalk:msg=65000101#…` → `bitcointalk`). */
function platformOf(key: string): string | undefined {
  const colon = key.indexOf(':');
  return colon > 0 ? key.slice(0, colon).toLowerCase() : undefined;
}

/**
 * Authorship rules, in order: (1) the candidate's post anchor matches a post of this capture whose author is known (a
 * page subject with `post.author`, or an account fact located in that post); (2) the capture evidences exactly one
 * author, or none and exactly one account was discovered on it; (3) the same post on the same platform in another
 * capture; (4) otherwise unattributed. Archived copies (`Capture.archive`) inherit the authorship of the original
 * URL's capture.
 */
export function buildAuthorship(
  captures: readonly Capture[],
  observations: readonly Observation[],
  index: AccountIndex,
): Authorship {
  const facts = new Map<Id, CaptureFacts>();
  const factsOf = (captureId: Id): CaptureFacts => {
    let f = facts.get(captureId);
    if (!f) {
      f = { posts: new Map(), authors: new Set() };
      facts.set(captureId, f);
    }
    return f;
  };
  /** `<platform> <post token>` → authors: posts are only matched across captures of the same platform. */
  const platformPosts = new Map<string, Set<AccountInfo>>();
  const capturePlatforms = new Map<Id, Set<string>>();
  const pageAuthors = new Map<string, AccountInfo>();
  const notePost = (captureId: Id, key: string, token: string, author: AccountInfo): void => {
    const platform = platformOf(key);
    if (!platform) return;
    addTo(capturePlatforms, captureId, platform);
    addTo(platformPosts, `${platform}\u0000${token}`, author);
  };

  for (const o of observations) {
    if (o.subject.type === 'page' && baseProperty(o.property) === 'post.author') {
      const author = index.resolve(o.value);
      if (!author) continue;
      const f = factsOf(o.captureId);
      const token = postToken(o.subject.key);
      f.authors.add(author);
      f.posts.set(token, author);
      notePost(o.captureId, o.subject.key, token, author);
      pageAuthors.set(`${o.captureId}\u0000${o.subject.key}`, author);
    } else if (o.subject.type === 'account') {
      const owner = index.resolve(o.subject.key);
      if (!owner) continue;
      const f = factsOf(o.captureId);
      f.authors.add(owner);
      const platform = platformOf(o.subject.key);
      if (platform) addTo(capturePlatforms, o.captureId, platform);
      const located = postToken(o.locator);
      if (POST_TOKEN.test(located)) {
        if (!f.posts.has(located)) f.posts.set(located, owner);
        notePost(o.captureId, o.locator, located, owner);
      }
    }
  }

  const discovered = new Map<Id, Set<AccountInfo>>();
  for (const info of index.list) {
    for (const record of info.records) {
      const captureId = record.discoveredVia.captureId;
      if (captureId) addTo(discovered, captureId, info);
    }
  }

  const byUrl = new Map<string, Id>();
  for (const c of captures) {
    if (c.archive) continue;
    // Offline and in replay a capture's URL is the fixture URL; the live URL it stands for is the logical one.
    for (const url of [c.url, c.finalUrl, c.technical?.logicalUrl]) {
      if (url === undefined) continue;
      const key = normaliseUrl(url);
      if (key && !byUrl.has(key)) byUrl.set(key, c.id);
    }
  }
  const archives = new Map(captures.flatMap((c) => (c.archive ? [[c.id, c.archive.originalUrl] as const] : [])));
  const originalOf = (captureId: Id): Id | undefined => {
    const originalUrl = archives.get(captureId);
    const key = originalUrl === undefined ? undefined : normaliseUrl(originalUrl);
    return key ? byUrl.get(key) : undefined;
  };

  const soleAuthor = (captureId: Id): AccountInfo | undefined => {
    const authors = facts.get(captureId)?.authors;
    if (authors && authors.size > 0) return only(authors);
    return only(discovered.get(captureId));
  };

  /**
   * Local evidence first (the post in this capture, then the capture's sole author); only then the same post token
   * on the same platform in another capture of the run.
   */
  const resolveIn = (captureId: Id, anchor: string | undefined): AccountInfo | undefined => {
    const token = anchor ? postToken(anchor) : undefined;
    const local = (token ? facts.get(captureId)?.posts.get(token) : undefined) ?? soleAuthor(captureId);
    if (local || !token) return local;
    const authors = new Set<AccountInfo>();
    for (const platform of capturePlatforms.get(captureId) ?? []) {
      for (const author of platformPosts.get(`${platform}\u0000${token}`) ?? []) authors.add(author);
    }
    return only(authors);
  };

  return {
    authorOf(candidate) {
      const anchor = (candidate.context as CandidateContext).anchor;
      const own = resolveIn(candidate.captureId, anchor);
      if (own) return own;
      const original = originalOf(candidate.captureId);
      return original ? resolveIn(original, anchor) : undefined;
    },
    pageAuthor: (captureId, pageKey) => pageAuthors.get(`${captureId}\u0000${pageKey}`),
  };
}
