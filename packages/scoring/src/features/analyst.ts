/**
 * How `buildClaims` honours analyst inputs (`FeatureExtractionInput.analyst`, filled by `applyOverrides` in rescore
 * runs). Collected items keep their arithmetic; an analyst grade replaces the item's grade, a rejected candidate is
 * left out, a confirmed one loses its review flag, and every change is named in the item's detail.
 */
import {
  addressKey,
  type AddressCandidate,
  type Capture,
  type EvidenceFeature,
  type Id,
  type Observation,
  type SourceId,
} from '@olcys/core';
import { truncate } from './normalise.ts';
import type { AnalystCue, AnalystEvidence, AnalystGrade, AnalystInputs, AnalystReview, FeatureNote } from './types.ts';

export interface AnalystContext {
  /** The candidate as the analyst decided: `undefined` when rejected, without the review flag when confirmed. */
  candidate(candidate: AddressCandidate): AddressCandidate | undefined;
  /** A collected item with the analyst's grade and decisions applied; `source` is used when no capture names one. */
  item(feature: EvidenceFeature, source?: SourceId): EvidenceFeature;
  /** Evidence items added by the analyst. */
  evidence: readonly AnalystEvidence[];
}

const NONE: AnalystContext = { candidate: (c) => c, item: (f) => f, evidence: [] };

/** The latest entry per key (entries are oldest first, so later ones replace earlier ones). */
function latestBy<T>(entries: readonly T[], key: (entry: T) => string | undefined): Map<string, T> {
  const out = new Map<string, T>();
  for (const entry of entries) {
    const k = key(entry);
    if (k !== undefined) out.set(k, entry);
  }
  return out;
}

export function analystContext(
  inputs: AnalystInputs | undefined,
  lookups: { observations: ReadonlyMap<Id, Observation>; captures: ReadonlyMap<Id, Capture> },
  note: (note: FeatureNote) => void,
): AnalystContext {
  if (!inputs) return NONE;
  const byObservation = latestBy<AnalystGrade>(inputs.grades, (g) => g.observationId);
  const byCandidate = latestBy<AnalystGrade>(inputs.grades, (g) => g.candidateId);
  const bySource = latestBy<AnalystGrade>(inputs.grades, (g) => g.sourceId);
  const reviews = latestBy<AnalystReview>(inputs.reviews, (r) => r.candidateId);
  const cues = latestBy<AnalystCue>(inputs.cues, (c) => c.candidateId);
  const confirmed = new Map<Id, AnalystReview>();

  const sourceOf = (f: EvidenceFeature, fallback: SourceId | undefined): SourceId | undefined => {
    const { observationId, captureId } = f.evidence;
    if (observationId) return lookups.observations.get(observationId)?.sourceId ?? fallback;
    if (captureId) return lookups.captures.get(captureId)?.sourceId ?? fallback;
    return fallback;
  };

  return {
    candidate(c) {
      const review = reviews.get(c.id);
      if (review?.decision === 'rejected') {
        note({
          code: 'analyst_rejected_candidate',
          detail: truncate(
            `${addressKey(c.address)} rejected by analyst ${review.analyst} (override ${review.overrideId}): not scored`,
          ),
          captureId: c.captureId,
        });
        return undefined;
      }
      let out = c;
      if (review?.decision === 'confirmed' && c.reviewRequired) {
        confirmed.set(c.id, review);
        out = { ...out, reviewRequired: false };
      }
      const cue = cues.get(c.id);
      if (cue) {
        out = {
          ...out,
          context: { ...out.context, roleCues: [cue.cue, ...out.context.roleCues.filter((r) => r !== cue.cue)] },
        };
      }
      return out;
    },

    item(f, source) {
      // The most specific grade wins: observation, then candidate, then source.
      const { observationId, candidateId } = f.evidence;
      const sourceId = sourceOf(f, source);
      const grade =
        (observationId ? byObservation.get(observationId) : undefined) ??
        (candidateId ? byCandidate.get(candidateId) : undefined) ??
        (sourceId ? bySource.get(sourceId) : undefined);
      const review = candidateId ? confirmed.get(candidateId) : undefined;
      const cue = candidateId ? cues.get(candidateId) : undefined;
      const notes = [
        grade ? `grade set by analyst: ${grade.analyst}` : '',
        review ? `review confirmed by analyst: ${review.analyst}` : '',
        cue ? `analyst-confirmed suggestion ${cue.suggestionId}` : '',
      ].filter((n) => n !== '');
      if (notes.length === 0) return f;
      // The analyst's part is never cut off: the collected detail gives way.
      const suffix = notes.join('; ');
      const detail = f.detail ? `${truncate(f.detail, Math.max(40, 198 - suffix.length))}; ${suffix}` : suffix;
      return { ...f, ...(grade ? { reliability: grade.grade } : {}), detail: truncate(detail) };
    },

    evidence: inputs.evidence,
  };
}
