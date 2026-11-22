/**
 * Analyst inputs as scoring input. `applyOverrides` turns a case's overrides into `FeatureExtractionInput.analyst`,
 * which `buildClaims` honours; nothing else of the input changes. A rescore run calls it before scoring, so the new
 * assessment is versioned separately and the assessments of earlier runs stay as they were. Pure and deterministic.
 */
import {
  ADD_EVIDENCE_FEATURES,
  ADD_EVIDENCE_HOPS,
  addressKey,
  REVIEW_DECISIONS,
  type AddEvidenceFeature,
  type AddressCandidate,
  type AddressRef,
  type AdmiraltyReliability,
  type AnalystJudgement,
  type AnalystOverride,
  type Hop,
  type Id,
  type ReviewDecision,
} from '@olcys/core';
import { compareText } from './compare.ts';
import { truncate } from './features/normalise.ts';
import type {
  AnalystEvidence,
  AnalystGrade,
  AnalystInputs,
  AnalystReview,
  FeatureExtractionInput,
} from './features/types.ts';

/** Grades an analyst may set; F ("cannot be judged") is what an analyst grading replaces, never a result of it. */
const SETTABLE_GRADES: ReadonlySet<string> = new Set<AdmiraltyReliability>(['A', 'B', 'C', 'D', 'E']);

/**
 * Hop and grade of analyst evidence. The weights' `defaultGrade` takes precedence in `buildClaims`; the grade here
 * covers features without one (`second_independent_origin`: B).
 */
export const ANALYST_EVIDENCE: Readonly<Record<AddEvidenceFeature, { hop: Hop; grade: AdmiraltyReliability }>> = {
  contradicting_attribute: { hop: ADD_EVIDENCE_HOPS.contradicting_attribute, grade: 'B' },
  second_independent_origin: { hop: ADD_EVIDENCE_HOPS.second_independent_origin, grade: 'B' },
  onchain_consistency: { hop: ADD_EVIDENCE_HOPS.onchain_consistency, grade: 'A' },
};

const isEvidenceFeature = (value: string): value is AddEvidenceFeature =>
  (ADD_EVIDENCE_FEATURES as readonly string[]).includes(value);
const isDecision = (value: string): value is ReviewDecision => (REVIEW_DECISIONS as readonly string[]).includes(value);

/** Oldest first by (`at`, `id`): the latest entry is the last one. */
const byTime = <T extends { at: string; id: Id }>(a: T, b: T): number =>
  compareText(a.at, b.at) || compareText(a.id, b.id);

/** The current judgement of a link: the latest by (`at`, `id`). Judgements never change the assessment. */
export function latestJudgement(judgements: readonly AnalystJudgement[]): AnalystJudgement | undefined {
  return judgements.toSorted(byTime).at(-1);
}

/**
 * One active item per (account, address, feature): saving the same evidence again replaces the earlier statement
 * (the latest override wins, the history stays stored) instead of adding its weight a second time.
 */
function latestEvidence(items: readonly AnalystEvidence[]): AnalystEvidence[] {
  const active = new Map<string, AnalystEvidence>();
  for (const item of items) {
    const key = [item.accountId ?? '', item.address ? addressKey(item.address) : '', item.feature].join('\u0000');
    active.delete(key);
    active.set(key, item);
  }
  return [...active.values()];
}

/** Canonical comparison form of an address (EVM addresses are case-insensitive). */
function canonicalRef(ref: AddressRef): AddressRef {
  return ref.chain.startsWith('evm:') ? { chain: ref.chain, address: ref.address.toLowerCase() } : ref;
}

/** Where a candidate was found: re-extracting the same capture yields the same position under a new id. */
const exactKey = (c: AddressCandidate): string =>
  [c.captureId, addressKey(canonicalRef(c.address)), c.view, c.span.start, c.span.end].join('\u0000');
const looseKey = (c: AddressCandidate): string => [c.captureId, addressKey(canonicalRef(c.address))].join('\u0000');

/**
 * Resolves candidate ids named by overrides to the candidates of this input. A rescore re-extracts the saved
 * captures, so a candidate of an earlier run has a new id here: it is found by capture, address, view and span (or,
 * failing that, by capture and address when that is unique). Unknown ids resolve to nothing.
 */
function candidateResolver(
  input: FeatureExtractionInput,
  referenced: readonly AddressCandidate[],
): (id: Id) => Id | undefined {
  const current = input.extractions.flatMap((e) => e.candidates);
  const ids = new Set(current.map((c) => c.id));
  const exact = new Map(current.map((c) => [exactKey(c), c.id]));
  const loose = new Map<string, Id[]>();
  for (const c of current) loose.set(looseKey(c), [...(loose.get(looseKey(c)) ?? []), c.id]);
  const earlier = new Map(referenced.map((c) => [c.id, c]));
  return (id) => {
    if (ids.has(id)) return id;
    const before = earlier.get(id);
    if (!before) return undefined;
    const same = loose.get(looseKey(before)) ?? [];
    return exact.get(exactKey(before)) ?? (same.length === 1 ? same[0] : undefined);
  };
}

/**
 * Fills `input.analyst` from the case's overrides (any order; applied oldest first, so for one target the latest
 * wins — also for analyst evidence: one active item per account, address and feature). Overrides with a value or target their kind does not allow are ignored (the API refuses them):
 * `reliability_grade` needs an A–E grade and one observation, candidate or source; `review_decision` a candidate and
 * `confirmed`/`rejected`; `add_evidence` an allowed feature, an account and — on the address hop — an address.
 * `candidates` are the stored candidates the overrides name (from any run of the case), used to find them again in a
 * re-extraction.
 */
export function applyOverrides(
  input: FeatureExtractionInput,
  overrides: readonly AnalystOverride[],
  options: { candidates?: readonly AddressCandidate[] } = {},
): FeatureExtractionInput {
  const resolve = candidateResolver(input, options.candidates ?? []);
  const grades: AnalystGrade[] = [];
  const reviews: AnalystReview[] = [];
  const evidence: AnalystEvidence[] = [];

  for (const o of overrides.toSorted(byTime)) {
    const { target } = o;
    const base = { overrideId: o.id, analyst: o.analyst };
    if (o.kind === 'reliability_grade') {
      if (!SETTABLE_GRADES.has(o.value)) continue;
      const grade = o.value as AdmiraltyReliability;
      const named = [target.observationId, target.candidateId, target.sourceId].filter((v) => v !== undefined);
      if (named.length !== 1) continue;
      if (target.observationId) grades.push({ observationId: target.observationId, grade, ...base });
      else if (target.sourceId) grades.push({ sourceId: target.sourceId, grade, ...base });
      else if (target.candidateId) {
        const candidateId = resolve(target.candidateId);
        if (candidateId) grades.push({ candidateId, grade, ...base });
      }
    } else if (o.kind === 'review_decision') {
      if (!isDecision(o.value) || !target.candidateId) continue;
      const candidateId = resolve(target.candidateId);
      if (candidateId) reviews.push({ candidateId, decision: o.value, ...base });
    } else if (o.kind === 'add_evidence') {
      if (!isEvidenceFeature(o.value) || !target.accountId) continue;
      const { hop, grade } = ANALYST_EVIDENCE[o.value];
      if (hop === 'address' && !target.address) continue;
      evidence.push({
        hop,
        feature: o.value,
        reliability: grade,
        originGroup: `analyst:${o.id}`,
        evidence: {},
        // The justification stays with the override (an analyst statement); the computed item only names its source.
        detail: truncate(`analyst evidence: override ${o.id} by ${o.analyst}`),
        accountId: target.accountId,
        ...(hop === 'address' && target.address ? { address: canonicalRef(target.address) } : {}),
        overrideId: o.id,
      });
    }
  }

  const previous = input.analyst;
  const analyst: AnalystInputs = {
    grades: [...(previous?.grades ?? []), ...grades],
    reviews: [...(previous?.reviews ?? []), ...reviews],
    evidence: latestEvidence([...(previous?.evidence ?? []), ...evidence]),
    cues: [...(previous?.cues ?? [])],
  };
  return { ...input, analyst };
}

/**
 * Version label of the overrides a rescore run applies, for `RunConfigSnapshot.rulesVersions.overrides`:
 * `overrides@<count>:<id of the latest>` (`overrides@0` when there are none).
 */
export function overridesVersion(overrides: readonly AnalystOverride[]): string {
  const last = overrides.toSorted(byTime).at(-1);
  return last ? `overrides@${overrides.length}:${last.id}` : 'overrides@0';
}

/** The overrides a run queued at `queuedAt` applies: those recorded at or before that time. */
export function overridesAt(overrides: readonly AnalystOverride[], queuedAt: string): AnalystOverride[] {
  const limit = Date.parse(queuedAt);
  return overrides.filter((o) => Date.parse(o.at) <= limit).toSorted(byTime);
}
