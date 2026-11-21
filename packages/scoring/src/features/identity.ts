import {
  isAddressValuedProperty,
  type AdmiraltyReliability,
  type Capture,
  type EvidenceFeature,
  type Id,
  type Identifier,
  type Observation,
  type OnlineAccount,
} from '@olcys/core';
import type { ScoringWeights } from '../weights.ts';
import type { AccountIndex, AccountInfo } from './accounts.ts';
import {
  baseProperty,
  nameTokens,
  normaliseEmail,
  normaliseHandle,
  normaliseUrl,
  sameName,
  truncate,
} from './normalise.ts';
import type { FeatureNote } from './types.ts';

export interface IdentityContext {
  identifiers: readonly Identifier[];
  index: AccountIndex;
  observationsByAccount: ReadonlyMap<string, Observation[]>;
  captures: ReadonlyMap<Id, Capture>;
  weights: ScoringWeights;
  grade(grade: AdmiraltyReliability, sourceId: string | undefined): AdmiraltyReliability;
  note(note: FeatureNote): void;
}

const HANDLE_KINDS = new Set(['nickname', 'social_login', 'messenger_id']);
const NAME_PROPERTIES = new Set([
  'profile.name',
  'profile.display_name',
  'profile.full_name',
  'profile.real_name',
  'profile.seller_name',
]);
const LINK_PROPERTIES = new Set(['account.link', 'profile.link']);
/** Last property segment that holds an e-mail (`profile.email`, `profile.public_email`, `post.contact_email`). */
const EMAIL_SEGMENT = /(?:^|_)e_?mail$/;

function hamming64(a: string, b: string): number | undefined {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return undefined;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x > 0n) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

/**
 * Identity-hop items of a non-anchor account: exact username or name, profile link to an anchor, verified cross-proof,
 * commit or contact e-mail equal to an input e-mail, near-identical avatar. Origin group = the account.
 */
export function identityItems(info: AccountInfo, ctx: IdentityContext): EvidenceFeature[] {
  const items: EvidenceFeature[] = [];
  const handles = new Set(ctx.identifiers.filter((i) => HANDLE_KINDS.has(i.kind)).map((i) => normaliseHandle(i.value)));
  const fullNames = ctx.identifiers.filter((i) => i.kind === 'full_name').map((i) => i.value);
  const emails = new Set(ctx.identifiers.filter((i) => i.kind === 'email').map((i) => normaliseEmail(i.value)));
  const anchors = ctx.index.list.filter((a) => a.anchor && a !== info);

  const add = (
    feature: string,
    detail: string,
    source: { observation?: Observation; record?: OnlineAccount },
  ): void => {
    const weight = ctx.weights.features.get(feature);
    if (!weight) {
      ctx.note({ code: 'feature_not_in_weights', detail: `${feature} is not in ${ctx.weights.version}` });
      return;
    }
    const o = source.observation;
    const discovery = (source.record ?? info.account).discoveredVia;
    const captureId = o?.captureId ?? discovery.captureId;
    items.push({
      hop: 'identity',
      feature,
      reliability: ctx.grade(weight.defaultGrade ?? 'C', o?.sourceId ?? discovery.sourceId),
      originGroup: info.originGroup,
      evidence: { ...(captureId ? { captureId } : {}), ...(o ? { observationId: o.id } : {}) },
      detail: truncate(detail),
    });
  };

  // Every discovery of the account counts: a name or handle seen only in a duplicate discovery is not lost.
  const seen = new Set<string>();
  for (const record of info.records) {
    const handle = normaliseHandle(record.handle);
    if (handles.has(handle) && !seen.has(`h:${handle}`)) {
      seen.add(`h:${handle}`);
      add('exact_username_or_name', `handle ${record.handle} equals an input identifier`, { record });
    }
    const displayName = record.displayName;
    const nameKey = `n:${displayName ? nameTokens(displayName).join(' ') : ''}`;
    if (displayName && !seen.has(nameKey) && fullNames.some((n) => sameName(n, displayName))) {
      seen.add(nameKey);
      add('exact_username_or_name', 'display name equals the input full name', { record });
    }
  }

  const anchorUrls = new Map(
    anchors.flatMap((a) =>
      a.records.flatMap((r) => {
        const url = normaliseUrl(r.profileUrl);
        return url ? [[url, a] as const] : [];
      }),
    ),
  );
  const anchorPhashes = anchors.flatMap((a) =>
    (ctx.observationsByAccount.get(a.key) ?? []).filter((o) => baseProperty(o.property) === 'profile.avatar_phash'),
  );
  const checks = new Map<string, string>();
  for (const o of ctx.observationsByAccount.get(info.key) ?? []) {
    const base = baseProperty(o.property);
    if (base.startsWith('computed.') && base.endsWith('_check')) checks.set(o.locator.split('#')[0] ?? '', o.value);
  }

  for (const o of ctx.observationsByAccount.get(info.key) ?? []) {
    const base = baseProperty(o.property);
    const capture = ctx.captures.get(o.captureId);
    if (NAME_PROPERTIES.has(base)) {
      if (fullNames.some((n) => sameName(n, o.value)))
        add('exact_username_or_name', `${base} equals the input full name`, { observation: o });
      else if (handles.has(normaliseHandle(o.value)))
        add('exact_username_or_name', `${base} equals an input identifier`, { observation: o });
    } else if (LINK_PROPERTIES.has(base) || (base.startsWith('verification.') && !isAddressValuedProperty(base))) {
      const url = normaliseUrl(o.value, capture?.finalUrl || capture?.url);
      const anchor =
        (url ? anchorUrls.get(url) : undefined) ??
        [ctx.index.resolve(o.value)].find((a) => a !== undefined && a.anchor && a !== info) ??
        anchors.find(
          (a) =>
            base.startsWith('verification.') &&
            a.records.some((r) => normaliseHandle(o.value) === normaliseHandle(r.handle)),
        );
      if (!anchor) continue;
      if (base.startsWith('verification.')) {
        const check = checks.get(o.locator.split('#')[0] ?? '');
        if (check !== undefined && check !== 'valid') {
          ctx.note({
            code: 'verification_invalid',
            detail: `${base}: proof check ${check}`,
            captureId: o.captureId,
            observationId: o.id,
          });
          continue;
        }
        add('verified_cross_proof', `${base} proves the anchor account ${anchor.key}`, { observation: o });
      } else {
        add('profile_link_to_anchor', `${base} links to the anchor account ${anchor.key}`, { observation: o });
      }
    } else if (base === 'account.commit_email') {
      if (emails.has(normaliseEmail(o.value)))
        add('commit_email_match', 'commit author e-mail equals an input e-mail', { observation: o });
    } else if (
      EMAIL_SEGMENT.test(base.split('.').at(-1) ?? '') &&
      !base.startsWith('computed.') &&
      !base.startsWith('registry.')
    ) {
      if (emails.has(normaliseEmail(o.value)))
        add('contact_email_match', `${base} equals an input e-mail`, { observation: o });
    } else if (base === 'profile.avatar_phash') {
      const near = anchorPhashes.some((a) => (hamming64(o.value, a.value) ?? 64) <= 6);
      if (near)
        add('same_avatar_phash', 'avatar perceptual hash within 6/64 bits of an anchor avatar', { observation: o });
    }
  }
  return items;
}
