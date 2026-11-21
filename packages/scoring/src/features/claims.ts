import {
  addressKey,
  type AddressCandidate,
  type AdmiraltyReliability,
  type Clock,
  type EvidenceTier,
  type Id,
  type Identifier,
  type LinkAssessment,
  type Relation,
} from '@olcys/core';
import { compareText } from '../compare.ts';
import { scoreLink, type ClaimInput, type PathInput } from '../link.ts';
import { RELATION_RULES_VERSION } from '../version.ts';
import type { ScoringWeights } from '../weights.ts';
import { buildAccountIndex, observationsByAccount, type AccountInfo } from './accounts.ts';
import { collectAddressEvidence, type AccountAddressEvidence } from './address.ts';
import { buildAuthorship } from './authorship.ts';
import { identityItems } from './identity.ts';
import type { FeatureExtractionInput, FeatureNote } from './types.ts';

/** Ownership relations by precedence: a deposit cue wins (never a holding), then self-declared, payment, mention. */
const PRECEDENCE: readonly Relation[] = ['CUSTODIAL_EXCHANGE', 'SELF_DECLARED', 'PAYMENT_ENDPOINT', 'MENTION_UNCLEAR'];
const TIER_ORDER: readonly EvidenceTier[] = ['E1', 'E2', 'E3', 'E4', 'AUTH'];

/** The case subject: the first anchor identifier by (addedAt, id), else the first identifier. */
function subjectOf(identifiers: readonly Identifier[]): Identifier | undefined {
  const sorted = identifiers.toSorted((a, b) => compareText(a.addedAt, b.addedAt) || compareText(a.id, b.id));
  return sorted.find((i) => i.isAnchor) ?? sorted[0];
}

const strongest = (candidates: readonly AddressCandidate[]): AddressCandidate | undefined =>
  candidates.toSorted(
    (a, b) =>
      Number(b.checksum.present) - Number(a.checksum.present) ||
      b.checksum.bits - a.checksum.bits ||
      compareText(a.id, b.id),
  )[0];

function noteKey(n: FeatureNote): string {
  return [n.code, n.captureId ?? '', n.observationId ?? '', n.detail].join('\u0000');
}

function sortedNotes(notes: readonly FeatureNote[]): FeatureNote[] {
  const unique = new Map(notes.map((n) => [noteKey(n), n]));
  return [...unique.entries()].toSorted(([a], [b]) => compareText(a, b)).map(([, n]) => n);
}

/**
 * Turns what a run collected into scorable claims: which accounts are paths to the subject (anchors, and accounts
 * with positive identity evidence), which features each hop gets, and the relation and tier of each (subject,
 * address) claim. Third-party warnings become separate THIRD_PARTY_ATTRIBUTION claims without paths.
 * Deterministic: the same input gives deep-equal output, sorted by (address key, relation).
 */
export function buildClaims(
  i: FeatureExtractionInput,
  w: ScoringWeights,
): { claims: ClaimInput[]; notes: FeatureNote[] } {
  const notes: FeatureNote[] = [];
  const note = (n: FeatureNote): void => {
    notes.push(n);
  };
  const subject = subjectOf(i.identifiers);
  if (!subject) {
    note({ code: 'no_subject', detail: 'the case has no identifiers' });
    return { claims: [], notes: sortedNotes(notes) };
  }

  const captures = new Map(i.captures.map((c) => [c.id, c]));
  const grade = (g: AdmiraltyReliability, sourceId: string | undefined): AdmiraltyReliability =>
    sourceId !== undefined && i.sources(sourceId)?.reliability === 'F' ? 'F' : g;
  const index = buildAccountIndex(i.accounts, i.identifiers);
  const byAccount = observationsByAccount(index, i.observations);
  const authorship = buildAuthorship(i.captures, i.observations, index);

  const candidates = new Map<Id, AddressCandidate[]>();
  for (const extraction of i.extractions) {
    const valid = extraction.candidates.filter((c) => c.checksum.valid);
    candidates.set(extraction.captureId, [...(candidates.get(extraction.captureId) ?? []), ...valid]);
  }
  const evidence = collectAddressEvidence({
    index,
    authorship,
    captures,
    candidates,
    observations: i.observations,
    grade,
    note,
  });

  // Paths: anchors, plus accounts with at least one positive identity item (third parties keep the 1:9 prior only).
  const identity = new Map<string, PathInput['identity']>();
  for (const info of index.list) {
    if (info.anchor) continue;
    identity.set(
      info.key,
      identityItems(info, {
        identifiers: i.identifiers,
        index,
        observationsByAccount: byAccount,
        captures,
        weights: w,
        grade,
        note,
      }),
    );
  }
  const hasPath = (info: AccountInfo): boolean =>
    info.anchor || (identity.get(info.key) ?? []).some((f) => (w.features.get(f.feature)?.bayesFactor ?? 0) > 1);

  const byAddress = new Map<string, AccountAddressEvidence[]>();
  for (const entry of [...evidence.byAccount.values()].toSorted((a, b) => compareText(a.account.key, b.account.key))) {
    if (!hasPath(entry.account)) {
      note({
        code: 'no_identity_path',
        detail: `${addressKey(entry.address)} is published by ${entry.account.key}, which has no evidenced link to the subject`,
      });
      continue;
    }
    const key = addressKey(entry.address);
    byAddress.set(key, [...(byAddress.get(key) ?? []), entry]);
  }

  const exclusionsFor = (key: string) => i.exclusions.filter((d) => addressKey(d.address) === key);
  const base = {
    runId: i.runId,
    identityId: subject.id,
    ...(i.llmSuggestionsExcluded ? { llmSuggestionsExcluded: i.llmSuggestionsExcluded } : {}),
    rulesVersion: RELATION_RULES_VERSION,
  };
  const claims: ClaimInput[] = [];

  for (const [key, entries] of byAddress) {
    const items = entries.flatMap((e) => e.items);
    const relations = new Set(items.flatMap((item) => (item.relation ? [item.relation] : [])));
    const reclassified = exclusionsFor(key).find((d) => d.outcome === 'reclassified' && d.relation);
    const relation = reclassified?.relation ?? PRECEDENCE.find((r) => relations.has(r)) ?? 'MENTION_UNCLEAR';
    const tiers = new Set(items.flatMap((item) => (item.tier ? [item.tier] : [])));
    const candidate = strongest(items.map((item) => item.candidate));
    if (!candidate) continue;
    claims.push({
      ...base,
      address: candidate.address,
      relation,
      tier: TIER_ORDER.find((t) => tiers.has(t)) ?? 'E3',
      checksum: candidate.checksum,
      paths: entries.map((e) => ({
        accountId: e.account.account.id,
        anchor: e.account.anchor,
        identity: e.account.anchor ? [] : (identity.get(e.account.key) ?? []),
        address: e.items.map((item) => item.feature),
        service: e.account.account.platform.toLowerCase(),
        originGroup: e.account.originGroup,
      })),
      exclusions: exclusionsFor(key),
      reviewRequired: items.every((item) => item.candidate.reviewRequired),
    });
  }

  for (const [key, list] of evidence.thirdParty) {
    const candidate = strongest(list);
    if (!candidate) continue;
    claims.push({
      ...base,
      address: candidate.address,
      relation: 'THIRD_PARTY_ATTRIBUTION',
      tier: 'E4',
      checksum: candidate.checksum,
      paths: [],
      exclusions: exclusionsFor(key),
      reviewRequired: list.every((c) => c.reviewRequired),
    });
  }

  claims.sort(
    (a, b) => compareText(addressKey(a.address), addressKey(b.address)) || compareText(a.relation, b.relation),
  );
  return { claims, notes: sortedNotes(notes) };
}

/** Builds the claims of a run and scores each one with the two-hop engine. */
export function scoreRun(
  i: FeatureExtractionInput,
  w: ScoringWeights,
  deps: { clock: Clock; newId: () => Id },
): { assessments: LinkAssessment[]; notes: FeatureNote[] } {
  const { claims, notes } = buildClaims(i, w);
  const assessments: LinkAssessment[] = [];
  const extra: FeatureNote[] = [];
  for (const claim of claims) {
    const result = scoreLink(claim, w, deps);
    if (result.ok) assessments.push(result.assessment);
    else
      extra.push({
        code: 'claim_not_scored',
        detail: `${addressKey(claim.address)} ${claim.relation}: ${result.reason}`,
      });
  }
  return { assessments, notes: sortedNotes([...notes, ...extra]) };
}
