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

/**
 * Authorship rules, in order: (1) the candidate's post anchor matches a post whose author is known (a page subject
 * with `post.author`, or an account fact located in that post); (2) the capture evidences exactly one author, or it
 * evidences none and exactly one account was discovered on it; (3) otherwise unattributed. Archived copies
 * (`Capture.archive`) inherit the authorship of the original URL's capture.
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
  const globalPosts = new Map<string, Set<AccountInfo>>();
  const pageAuthors = new Map<string, AccountInfo>();

  for (const o of observations) {
    if (o.subject.type === 'page' && baseProperty(o.property) === 'post.author') {
      const author = index.resolve(o.value);
      if (!author) continue;
      const f = factsOf(o.captureId);
      f.authors.add(author);
      f.posts.set(postToken(o.subject.key), author);
      addTo(globalPosts, postToken(o.subject.key), author);
      pageAuthors.set(`${o.captureId}\u0000${o.subject.key}`, author);
    } else if (o.subject.type === 'account') {
      const owner = index.resolve(o.subject.key);
      if (!owner) continue;
      const f = factsOf(o.captureId);
      f.authors.add(owner);
      const located = postToken(o.locator);
      if (POST_TOKEN.test(located)) {
        if (!f.posts.has(located)) f.posts.set(located, owner);
        addTo(globalPosts, located, owner);
      }
    }
  }

  const discovered = new Map<Id, Set<AccountInfo>>();
  for (const info of index.list) {
    const captureId = info.account.discoveredVia.captureId;
    if (captureId) addTo(discovered, captureId, info);
  }

  const byUrl = new Map<string, Id>();
  for (const c of captures) {
    if (c.archive) continue;
    for (const url of [c.url, c.finalUrl]) {
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

  const resolveIn = (captureId: Id, anchor: string | undefined): AccountInfo | undefined => {
    if (anchor) {
      const token = postToken(anchor);
      const byPost = facts.get(captureId)?.posts.get(token) ?? only(globalPosts.get(token));
      if (byPost) return byPost;
    }
    return soleAuthor(captureId);
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
