import {
  addressKey,
  isAddressValuedProperty,
  type AddressCandidate,
  type AddressRef,
  type AdmiraltyReliability,
  type Capture,
  type ChainAttributionMethod,
  type EvidenceFeature,
  type EvidenceTier,
  type Id,
  type Observation,
  type Relation,
  type RoleCue,
} from '@olcys/core';
import { verifyBip137, type Bip137Result } from '../bip137.ts';
import { compareText } from '../compare.ts';
import type { AccountIndex, AccountInfo } from './accounts.ts';
import type { Authorship } from './authorship.ts';
import { accountHandleKey, baseProperty, factIndex, sameAddressText, truncate } from './normalise.ts';
import type { FeatureNote } from './types.ts';

/** One address-hop item with the relation and tier it implies (modifiers imply neither). */
export interface AddressItem {
  feature: EvidenceFeature;
  relation?: Relation;
  tier?: EvidenceTier;
  /** The validated candidate that confirms the address (gives `AddressRef` and checksum). */
  candidate: AddressCandidate;
}

/** Evidence that one account (origin group) published one address. */
export interface AccountAddressEvidence {
  account: AccountInfo;
  address: AddressRef;
  items: AddressItem[];
  /**
   * Relations of the account's mentions whose arithmetic a proof or profile field superseded. They still take part in
   * relation precedence: a deposit cue keeps the claim CUSTODIAL_EXCHANGE (never a holding) next to a profile field.
   */
  supersededRelations: Relation[];
}

export interface AddressEvidence {
  /** Keyed `<account key> <address key>`. */
  byAccount: Map<string, AccountAddressEvidence>;
  /** Address key → candidates whose first cue is a warning or scam report (a third party attributes the address). */
  thirdParty: Map<string, AddressCandidate[]>;
}

export interface AddressContext {
  index: AccountIndex;
  authorship: Authorship;
  captures: ReadonlyMap<Id, Capture>;
  /** Valid candidates (checksum passed) by capture id. */
  candidates: ReadonlyMap<Id, AddressCandidate[]>;
  /**
   * Candidates an analyst rejected (rescore runs), by capture id: the observations of that page are never confirmed by
   * another page's candidate, so an explicitly rejected match cannot come back through the cross-page fallback.
   */
  rejected?: ReadonlyMap<Id, AddressCandidate[]>;
  observations: readonly Observation[];
  /** Grade of an item: the given grade, or F when the source's register grade is F. */
  grade(grade: AdmiraltyReliability, sourceId: string | undefined): AdmiraltyReliability;
  note(note: FeatureNote): void;
}

interface Rule {
  feature: string;
  grade: AdmiraltyReliability;
  relation: Relation;
  tier: EvidenceTier;
}

/** Mention rules by the first (closest) role cue; `third_party` = a separate THIRD_PARTY_ATTRIBUTION claim. */
const CUE_RULES: Record<RoleCue, Rule | 'third_party'> = {
  first_person_owner: { feature: 'e3_ownership_cue', grade: 'C', relation: 'SELF_DECLARED', tier: 'E3' },
  payment_request: { feature: 'e3_ownership_cue', grade: 'C', relation: 'PAYMENT_ENDPOINT', tier: 'E3' },
  donation: { feature: 'e3_ownership_cue', grade: 'C', relation: 'PAYMENT_ENDPOINT', tier: 'E3' },
  exchange_deposit: { feature: 'e3_ownership_cue', grade: 'C', relation: 'CUSTODIAL_EXCHANGE', tier: 'E3' },
  listing: { feature: 'e3_bare_mention', grade: 'C', relation: 'MENTION_UNCLEAR', tier: 'E3' },
  unclear: { feature: 'e3_bare_mention', grade: 'C', relation: 'MENTION_UNCLEAR', tier: 'E3' },
  quote: { feature: 'quoted_or_reposted', grade: 'A', relation: 'MENTION_UNCLEAR', tier: 'E3' },
  scam_report: 'third_party',
  warning: 'third_party',
};

const E1: Rule = { feature: 'e1_cryptographic_binding', grade: 'A', relation: 'SELF_DECLARED', tier: 'E1' };
const E1_NODE_ATTESTED: Rule = { ...E1, grade: 'B' };
const E2_PROFILE: Rule = { feature: 'e2_self_assertion', grade: 'B', relation: 'SELF_DECLARED', tier: 'E2' };
const E2_PAYMENT: Rule = { feature: 'e2_self_assertion', grade: 'B', relation: 'PAYMENT_ENDPOINT', tier: 'E2' };

/** Chain attributions that corroborate an address without a checksum. */
const CORROBORATED: ReadonlySet<ChainAttributionMethod> = new Set([
  'uri_chain_id',
  'caip10',
  'eip3770',
  'explorer_domain',
  'keyword',
]);

const DOCS_HOST = /^(?:docs|developer)\.|\.readthedocs\.io$/;

const strength = (a: AddressCandidate, b: AddressCandidate): number =>
  Number(b.checksum.present) - Number(a.checksum.present) ||
  b.checksum.bits - a.checksum.bits ||
  compareText(a.id, b.id);

const textMatch =
  (value: string) =>
  (c: AddressCandidate): boolean =>
    sameAddressText(value, c.address.address) || sameAddressText(value, c.raw);

/**
 * The candidate confirming an observed address value. Only a candidate of the same capture may set the chain; another
 * capture's candidate is accepted only when its chain follows from the address format alone, so an EVM address never
 * borrows another page's network (and never escapes exclusions decided for its real chain).
 */
function confirm(value: string, captureId: Id, ctx: AddressContext): AddressCandidate | undefined {
  const matches = textMatch(value);
  const local = (ctx.candidates.get(captureId) ?? []).filter(matches).toSorted(strength)[0];
  if (local) return local;
  if (rejectedOnPage(value, captureId, ctx)) return undefined;
  return [...ctx.candidates.values()]
    .flat()
    .filter((c) => matches(c) && c.chainAttribution.method === 'format_unique')
    .toSorted(strength)[0];
}

/** The analyst rejected the match of this value on the observation's own page. */
function rejectedOnPage(value: string, captureId: Id, ctx: AddressContext): boolean {
  return (ctx.rejected?.get(captureId) ?? []).some(textMatch(value));
}

/**
 * Why an observed address did not become a feature: the analyst rejected its match on this page, no valid candidate at
 * all, or only context-attributed elsewhere.
 */
function unconfirmed(
  value: string,
  base: string,
  ctx: AddressContext,
  where: { captureId: Id; observationId: Id },
): void {
  if (rejectedOnPage(value, where.captureId, ctx)) {
    ctx.note({
      code: 'analyst_rejected_candidate',
      detail: `${base}: the analyst rejected the address match on this page; not confirmed by another page`,
      ...where,
    });
    return;
  }
  const elsewhere = [...ctx.candidates.values()].flat().some(textMatch(value));
  ctx.note(
    elsewhere
      ? {
          code: 'observation_address_unconfirmed',
          detail: `${base}: no validated candidate in the same capture; the chain is not borrowed from another page`,
          ...where,
        }
      : { code: 'observation_address_invalid', detail: `${base} failed validation`, ...where },
  );
}

function ownerOf(o: Observation, ctx: AddressContext): AccountInfo | undefined {
  if (o.subject.type === 'account') return ctx.index.resolve(o.subject.key);
  if (o.subject.type === 'page') return ctx.authorship.pageAuthor(o.captureId, o.subject.key);
  return undefined;
}

const hostOf = (capture: Capture | undefined): string => {
  try {
    return capture ? new URL(capture.finalUrl || capture.url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
};

class Collector {
  readonly byAccount = new Map<string, AccountAddressEvidence>();
  readonly thirdParty = new Map<string, AddressCandidate[]>();

  add(account: AccountInfo, item: AddressItem): void {
    const key = `${account.key} ${addressKey(item.candidate.address)}`;
    const entry = this.byAccount.get(key);
    if (entry) entry.items.push(item);
    else this.byAccount.set(key, { account, address: item.candidate.address, items: [item], supersededRelations: [] });
  }

  /** Records the relation of a mention whose contribution a proof of the same account supersedes. */
  supersede(account: AccountInfo, item: AddressItem): void {
    const entry = this.byAccount.get(`${account.key} ${addressKey(item.candidate.address)}`);
    if (entry && item.relation && !entry.supersededRelations.includes(item.relation)) {
      entry.supersededRelations.push(item.relation);
    }
  }

  hasProof(account: AccountInfo, address: AddressRef): boolean {
    const entry = this.byAccount.get(`${account.key} ${addressKey(address)}`);
    return entry?.items.some((i) => i.tier === 'E1' || i.tier === 'E2') ?? false;
  }
}

function makeItem(
  rule: Pick<Rule, 'feature' | 'grade'> & Partial<Pick<Rule, 'relation' | 'tier'>>,
  account: AccountInfo,
  candidate: AddressCandidate,
  ctx: AddressContext,
  extra: { observation?: Observation; sourceId?: string; detail: string },
): AddressItem {
  const capture = ctx.captures.get(extra.observation?.captureId ?? candidate.captureId);
  const feature: EvidenceFeature = {
    hop: 'address',
    feature: rule.feature,
    reliability: ctx.grade(rule.grade, extra.sourceId ?? capture?.sourceId),
    originGroup: account.originGroup,
    evidence: {
      captureId: extra.observation?.captureId ?? candidate.captureId,
      ...(extra.observation ? { observationId: extra.observation.id } : {}),
      candidateId: candidate.id,
      ...(capture && capture.fetchIds.length > 0 ? { fetchIds: [...capture.fetchIds] } : {}),
    },
    detail: truncate(extra.detail),
  };
  return {
    feature,
    candidate,
    ...(rule.relation ? { relation: rule.relation } : {}),
    ...(rule.tier ? { tier: rule.tier } : {}),
  };
}

// --- signed messages ------------------------------------------------------------------------------------------

interface SignedGroup {
  first: Observation;
  address?: Observation;
  text?: Observation;
  signature?: Observation;
  inQuote?: string;
  quoteAuthor?: string;
  check?: string;
}

const SIGNED = 'post.signed_message.';
const SIGNED_CHECKS = new Set(['computed.signed_message_check', 'computed.signature.result']);

function signedGroups(observations: readonly Observation[]): SignedGroup[] {
  const groups = new Map<string, SignedGroup>();
  for (const o of observations) {
    const base = baseProperty(o.property);
    if (!base.startsWith(SIGNED) && !SIGNED_CHECKS.has(base)) continue;
    const key = [
      o.captureId,
      o.subject.type,
      o.subject.key,
      o.locator.split('#')[0],
      factIndex(o.locator, o.property),
    ].join('\u0000');
    const group = groups.get(key) ?? { first: o };
    groups.set(key, group);
    if (base === `${SIGNED}address`) group.address = o;
    else if (base === `${SIGNED}text` || base === `${SIGNED}message`) group.text = o;
    else if (base === `${SIGNED}signature`) group.signature = o;
    else if (base === `${SIGNED}in_quote`) group.inQuote = o.value;
    else if (base === `${SIGNED}quote_author`) group.quoteAuthor = o.value;
    else if (SIGNED_CHECKS.has(base)) group.check = o.value;
  }
  return [...groups.values()];
}

function checkResult(check: string): Bip137Result {
  if (check === 'valid') return 'valid';
  if (check === 'invalid') return 'invalid';
  return 'unsupported_format';
}

/**
 * „I am <handle>”, „user: <handle>”, „jestem <handle>”, „użytkownik <handle>” …: the phrases match case- and
 * accent-tolerantly, the handle is one complete token taken from the NFC text as written (accents kept).
 */
const HANDLE_BINDING =
  /(?:^|[^\p{L}\p{N}_])(?:i\s+am|i['’]m|jestem|username|user|nickname|nick|login|account|konto|u[zż]ytkownik)(?:\s*[:=]\s*|\s+)@?([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/giu;
/** „uid 900001”, „user id: 900001”, „…;u=900001”: a platform id only counts with such context, as a whole number. */
const ID_BINDING =
  /(?:(?:^|[^\p{L}\p{N}_])(?:uid|user[\s_-]?id|userid|user|id)(?:\s*[:=#]\s*|\s+)|[?;&]u=)(\d+)(?!\d)/giu;

/**
 * The signed message binds itself to this account: an explicit phrase names one of the account's handles as a
 * complete token (compared with `accountHandleKey` on both sides: NFC and case only), or its platform id in
 * uid/user/id context. A valid signature proves control of the key by the signer, not by whoever posts it, so a
 * copied message that names someone else binds nobody.
 */
export function namesAccount(text: string, account: AccountInfo): boolean {
  const message = text.normalize('NFC');
  const handles = new Set(account.records.map((r) => accountHandleKey(r.handle)));
  for (const match of message.matchAll(HANDLE_BINDING)) {
    const token = (match[1] ?? '').replace(/[.-]+$/, '');
    if (token && handles.has(accountHandleKey(token))) return true;
  }
  const ids = new Set(account.records.flatMap((r) => (r.platformUserId ? [r.platformUserId.toLowerCase()] : [])));
  for (const match of message.matchAll(ID_BINDING)) if (ids.has(match[1] ?? '')) return true;
  return false;
}

function signedMessageItems(ctx: AddressContext, out: Collector): void {
  for (const g of signedGroups(ctx.observations)) {
    const where = { captureId: g.first.captureId, observationId: (g.address ?? g.first).id };
    if (!g.address) {
      ctx.note({ code: 'signed_message_incomplete', detail: 'signed message without an address', ...where });
      continue;
    }
    let result: Bip137Result;
    if (g.text && g.signature) result = verifyBip137(g.address.value, g.text.value, g.signature.value);
    else if (g.check !== undefined) result = checkResult(g.check);
    else {
      ctx.note({ code: 'signed_message_incomplete', detail: 'signed message without text or signature', ...where });
      continue;
    }
    if (result === 'invalid') {
      ctx.note({
        code: 'signature_invalid',
        detail: 'BIP-137 signature does not verify: no cryptographic binding',
        ...where,
      });
      continue;
    }
    if (result === 'unsupported_format') {
      ctx.note({
        code: 'signature_unsupported_format',
        detail: 'signature is not a BIP-137 message signature (e.g. BIP-322): no cryptographic binding',
        ...where,
      });
      continue;
    }
    const quoted = g.inQuote === 'true';
    const account = quoted ? (g.quoteAuthor ? ctx.index.resolve(g.quoteAuthor) : undefined) : ownerOf(g.address, ctx);
    if (!account || !namesAccount(g.text?.value ?? '', account)) {
      ctx.note({
        code: 'signed_message_unbound',
        detail: 'valid signature, but the message does not name its author account: no cryptographic binding',
        ...where,
      });
      continue;
    }
    const candidate = confirm(g.address.value, g.address.captureId, ctx);
    if (!candidate) {
      unconfirmed(g.address.value, `${SIGNED}address`, ctx, where);
      continue;
    }
    out.add(
      account,
      makeItem(E1, account, candidate, ctx, {
        observation: g.address,
        sourceId: g.address.sourceId,
        detail: `BIP-137 signed message verified (${quoted ? 'quoted' : 'own post'}), names ${account.account.handle}`,
      }),
    );
  }
}

// --- other address-valued facts -------------------------------------------------------------------------------

/** Results of `computed.*_check` facts, by capture + locator base. */
function computedChecks(observations: readonly Observation[]): Map<string, string> {
  const checks = new Map<string, string>();
  for (const o of observations) {
    const base = baseProperty(o.property);
    if (base.startsWith('computed.') && base.endsWith('_check')) {
      checks.set(`${o.captureId}\u0000${o.locator.split('#')[0]}`, o.value);
    }
  }
  return checks;
}

function factRule(base: string, check: string | undefined): Rule | 'tea' | 'invalid' | undefined {
  if (base.startsWith('verification.')) {
    if (check === undefined || check === 'valid') return E1;
    if (check.startsWith('unverifiable')) return E1_NODE_ATTESTED;
    return 'invalid';
  }
  if (base.startsWith('claim.')) {
    if (base.startsWith('claim.tea')) return 'tea';
    return base.includes('drips') ? E1 : E2_PAYMENT;
  }
  if (base.startsWith('ens.')) return E1;
  if (base.startsWith('profile.')) return E2_PROFILE;
  return undefined;
}

function factItems(ctx: AddressContext, out: Collector): void {
  const checks = computedChecks(ctx.observations);
  for (const o of ctx.observations) {
    const base = baseProperty(o.property);
    if (base.startsWith(SIGNED) || !isAddressValuedProperty(base)) continue;
    const where = { captureId: o.captureId, observationId: o.id };
    const rule = factRule(base, checks.get(`${o.captureId}\u0000${o.locator.split('#')[0]}`));
    if (rule === undefined) continue; // post/page mentions come from extraction, with their role cues
    if (rule === 'tea') {
      ctx.note({ code: 'claim_ignored', detail: `${base}: tea.yaml claims are spam-prone and weigh 0`, ...where });
      continue;
    }
    if (rule === 'invalid') {
      ctx.note({ code: 'verification_invalid', detail: `${base}: the source's proof check failed`, ...where });
      continue;
    }
    const account = ownerOf(o, ctx);
    if (!account) {
      ctx.note({ code: 'unattributed_observation', detail: `${base}: no known author account`, ...where });
      continue;
    }
    const candidate = confirm(o.value, o.captureId, ctx);
    if (!candidate) {
      unconfirmed(o.value, base, ctx, where);
      continue;
    }
    out.add(account, makeItem(rule, account, candidate, ctx, { observation: o, sourceId: o.sourceId, detail: base }));
  }

  // An address written inside another self-asserted profile field (bio, signature) is a self-assertion too.
  for (const o of ctx.observations) {
    const base = baseProperty(o.property);
    if (o.subject.type !== 'account' || !base.startsWith('profile.') || isAddressValuedProperty(base)) continue;
    const account = ctx.index.resolve(o.subject.key);
    if (!account) continue;
    for (const candidate of ctx.candidates.get(o.captureId) ?? []) {
      const value = o.value.toLowerCase();
      if (!value.includes(candidate.address.address.toLowerCase()) && !o.value.includes(candidate.raw)) continue;
      if (out.hasProof(account, candidate.address)) continue;
      out.add(
        account,
        makeItem(E2_PROFILE, account, candidate, ctx, {
          observation: o,
          sourceId: o.sourceId,
          detail: `${base} contains the address`,
        }),
      );
    }
  }
}

// --- mentions ---------------------------------------------------------------------------------------------------

function mentionItems(ctx: AddressContext, out: Collector): void {
  const unattributed = new Map<Id, number>();
  const pending: { account: AccountInfo; items: AddressItem[] }[] = [];
  const all = [...ctx.candidates.values()]
    .flat()
    .toSorted((a, b) => compareText(a.captureId, b.captureId) || compareText(a.id, b.id));
  for (const candidate of all) {
    const cue = candidate.context.roleCues[0] ?? 'unclear';
    const rule = CUE_RULES[cue];
    if (rule === 'third_party') {
      const key = addressKey(candidate.address);
      out.thirdParty.set(key, [...(out.thirdParty.get(key) ?? []), candidate]);
      continue;
    }
    const account = ctx.authorship.authorOf(candidate);
    if (!account) {
      unattributed.set(candidate.captureId, (unattributed.get(candidate.captureId) ?? 0) + 1);
      continue;
    }
    const capture = ctx.captures.get(candidate.captureId);
    const host = hostOf(capture);
    const label = candidate.context.label ? ` („${candidate.context.label}”)` : '';
    const items = [
      makeItem(rule, account, candidate, ctx, { detail: `cue ${cue}${label}${host ? ` on ${host}` : ''}` }),
    ];
    const modifier = (feature: string, detail: string): void => {
      items.push(makeItem({ feature, grade: 'A' }, account, candidate, ctx, { detail }));
    };
    if (!candidate.checksum.present && !CORROBORATED.has(candidate.chainAttribution.method)) {
      modifier(
        'unchecksummed_uncorroborated',
        `no checksum and no chain corroboration (${candidate.chainAttribution.method})`,
      );
    }
    if (cue === 'listing' || candidate.context.inCode || DOCS_HOST.test(host)) {
      modifier(
        'listing_code_or_docs',
        candidate.context.inCode ? 'inside a code block' : `listing or documentation (${host})`,
      );
    }
    if (candidate.reviewRequired) {
      modifier('deobfuscated_or_ocr_repaired', `repaired match (${candidate.transforms.join(', ')})`);
    }
    pending.push({ account, items });
  }
  // A proof or profile field of the same account supersedes its mentions of that address.
  for (const { account, items } of pending) {
    const [main] = items;
    if (!main) continue;
    if (out.hasProof(account, main.candidate.address)) out.supersede(account, main);
    else for (const item of items) out.add(account, item);
  }
  for (const [captureId, count] of unattributed) {
    ctx.note({
      code: 'unattributed_mention',
      detail: `${count} address mention(s) without an evidenced author (no ownership claim)`,
      captureId,
    });
  }
}

/** Address-hop evidence per (account, address): proofs and self-assertions first, then mentions. */
export function collectAddressEvidence(ctx: AddressContext): AddressEvidence {
  const out = new Collector();
  signedMessageItems(ctx, out);
  factItems(ctx, out);
  mentionItems(ctx, out);
  return { byAccount: out.byAccount, thirdParty: out.thirdParty };
}
