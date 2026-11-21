import type { Identifier, Observation, OnlineAccount } from '@olcys/core';
import { compareText } from '../compare.ts';
import { accountHandleKey, baseProperty } from './normalise.ts';

/** One platform account, merged over duplicate discoveries. */
export interface AccountInfo {
  /** The canonical record, with `platformUserId` and `displayName` filled in from duplicate discoveries. */
  account: OnlineAccount;
  /** Every discovery of this account (sorted by id): handles, names, profile URLs and capture ids all count. */
  records: OnlineAccount[];
  /** `<platform>:<platformUserId ?? handle in lower case>`, e.g. `bitcointalk:900001`. */
  key: string;
  /** `acct:<key>`: everything the account authored is one origin group. */
  originGroup: string;
  anchor: boolean;
}

export interface AccountIndex {
  /** Sorted by key. */
  list: AccountInfo[];
  /** Resolves `<platform>:<id or handle>` (observation subjects, `post.author` values) to an account. */
  resolve(key: string): AccountInfo | undefined;
  byId(id: string): AccountInfo | undefined;
}

export function accountKey(account: OnlineAccount): string {
  return `${account.platform.toLowerCase()}:${(account.platformUserId ?? account.handle).toLowerCase()}`;
}

function aliasesOf(account: OnlineAccount): string[] {
  const platform = account.platform.toLowerCase();
  const values = [accountHandleKey(account.handle)];
  if (account.platformUserId) values.push(account.platformUserId.toLowerCase());
  return values.map((value) => `${platform}:${value}`);
}

/** An identifier the investigator states belongs to the subject on this account's platform. */
function isAnchorAccount(account: OnlineAccount, anchors: readonly Identifier[]): boolean {
  const platform = account.platform.toLowerCase();
  return anchors.some(
    (id) =>
      id.platform?.toLowerCase() === platform &&
      (accountHandleKey(id.value) === accountHandleKey(account.handle) ||
        (account.platformUserId !== undefined && id.value.trim() === account.platformUserId)),
  );
}

/**
 * Groups discoveries of one account: same platform and platform id; a record without a platform id joins the group
 * with the same platform and exactly the same handle (`accountHandleKey`). Similar handles are never merged — they are
 * only same-nick evidence for the identity hop.
 */
function groupDiscoveries(accounts: readonly OnlineAccount[]): OnlineAccount[][] {
  const sorted = accounts.toSorted((a, b) => compareText(a.id, b.id));
  const groups = new Map<string, OnlineAccount[]>();
  const byHandle = new Map<string, string>();
  const push = (key: string, account: OnlineAccount): void => {
    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  };
  for (const a of sorted) {
    if (a.platformUserId === undefined) continue;
    const platform = a.platform.toLowerCase();
    const key = `${platform}:#${a.platformUserId.toLowerCase()}`;
    push(key, a);
    const handleKey = `${platform}:${accountHandleKey(a.handle)}`;
    if (!byHandle.has(handleKey)) byHandle.set(handleKey, key);
  }
  for (const a of sorted) {
    if (a.platformUserId !== undefined) continue;
    const handleKey = `${a.platform.toLowerCase()}:${accountHandleKey(a.handle)}`;
    push(byHandle.get(handleKey) ?? `${handleKey}@`, a);
  }
  return [...groups.values()];
}

/** The first record with a platform id (else the first record), completed with fields only other discoveries carry. */
function mergeRecords(records: readonly OnlineAccount[]): OnlineAccount {
  const first = records.find((r) => r.platformUserId !== undefined) ?? records[0];
  if (!first) throw new Error('empty account group');
  const platformUserId = first.platformUserId ?? records.find((r) => r.platformUserId)?.platformUserId;
  const displayName = first.displayName ?? records.find((r) => r.displayName)?.displayName;
  return {
    ...first,
    ...(platformUserId === undefined ? {} : { platformUserId }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

export function buildAccountIndex(
  accounts: readonly OnlineAccount[],
  identifiers: readonly Identifier[],
): AccountIndex {
  const anchors = identifiers.filter((id) => id.isAnchor);
  const list = groupDiscoveries(accounts)
    .map((records): AccountInfo => {
      const account = mergeRecords(records);
      const key = accountKey(account);
      return {
        account,
        records,
        key,
        originGroup: `acct:${key}`,
        anchor: records.some((r) => isAnchorAccount(r, anchors)),
      };
    })
    .toSorted((a, b) => compareText(a.key, b.key));
  const aliases = new Map<string, AccountInfo>();
  const ids = new Map<string, AccountInfo>();
  for (const info of list) {
    for (const record of info.records) {
      ids.set(record.id, info);
      for (const alias of aliasesOf(record)) if (!aliases.has(alias)) aliases.set(alias, info);
    }
  }
  return {
    list,
    resolve(raw: string) {
      const colon = raw.indexOf(':');
      if (colon <= 0) return undefined;
      return aliases.get(`${raw.slice(0, colon).trim().toLowerCase()}:${accountHandleKey(raw.slice(colon + 1))}`);
    },
    byId: (id: string) => ids.get(id),
  };
}

const pageKey = (o: Observation): string => `${o.captureId}\u0000${o.subject.key}`;

/**
 * Observations about each account (by account key): facts with the account as subject, plus facts about pages
 * (posts) whose `post.author` is the account.
 */
export function observationsByAccount(
  index: AccountIndex,
  observations: readonly Observation[],
): Map<string, Observation[]> {
  const pageAuthor = new Map<string, AccountInfo>();
  for (const o of observations) {
    if (o.subject.type !== 'page' || baseProperty(o.property) !== 'post.author') continue;
    const author = index.resolve(o.value);
    if (author) pageAuthor.set(pageKey(o), author);
  }
  const grouped = new Map<string, Observation[]>();
  for (const o of observations) {
    const owner =
      o.subject.type === 'account'
        ? index.resolve(o.subject.key)
        : o.subject.type === 'page'
          ? pageAuthor.get(pageKey(o))
          : undefined;
    if (!owner) continue;
    const list = grouped.get(owner.key);
    if (list) list.push(o);
    else grouped.set(owner.key, [o]);
  }
  return grouped;
}
