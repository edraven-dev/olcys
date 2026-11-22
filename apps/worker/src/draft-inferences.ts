/**
 * On-demand drafting of section C inferences (`POST /api/runs/:runId/report/drafts`). One bounded model call reads the
 * run's published report model (facts and computed results, never pages) and returns at most a handful of drafts,
 * stored as pending suggestions with zero score weight. A missing, failing or slow model is a typed result, never an
 * error: the report, the run and every score stay as they are. Telegram-derived items never reach the model.
 */
import type {
  BlobStore,
  Capture,
  DraftInferencesResult,
  LlmClient,
  Logger,
  Repositories,
  RunWithProgress,
  SourceDescriptor,
} from '@olcys/core';
import { INFERENCE_DRAFT_TASK, newId, nowIso } from '@olcys/core';
import { draftInferences, isLlmAllowed } from '@olcys/llm';
import { buildReportModel, findPublishedReport, type ReportData } from '@olcys/reporting';

export interface DraftInferencesDeps {
  repos: Repositories;
  blobs: BlobStore;
  sources: readonly SourceDescriptor[];
  llm: LlmClient;
  logger?: Logger;
}

// One drafting call per run at a time: a second click while the model works must not queue a second batch.
const active = new Set<string>();

export function createDraftInferencer(
  deps: DraftInferencesDeps,
): (run: RunWithProgress) => Promise<DraftInferencesResult> {
  const sourceById = new Map(deps.sources.map((s) => [s.id, s]));
  return async (run) => {
    const store = deps.repos.llm;
    if (!store || !deps.llm.enabled) return { status: 'failed', reason: 'disabled' };
    if (active.has(run.id)) return { status: 'skipped', reason: 'busy' };
    active.add(run.id);
    try {
      const published = await findPublishedReport(deps, run.id);
      if (!published || published.legacy) return { status: 'skipped', reason: 'no_report' };
      const data = JSON.parse(new TextDecoder().decode(await deps.blobs.get(published.set.dataSha256))) as ReportData;
      const existing = await store.listSuggestionsByRun(run.id);
      if (existing.some((s) => s.task === INFERENCE_DRAFT_TASK && s.status === 'pending')) {
        return { status: 'skipped', reason: 'pending_drafts' };
      }
      const captures = new Map<string, Capture>(data.captures.map((c) => [c.id, c]));
      const outcome = await draftInferences(
        {
          model: buildReportModel(data),
          runId: run.id,
          caseId: run.caseId,
          captureSource(captureId) {
            const capture = captures.get(captureId);
            const source = capture ? sourceById.get(capture.sourceId) : undefined;
            return capture && isLlmAllowed(capture, source) ? capture.sourceId : undefined;
          },
        },
        { llm: deps.llm },
      );
      if (outcome.status === 'skipped') {
        return outcome.reason === 'nothing_to_draft'
          ? { status: 'skipped', reason: 'nothing_to_draft' }
          : { status: 'failed', reason: 'disabled' };
      }
      if (outcome.status === 'failed') {
        deps.logger?.warn('inference drafts not created', { runId: run.id, reason: outcome.reason });
        return { status: 'failed', reason: outcome.reason };
      }
      if (outcome.suggestions.length) {
        await store.addSuggestions(outcome.suggestions.map((s) => ({ ...s, id: newId(), createdAt: nowIso() })));
      }
      // Counts only: no scraped text goes to the log.
      deps.logger?.info('inference drafts created', {
        runId: run.id,
        created: outcome.suggestions.length,
        excluded: outcome.excluded,
        ...outcome.dropped,
      });
      return { status: 'drafted', created: outcome.suggestions.length, dropped: outcome.dropped };
    } finally {
      active.delete(run.id);
    }
  };
}
