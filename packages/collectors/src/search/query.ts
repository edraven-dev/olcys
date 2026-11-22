/**
 * Search queries: one query per task, built from the task's single subject (an input identifier, an address or a nick
 * to look up), and the exact-phrase form sent to the providers.
 */
import type { CollectorInput, IdentifierKind, SearchQuery } from '@olcys/core';

/** Identifier kinds the search collectors look up (rule I5). */
export const SEARCH_IDENTIFIER_KINDS = [
  'full_name',
  'nickname',
  'email',
  'crypto_address',
] as const satisfies readonly IdentifierKind[];
export const SEARCH_SUBJECTS = [...SEARCH_IDENTIFIER_KINDS, 'username'] as const;
export type SearchSubject = (typeof SEARCH_SUBJECTS)[number];

/** A query with the kind of value it searches for (providers pick locale parameters by it). */
export interface SubjectSearchQuery extends SearchQuery {
  subject?: SearchSubject;
}

export const DEFAULT_MAX_RESULTS = 20;
/** Limits of an exact phrase (the providers' documented query limits). */
export const MAX_PHRASE_CHARS = 600;
export const MAX_PHRASE_WORDS = 75;

/** NFKC, whitespace runs collapsed to one space, trimmed. */
export function normaliseQueryText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** `"…"` around the normalised text; throws on an empty phrase, a `"` inside, > 600 characters or > 75 words. */
export function exactPhrase(text: string): string {
  const phrase = normaliseQueryText(text);
  if (!phrase) throw new Error('exact phrase is empty');
  if (phrase.includes('"')) throw new Error('exact phrase must not contain a double quote');
  if (phrase.length > MAX_PHRASE_CHARS) throw new Error(`exact phrase longer than ${MAX_PHRASE_CHARS} characters`);
  if (phrase.split(' ').length > MAX_PHRASE_WORDS)
    throw new Error(`exact phrase longer than ${MAX_PHRASE_WORDS} words`);
  return `"${phrase}"`;
}

function isSearchKind(kind: IdentifierKind): kind is (typeof SEARCH_IDENTIFIER_KINDS)[number] {
  return (SEARCH_IDENTIFIER_KINDS as readonly string[]).includes(kind);
}

function query(text: string, subject: SearchSubject, maxResults: number): SubjectSearchQuery | undefined {
  const normalised = normaliseQueryText(text);
  try {
    exactPhrase(normalised);
  } catch {
    return undefined;
  }
  return { text: normalised, exact: true, maxResults, subject };
}

/**
 * The task's query (one subject per task): `identifiers[0]` when it is a name, nick, e-mail or crypto address, else
 * `addresses[0]` (canonical address), else a `username` value. Undefined when there is nothing searchable or the
 * value cannot be an exact phrase.
 */
export function buildSearchQuery(
  input: CollectorInput,
  maxResults: number = DEFAULT_MAX_RESULTS,
): SubjectSearchQuery | undefined {
  const identifier = input.identifiers[0];
  if (identifier && isSearchKind(identifier.kind)) return query(identifier.value, identifier.kind, maxResults);
  const address = input.addresses[0];
  if (address) return query(address.address, 'crypto_address', maxResults);
  const value = input.values?.[0];
  if (value?.kind === 'username') return query(value.value, 'username', maxResults);
  return undefined;
}
