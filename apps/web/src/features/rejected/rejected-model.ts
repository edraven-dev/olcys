/** Pure helpers for the rejected-addresses panel. */
import type {
  AddressCandidate,
  AddressRef,
  AddressTypeClassification,
  Capture,
  ExclusionDecision,
  ExtractionResult,
  Observation,
  OnlineAccount,
  RoleCue,
  TextSpan,
  TextView,
} from '@olcys/core';

/**
 * The address type behind a decision: the classification of the address its chain data was fetched on (`resolved` for
 * a candidate without an attributed EVM network), else the one whose requests the decision cites (A2/A3 record the
 * classification's fetch ids). Never chosen by list order: without either, no type is shown.
 */
export function addressTypeFor(
  decision: Pick<ExclusionDecision, 'address' | 'resolved'> & { evidence: { fetchIds?: string[] } },
  types: readonly AddressTypeClassification[],
): AddressTypeClassification | undefined {
  const ref: AddressRef = decision.resolved ?? decision.address;
  const evm = ref.chain.startsWith('evm:');
  const same = (a: string) => (evm ? a.toLowerCase() === ref.address.toLowerCase() : a === ref.address);
  const exact = types.find((c) => c.address.chain === ref.chain && same(c.address.address));
  if (exact) return exact;
  const cited = new Set(decision.evidence.fetchIds ?? []);
  return cited.size ? types.find((c) => c.fetchIds.some((id) => cited.has(id))) : undefined;
}

/** Context cues that mark a mention as someone else's statement (warnings, scam reports, quotes). */
const THIRD_PARTY_CUES: ReadonlySet<RoleCue> = new Set(['scam_report', 'warning', 'quote']);

export interface MentionView {
  candidate: AddressCandidate;
  /** Author of the post or owner of the profile page that contains the mention, when the sources show it. */
  author?: string;
  /** True when the mention is a third party's statement, not the subject's own declaration. */
  thirdParty: boolean;
}

/**
 * Author of a mention, from facts only: a `*.author` observation of the same capture (matched by the DOM anchor of
 * the authored item when the page has several authors), otherwise the account whose profile page is the capture.
 */
export function mentionAuthor(
  candidate: AddressCandidate,
  observations: readonly Observation[],
  accounts: readonly OnlineAccount[],
  capture?: Pick<Capture, 'url' | 'finalUrl'>,
): string | undefined {
  const authors = observations.filter((o) => o.captureId === candidate.captureId && /(?:^|\.)author$/.test(o.property));
  const anchor = /\d+/.exec(candidate.context.anchor ?? '')?.[0];
  if (anchor) {
    const match = authors.find((o) => o.locator.match(/\d+/g)?.includes(anchor));
    if (match) return match.value;
  }
  const distinct = [...new Set(authors.map((o) => o.value))];
  if (distinct.length > 0) return distinct.length === 1 ? distinct[0] : undefined;
  if (!capture) return undefined;
  return accounts.find((a) => a.profileUrl === capture.url || a.profileUrl === capture.finalUrl)?.handle;
}

/**
 * Describes where an address was mentioned, neutrally: who wrote it and whether it is a third party's statement.
 * Whether the subject published the address is decided by the analysis engine (`kycLead`), never inferred here.
 */
export function describeMentions(
  candidates: readonly AddressCandidate[],
  observations: readonly Observation[],
  accounts: readonly OnlineAccount[],
  captures: ReadonlyMap<string, Pick<Capture, 'url' | 'finalUrl'>>,
  subjectHandles: ReadonlySet<string>,
): MentionView[] {
  return candidates.map((candidate) => {
    const author = mentionAuthor(candidate, observations, accounts, captures.get(candidate.captureId));
    const cue = candidate.context.roleCues.some((c) => THIRD_PARTY_CUES.has(c));
    const otherAuthor = author !== undefined && !subjectHandles.has(author.toLowerCase());
    return { candidate, ...(author !== undefined ? { author } : {}), thirdParty: cue || otherAuthor };
  });
}

/** Stable reason code: the text before the first `:` (`checksum_invalid: bad bech32` → `checksum_invalid`). */
export function reasonCode(reason: string): string {
  return reason.split(':', 1)[0]?.trim() ?? '';
}

const codepoint = (char: string) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Distinct non-ASCII code points, e.g. `['U+0430']` for a Cyrillic "а" hidden in a bech32 address. */
export function nonAsciiCodepoints(raw: string): string[] {
  return [...new Set([...raw].filter((char) => (char.codePointAt(0) ?? 0) > 0x7e).map(codepoint))];
}

/** Splits a string into ASCII and non-ASCII runs so the latter can be highlighted. */
export function splitNonAscii(raw: string): { text: string; nonAscii: boolean; offset: number }[] {
  const parts: { text: string; nonAscii: boolean; offset: number }[] = [];
  let offset = 0;
  for (const char of raw) {
    const nonAscii = (char.codePointAt(0) ?? 0) > 0x7e;
    const last = parts.at(-1);
    if (last && last.nonAscii === nonAscii) last.text += char;
    else parts.push({ text: char, nonAscii, offset });
    offset += char.length;
  }
  return parts;
}

export interface RejectedCandidate {
  captureId: string;
  raw: string;
  reason: string;
  view: TextView;
  span: TextSpan;
}

/** Matches that failed address validation, deduplicated per capture and string. */
export function rejectedCandidates(results: readonly ExtractionResult[]): RejectedCandidate[] {
  const seen = new Set<string>();
  const out: RejectedCandidate[] = [];
  for (const result of results) {
    for (const rejected of result.rejected ?? []) {
      const key = `${result.captureId}|${rejected.raw}|${reasonCode(rejected.reason)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ captureId: result.captureId, ...rejected });
    }
  }
  return out;
}
