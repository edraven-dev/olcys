/**
 * Drafts for section C of a report. The model reads the report's own facts (A) and computed results (B) and proposes
 * hypotheses with alternative explanations and verification steps; every draft cites the ids it relies on. The
 * outcome is a list of suggestions with zero score weight: nothing here touches a score or the summary, and a draft
 * reaches the report only after an analyst confirms it. Items built on Telegram content are removed before the call.
 */
import type {
  Id,
  InferenceDraft,
  LlmClient,
  LlmFailureCode,
  LlmRequest,
  NewLlmSuggestion,
  ReportComputed,
  ReportModel,
  SourceId,
} from '@olcys/core';
import { INFERENCE_DRAFT_TASK } from '@olcys/core';
import { buildLlmRequest } from './prompts/registry.ts';
import { inferenceDraftPromptV1, type InferenceDraftOutput } from './prompts/inference-draft/v1.ts';
import { sanitizeUntrusted } from './untrusted.ts';

/** Longest statement of one context line; the rest is cut so one huge item cannot use up the budget. */
const MAX_LINE_STATEMENT = 400;
const SCORE_RESTATEMENT = /%|\/\s*100|Wskaźnik\s+Pewności/iu;

export interface DraftInput {
  model: ReportModel;
  runId: Id;
  caseId: Id;
  /**
   * The source of a capture when the capture may be shown to a model (`isLlmAllowed`), `undefined` when it must not
   * be (Telegram, a source with `llmAllowed: false`, an unknown source or capture).
   */
  captureSource(captureId: Id): SourceId | undefined;
}

export interface DraftContext {
  /** One line per item: `[F:<id>] <statement>` (fact) or `[W:<id>] <statement>` (computed result). */
  text: string;
  /** The prefixed ids the text contains; a draft may cite only these. */
  ids: string[];
  /** Items left out because they, or an item they are based on, come from a source the model must not see. */
  excluded: number;
  /** Items that did not fit `maxInputChars` (whole lines are cut, never part of one). */
  truncated: number;
  inputs: LlmRequest['inputs'];
}

const oneLine = (text: string): string => sanitizeUntrusted(text).replace(/\s+/g, ' ').trim();
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The capture a computed result carries itself (validation results and rejected candidates keep their capture). */
function ownCapture(item: ReportComputed): Id | undefined {
  const data = item.data;
  if (typeof data === 'object' && data !== null && 'captureId' in data) {
    const id = (data as { captureId?: unknown }).captureId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** Score of a link-score result, for ordering (0 for every other kind). */
function scoreOf(item: ReportComputed): number {
  if (item.kind !== 'score' || typeof item.data !== 'object' || item.data === null) return 0;
  const score = (item.data as { score?: unknown }).score;
  return typeof score === 'number' ? score : 0;
}

/**
 * Builds the model input from the report model only (never from pages): computed results first, ordered by the score
 * of the link they support (descending) then id, then facts by id. Deterministic.
 */
export function buildDraftContext(input: DraftInput): DraftContext {
  const { facts, computed } = input.model;
  const factById = new Map(facts.map((f) => [f.id, f]));
  const computedById = new Map(computed.map((c) => [c.id, c]));
  const verdict = new Map<string, Id[] | null>();

  // The captures an item rests on, or null when any of them (directly or through basedOn) must not be shown.
  const capturesOf = (id: string, path: ReadonlySet<string>): Id[] | null => {
    if (verdict.has(id)) return verdict.get(id) ?? null;
    if (path.has(id)) return [];
    const next = new Set(path).add(id);
    const fact = factById.get(id);
    let result: Id[] | null = [];
    if (fact) {
      result = [fact.captureId];
    } else {
      const item = computedById.get(id);
      if (!item) return [];
      const own = ownCapture(item);
      if (own !== undefined) result = [own];
      // A valuation is a result of its cash-out event; it names no basis of its own.
      const parents = id.endsWith('-valuation') ? [...item.basedOn, id.slice(0, -'-valuation'.length)] : item.basedOn;
      for (const parent of parents) {
        const inherited = capturesOf(parent, next);
        if (inherited === null) {
          result = null;
          break;
        }
        result.push(...inherited);
      }
    }
    if (result !== null && !result.every((c) => input.captureSource(c) !== undefined)) result = null;
    verdict.set(id, result);
    return result;
  };

  const ordered = [
    ...computed
      .toSorted((a, b) => scoreOf(b) - scoreOf(a) || cmp(a.id, b.id))
      .map((c) => ({ prefix: 'W', id: c.id, statement: c.statement })),
    ...facts.toSorted((a, b) => cmp(a.id, b.id)).map((f) => ({ prefix: 'F', id: f.id, statement: f.statement })),
  ];
  const max = inferenceDraftPromptV1.maxInputChars;
  const lines: string[] = [];
  const ids: string[] = [];
  const used = new Set<string>();
  const inputs: LlmRequest['inputs'] = [];
  let excluded = 0;
  let truncated = 0;
  let length = 0;
  for (const item of ordered) {
    const captures = capturesOf(item.id, new Set());
    if (captures === null) {
      excluded += 1;
      continue;
    }
    const statement = oneLine(item.statement).slice(0, MAX_LINE_STATEMENT);
    const line = `[${item.prefix}:${item.id}] ${statement}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (length + cost > max) {
      truncated += 1;
      continue;
    }
    length += cost;
    lines.push(line);
    ids.push(`${item.prefix}:${item.id}`);
    for (const captureId of captures) {
      const source = input.captureSource(captureId);
      if (source === undefined || used.has(captureId)) continue;
      used.add(captureId);
      inputs.push({ captureId, sourceId: source, llmAllowed: true });
    }
  }
  return { text: lines.join('\n'), ids, excluded, truncated, inputs };
}

export type DraftSuggestion = Omit<NewLlmSuggestion, 'id' | 'createdAt'>;

export type DraftOutcome =
  | {
      status: 'drafted';
      suggestions: DraftSuggestion[];
      dropped: { unknownBasis: number; restatesScore: number };
      excluded: number;
    }
  | { status: 'skipped'; reason: 'llm_disabled' | 'nothing_to_draft' }
  | { status: 'failed'; reason: LlmFailureCode; callId?: Id };

const rawId = (cited: string): string => cited.replace(/^[FW]:/u, '');

/** True when any text of the draft restates a score, a probability or a percentage (the summary owns that wording). */
const restatesScore = (draft: InferenceDraftOutput['drafts'][number]): boolean =>
  [draft.statement, ...draft.alternatives, ...draft.verificationSteps].some((text) => SCORE_RESTATEMENT.test(text));

export async function draftInferences(input: DraftInput, deps: { llm: LlmClient }): Promise<DraftOutcome> {
  if (!deps.llm.enabled) return { status: 'skipped', reason: 'llm_disabled' };
  const context = buildDraftContext(input);
  if (context.ids.length === 0) return { status: 'skipped', reason: 'nothing_to_draft' };
  const request = buildLlmRequest(inferenceDraftPromptV1, {
    untrustedInput: context.text,
    inputs: context.inputs,
    containsIdentifier: true,
    runId: input.runId,
    caseId: input.caseId,
  });
  const result = await deps.llm.complete<InferenceDraftOutput>(request);
  if (!result.ok) return { status: 'failed', reason: result.code, callId: result.callId };
  const known = new Set(context.ids);
  const dropped = { unknownBasis: 0, restatesScore: 0 };
  const suggestions: DraftSuggestion[] = [];
  for (const draft of result.output.drafts) {
    if (!draft.basedOn.every((id) => known.has(id))) {
      dropped.unknownBasis += 1;
      continue;
    }
    if (restatesScore(draft)) {
      dropped.restatesScore += 1;
      continue;
    }
    const output: InferenceDraft = {
      statement: draft.statement.trim(),
      basedOn: [...new Set(draft.basedOn.map(rawId))],
      alternatives: draft.alternatives.map((a) => a.trim()),
      verificationSteps: draft.verificationSteps.map((s) => s.trim()),
    };
    suggestions.push({
      runId: input.runId,
      task: INFERENCE_DRAFT_TASK,
      target: { reportId: input.model.reportId },
      label: 'draft',
      output,
      model: result.model,
      ...(result.modelDigest ? { modelDigest: result.modelDigest } : {}),
      promptVersion: inferenceDraftPromptV1.version,
      callId: result.callId,
    });
  }
  return { status: 'drafted', suggestions, dropped, excluded: context.excluded };
}
