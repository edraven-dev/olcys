/**
 * AI-drafted inferences in the report. Only a draft an analyst confirmed (as drafted or edited) enters the report,
 * labelled as AI-assisted with the analyst and the decision time; pending and rejected drafts never do. A draft never
 * touches a score or the summary: it is an inference (class C) like the rule-based ones.
 */
import type { InferenceDraft, LlmSuggestion, ReportInference } from '@olcys/core';
import { INFERENCE_DRAFT_TASK } from '@olcys/core';

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');

/** The stored `output` of a draft, or `undefined` when it does not have the expected shape. */
export function draftOutput(suggestion: Pick<LlmSuggestion, 'output'>): InferenceDraft | undefined {
  const o = suggestion.output;
  if (typeof o !== 'object' || o === null) return undefined;
  const { statement, basedOn, alternatives, verificationSteps } = o as Record<string, unknown>;
  if (typeof statement !== 'string' || !isStrings(basedOn) || !isStrings(alternatives)) return undefined;
  return {
    statement,
    basedOn,
    alternatives,
    verificationSteps: isStrings(verificationSteps) ? verificationSteps : [],
  };
}

/** The drafts that belong in the report: task `report-inference-draft`, confirmed (edited or not), decided. */
export function isReportableDraft(s: LlmSuggestion): boolean {
  return (
    s.task === INFERENCE_DRAFT_TASK &&
    s.status === 'confirmed' &&
    s.decidedBy !== undefined &&
    s.decidedAt !== undefined &&
    draftOutput(s) !== undefined
  );
}

/** Report inferences of the confirmed drafts, oldest decision first. Everything else is ignored. */
export function inferencesFromDrafts(drafts: readonly LlmSuggestion[]): ReportInference[] {
  return drafts
    .filter(isReportableDraft)
    .toSorted((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? '') || a.id.localeCompare(b.id))
    .flatMap((s) => {
      const draft = draftOutput(s);
      if (!draft || !s.decidedBy || !s.decidedAt) return [];
      const edited = s.editedText !== undefined && s.editedText.trim() !== '' && s.editedText !== draft.statement;
      return [
        {
          id: `inference-draft-${s.id}`,
          statement: edited ? (s.editedText ?? draft.statement) : draft.statement,
          basedOn: draft.basedOn,
          alternatives: draft.alternatives,
          verificationSteps: draft.verificationSteps,
          origin: 'ai_suggestion',
          requiresVerification: true,
          ai: {
            review: edited ? 'edited' : 'confirmed',
            analyst: s.decidedBy,
            decidedAt: s.decidedAt,
            model: s.model,
            promptVersion: s.promptVersion,
            ...(edited ? { draftStatement: draft.statement } : {}),
          },
        } satisfies ReportInference,
      ];
    });
}
