/**
 * Pure helpers for analyst judgements and overrides: local copies of the core value lists (the console imports only
 * types from `@olcys/core`; a test keeps them equal), justification checks matching the API, the targets an override
 * form offers for one link, and whether a run applied an override.
 */
import type {
  AddEvidenceFeature,
  AddressCandidate,
  AdmiraltyReliability,
  AnalysisRun,
  AnalystJudgement,
  AnalystOverride,
  AnalystOverrideKind,
  AnalystOverrideTarget,
  Capture,
  Hop,
  JudgementValue,
  Observation,
  OnlineAccount,
  ReviewDecision,
} from '@olcys/core';
import type { LinkView } from '../../lib/domain.ts';
import { evidenceRefs } from './score-model.ts';

export const JUDGEMENT_OPTIONS: readonly JudgementValue[] = ['same', 'not_same', 'unsure'];
export const OVERRIDE_KINDS: readonly AnalystOverrideKind[] = ['reliability_grade', 'review_decision', 'add_evidence'];
/** Grades an analyst may set (F means "cannot be judged" and is never set). */
export const SETTABLE_GRADES: readonly AdmiraltyReliability[] = ['A', 'B', 'C', 'D', 'E'];
export const REVIEW_OPTIONS: readonly ReviewDecision[] = ['confirmed', 'rejected'];
/** The hop of each evidence feature an analyst may add (`ADD_EVIDENCE_HOPS` in core). */
export const EVIDENCE_FEATURE_HOPS: Readonly<Record<AddEvidenceFeature, Hop>> = {
  contradicting_attribute: 'identity',
  second_independent_origin: 'address',
  onchain_consistency: 'address',
};
export const EVIDENCE_FEATURES = Object.keys(EVIDENCE_FEATURE_HOPS) as AddEvidenceFeature[];
/** `JUSTIFICATION_LENGTH` in core. */
export const JUSTIFICATION = { min: 10, max: 2000 } as const;

/** The API's error code for a justification (counted after trimming), if any. */
export function justificationError(text: string): 'justification_too_short' | 'justification_too_long' | undefined {
  const length = text.trim().length;
  if (length < JUSTIFICATION.min) return 'justification_too_short';
  if (length > JUSTIFICATION.max) return 'justification_too_long';
  return undefined;
}

/** Oldest first by (`at`, `id`), the API's order: the current judgement is the last one. */
export function sortJudgements(judgements: readonly AnalystJudgement[]): AnalystJudgement[] {
  return judgements.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function currentJudgement(judgements: readonly AnalystJudgement[]): AnalystJudgement | undefined {
  return sortJudgements(judgements).at(-1);
}

export interface AnalystLookups {
  accounts: ReadonlyMap<string, OnlineAccount>;
  captures: ReadonlyMap<string, Capture>;
  observations: ReadonlyMap<string, Observation>;
  candidates: ReadonlyMap<string, AddressCandidate>;
}

/** One element an override may refer to, with what the form needs to label it. */
export type TargetOption =
  | { key: string; kind: 'observation'; target: AnalystOverrideTarget; observation: Observation }
  | { key: string; kind: 'candidate'; target: AnalystOverrideTarget; candidate: AddressCandidate; sourceId?: string }
  | { key: string; kind: 'source'; target: AnalystOverrideTarget; sourceId: string }
  | { key: string; kind: 'account'; target: AnalystOverrideTarget; account: OnlineAccount };

const present = <T>(value: T | undefined): value is T => value !== undefined;

/** What a reliability grade may refer to on this link: its observations, its candidates and their sources. */
export function gradeTargets(link: LinkView, ctx: AnalystLookups): TargetOption[] {
  const refs = evidenceRefs(link);
  const observations = refs.observationIds.map((id) => ctx.observations.get(id)).filter(present);
  const candidates = refs.candidateIds.map((id) => ctx.candidates.get(id)).filter(present);
  const sources = new Set([
    ...observations.map((o) => o.sourceId),
    ...[...refs.captureIds, ...candidates.map((c) => c.captureId)].flatMap((id) => {
      const sourceId = ctx.captures.get(id)?.sourceId;
      return sourceId ? [sourceId] : [];
    }),
  ]);
  return [
    ...observations.map((o): TargetOption => ({
      key: `observation:${o.id}`,
      kind: 'observation',
      target: { observationId: o.id },
      observation: o,
    })),
    ...candidates.map((c): TargetOption => ({
      key: `candidate:${c.id}`,
      kind: 'candidate',
      target: { candidateId: c.id },
      candidate: c,
      sourceId: ctx.captures.get(c.captureId)?.sourceId,
    })),
    ...[...sources]
      .toSorted()
      .map((sourceId): TargetOption => ({ key: `source:${sourceId}`, kind: 'source', target: { sourceId }, sourceId })),
  ];
}

/** Review-required (deobfuscated, gap-joined or OCR-repaired) candidates behind this link. */
export function reviewTargets(link: LinkView, ctx: AnalystLookups): TargetOption[] {
  return gradeTargets(link, ctx).filter((o) => o.kind === 'candidate' && o.candidate.reviewRequired);
}

/** Accounts on the link's paths: analyst evidence goes on one account's identity hop or its path to the address. */
export function accountTargets(link: LinkView, ctx: AnalystLookups): TargetOption[] {
  const ids = [...new Set(link.paths.flatMap((p) => (p.accountId ? [p.accountId] : [])))];
  return ids
    .map((id) => ctx.accounts.get(id))
    .filter(present)
    .map((account) => ({ key: `account:${account.id}`, kind: 'account', target: { accountId: account.id }, account }));
}

/** Body of `POST /api/cases/:caseId/overrides`; address-hop evidence names the link's address too. */
export function overrideRequest(
  link: Pick<LinkView, 'address'>,
  form: { kind: AnalystOverrideKind; target: AnalystOverrideTarget; value: string; justification: string },
): { kind: AnalystOverrideKind; target: AnalystOverrideTarget; value: string; justification: string } {
  const feature = form.value as AddEvidenceFeature;
  const target =
    form.kind === 'add_evidence' && EVIDENCE_FEATURE_HOPS[feature] === 'address'
      ? { ...form.target, address: link.address }
      : form.target;
  return { kind: form.kind, target, value: form.value, justification: form.justification.trim() };
}

/** Only a rescore applies overrides: those recorded until it was queued. */
export function appliedIn(run: Pick<AnalysisRun, 'trigger' | 'queuedAt'>, override: Pick<AnalystOverride, 'at'>) {
  return run.trigger === 'rescore' && Date.parse(override.at) <= Date.parse(run.queuedAt);
}
