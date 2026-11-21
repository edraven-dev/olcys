/**
 * Matching of case identifiers against text read from a page (watch-list pages are kept only when one matches).
 * The result is an OŁCyŚ computation (`computed.identifier_match`), not a source fact.
 */
import type { Id, Identifier, IdentifierKind } from '@olcys/core';

export interface IdentifierMatch {
  kind: IdentifierKind;
  identifierId: Id;
  /** Which field of the page matched (e.g. `seller.email`, `post.text`). */
  field: string;
}

/** Lower case, diacritics removed (ł → l), whitespace collapsed — for name comparison. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nickPattern(nick: string): RegExp {
  const body = nick
    .trim()
    .replace(/^@+/, '')
    .split(/[-_.]+/)
    .map(escapeRegExp)
    .join('[-_.]');
  return new RegExp(`(?<![\\p{L}\\p{N}_.@-])@?${body}(?![\\p{L}\\p{N}_-])`, 'iu');
}

function matches(identifier: Identifier, text: string): boolean {
  const value = identifier.value.trim();
  if (!value) return false;
  switch (identifier.kind) {
    case 'email':
      return new RegExp(`(?<![a-z0-9._%+-])${escapeRegExp(value.toLowerCase())}(?![a-z0-9-])`).test(text.toLowerCase());
    case 'full_name':
      return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(foldText(value))}(?![\\p{L}\\p{N}])`, 'u').test(
        foldText(text),
      );
    case 'crypto_address':
      return /^0x/i.test(value) ? text.toLowerCase().includes(value.toLowerCase()) : text.includes(value);
    default:
      return value.length >= 3 && nickPattern(value).test(text);
  }
}

/** Every identifier that occurs in one of the fields (first matching field wins), in identifier order. */
export function matchIdentifiers(
  identifiers: readonly Identifier[],
  fields: readonly { field: string; text: string | undefined }[],
): IdentifierMatch[] {
  const out: IdentifierMatch[] = [];
  for (const identifier of identifiers) {
    const hit = fields.find((f) => f.text && matches(identifier, f.text));
    if (hit) out.push({ kind: identifier.kind, identifierId: identifier.id, field: hit.field });
  }
  return out;
}

/** Distinct matched kinds, sorted (stable observation values). */
export function matchedKinds(found: readonly IdentifierMatch[]): string[] {
  return [...new Set(found.map((m) => m.kind))].toSorted();
}
